package httptransport

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/leonardoventurini/typeferry/typeferry-go/ejson"
	"github.com/leonardoventurini/typeferry/typeferry-go/protocol"
	"github.com/leonardoventurini/typeferry/typeferry-go/runtime"
)

func TestHTTPDuplicateOriginRejected(t *testing.T) {
	server := runtime.NewServer()
	_ = server.AddMethod("ping", func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) {
		return ejson.Bool(true), nil
	}, runtime.MethodOptions{})

	app := New(server, Options{Origins: []string{"https://allowed.test"}, DisableRateLimit: true})
	req := httptest.NewRequest(http.MethodPost, protocol.HTTPPath, strings.NewReader(`{"payload":{"method":"ping"}}`))
	req.Header["Origin"] = []string{"https://allowed.test", "https://evil.test"}
	resp := httptest.NewRecorder()
	app.ServeHTTP(resp, req)
	if resp.Code != http.StatusForbidden {
		t.Fatalf("duplicate Origin status = %d, want 403", resp.Code)
	}
}

func TestHTTPMultipleCookieHeadersJoinedAndClientIDValidatedAndErrorFlushesHeaders(t *testing.T) {
	server := runtime.NewServer()
	var seenCookie, seenID string
	_ = server.AddMethod("inspectFail", func(_ context.Context, client *runtime.Client, _ ejson.Value) (ejson.Value, error) {
		seenCookie = client.Header("cookie")
		seenID = client.ID()
		client.AddResponseHeader("Set-Cookie", "sid=new; HttpOnly")
		return ejson.Null(), runtime.PublicError("boom")
	}, runtime.MethodOptions{})

	app := New(server, Options{DisableRateLimit: true})
	req := httptest.NewRequest(http.MethodPost, protocol.HTTPPath, strings.NewReader(`{"payload":{"method":"inspectFail"}}`))
	req.Header["Cookie"] = []string{"a=1", "b=2"}
	req.Header.Set("X-Client-Id", "bad/id!@#")
	resp := httptest.NewRecorder()
	app.ServeHTTP(resp, req)

	if seenCookie != "a=1; b=2" {
		t.Fatalf("joined Cookie = %q, want %q", seenCookie, "a=1; b=2")
	}
	if !regexp.MustCompile(`^[a-zA-Z0-9-]{1,64}$`).MatchString(seenID) || seenID == "bad/id!@#" {
		t.Fatalf("invalid X-Client-Id leaked: %q", seenID)
	}
	if resp.Header().Get("Set-Cookie") != "sid=new; HttpOnly" {
		t.Fatalf("Set-Cookie dropped on error response: %q", resp.Header().Get("Set-Cookie"))
	}
}

func TestHTTPLimiterEvictsExpiredEntries(t *testing.T) {
	limit := &limiter{
		entries: map[string][]time.Time{
			"old-1": {time.Now().Add(-5 * time.Second)},
			"old-2": {time.Now().Add(-5 * time.Second)},
		},
		max:    2,
		window: time.Second,
	}
	allowed, _, _ := limit.consume("fresh")
	if !allowed {
		t.Fatal("fresh key blocked")
	}
	if _, exists := limit.entries["old-1"]; exists {
		t.Fatal("expired limiter entry old-1 was not evicted")
	}
}

func TestHTTPContextAllowlistHeadersTimeoutAndChunkedLimit(t *testing.T) {
	server := runtime.NewServer()
	server.SetAllowedContextKeys([]string{"locale"})
	var seenRole, seenLocale, seenToken, seenCustomHeader string
	if err := server.SetAuth(func(_ context.Context, client *runtime.Client, value ejson.Value) (ejson.Value, error) {
		role, _ := value.Lookup("role")
		seenRole, _ = role.Text()
		locale, _ := value.Lookup("locale")
		seenLocale, _ = locale.Text()
		tok, _ := value.Lookup("token")
		seenToken, _ = tok.Text()
		seenCustomHeader = client.Header("x-custom")
		return value, nil
	}, func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) {
		return ejson.Null(), nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := server.AddMethod("ok", func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) {
		return ejson.Bool(true), nil
	}, runtime.MethodOptions{}); err != nil {
		t.Fatal(err)
	}

	app := New(server, Options{DisableRateLimit: true})
	req := httptest.NewRequest(http.MethodPost, protocol.HTTPPath, strings.NewReader(`{"context":{"role":"admin","locale":"en","token":"spoof"},"payload":{"method":"ok"}}`))
	req.Header.Set("X-Api-Key", "Bearer real-tok")
	req.Header["X-Custom"] = []string{"one", "two"}
	resp := httptest.NewRecorder()
	app.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK || seenRole != "" || seenLocale != "en" || seenToken != "real-tok" {
		t.Fatalf("context leakage or token mismatch: role=%q locale=%q token=%q", seenRole, seenLocale, seenToken)
	}
	if seenCustomHeader != "one, two" {
		t.Fatalf("multi-value header = %q, want %q", seenCustomHeader, "one, two")
	}

	slowServer := runtime.NewServer()
	_ = slowServer.SetAuth(func(ctx context.Context, _ *runtime.Client, _ ejson.Value) (ejson.Value, error) {
		<-time.After(500 * time.Millisecond)
		return ejson.Object(), nil
	}, func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) {
		return ejson.Null(), nil
	})
	_ = slowServer.AddMethod("ok", func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) {
		return ejson.Bool(true), nil
	}, runtime.MethodOptions{})
	timedApp := New(slowServer, Options{DisableRateLimit: true, AuthTimeout: 40 * time.Millisecond})
	timeoutResp := httptest.NewRecorder()
	start := time.Now()
	timedApp.ServeHTTP(timeoutResp, httptest.NewRequest(http.MethodPost, protocol.HTTPPath, strings.NewReader(`{"payload":{"method":"ok"}}`)))
	if time.Since(start) > 300*time.Millisecond || !strings.Contains(timeoutResp.Body.String(), protocol.ErrorInternal) {
		t.Fatalf("auth timeout did not return Internal Error quickly: dur=%s body=%s", time.Since(start), timeoutResp.Body.String())
	}

	chunkHost := httptest.NewServer(New(server, Options{DisableRateLimit: true, MaxBodyBytes: 64}))
	defer chunkHost.Close()
	chunkReq, err := http.NewRequest(http.MethodPost, chunkHost.URL+protocol.HTTPPath, struct{ *strings.Reader }{strings.NewReader(strings.Repeat("a", 128))})
	if err != nil {
		t.Fatal(err)
	}
	chunkReq.ContentLength = -1 // forces chunked transfer encoding
	chunkResp, err := chunkHost.Client().Do(chunkReq)
	if err != nil {
		t.Fatal(err)
	}
	_ = chunkResp.Body.Close()
	if chunkResp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("chunked oversized status = %d, want 413", chunkResp.StatusCode)
	}
}

func TestHTTPProductionOriginWarning(t *testing.T) {
	t.Setenv("NODE_ENV", "production")
	var logs bytes.Buffer
	prevOut := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(prevOut)

	_ = New(runtime.NewServer(), Options{})
	if !strings.Contains(logs.String(), "without an origins allowlist") {
		t.Fatalf("expected HTTP omitted-origins warning, got %q", logs.String())
	}
}
