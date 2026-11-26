package httptransport

import (
	"context"
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
