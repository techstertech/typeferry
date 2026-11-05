package httptransport

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/leonardoventurini/typeferry/typeferry-go/ejson"
	"github.com/leonardoventurini/typeferry/typeferry-go/protocol"
	"github.com/leonardoventurini/typeferry/typeferry-go/runtime"
)

func TestOriginPolicyDistinguishesOmittedAndEmptyAllowlists(t *testing.T) {
	for _, example := range []struct {
		name            string
		origins         []string
		origin          string
		allowOriginless bool
		allowed         bool
	}{
		{"omitted missing", nil, "", false, true},
		{"omitted named", nil, "https://other.test", false, true},
		{"empty missing", []string{}, "", false, false},
		{"empty named", []string{}, "https://other.test", false, false},
		{"empty string is not originless opt-in", []string{""}, "", false, false},
		{"listed origin", []string{"https://allowed.test"}, "https://allowed.test", false, true},
		{"missing origin", []string{"https://allowed.test"}, "", false, false},
		{"originless opt-in", []string{}, "", true, true},
		{"opt-in never admits named mismatch", []string{}, "https://other.test", true, false},
	} {
		t.Run(example.name, func(t *testing.T) {
			server := runtime.NewServer()
			authCalls, handlerCalls := 0, 0
			if err := server.SetAuth(func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) {
				authCalls++
				return ejson.Object(), nil
			}, func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) { return ejson.Null(), nil }); err != nil {
				t.Fatal(err)
			}
			if err := server.AddMethod("ping", func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) {
				handlerCalls++
				return ejson.Bool(true), nil
			}, runtime.MethodOptions{}); err != nil {
				t.Fatal(err)
			}

			app := New(server, Options{Origins: example.origins, AllowOriginless: example.allowOriginless, RateLimitMax: 1})
			request := httptest.NewRequest(http.MethodPost, protocol.HTTPPath, strings.NewReader(`{"payload":{"method":"ping"}}`))
			request.Header.Set("Origin", example.origin)
			response := httptest.NewRecorder()
			app.ServeHTTP(response, request)
			if example.allowed {
				if response.Code != http.StatusOK || authCalls != 1 || handlerCalls != 1 {
					t.Fatalf("allowed request: status=%d, auth=%d, handler=%d", response.Code, authCalls, handlerCalls)
				}
			} else if response.Code != http.StatusForbidden || authCalls != 0 || handlerCalls != 0 || len(app.limit.entries) != 0 {
				t.Fatalf("denied request admitted work: status=%d, auth=%d, handler=%d, limiter=%v", response.Code, authCalls, handlerCalls, app.limit.entries)
			}
		})
	}
}

func TestRateHeadersCoverAdmittedResponses(t *testing.T) {
	for _, example := range []struct{ name, body, wantBody string }{
		{"success", `{"payload":{"method":"ping"}}`, `{"type":"result","method":"ping","result":true}`},
		{"successful void", `{"payload":{"method":"ping","void":true}}`, `{"type":"result","method":"ping","result":true}`},
		{"missing method", `{"payload":{"method":"missing"}}`, `{"type":"error","message":"Method Not Found","method":"missing"}`},
		{"suppressed void error", `{"payload":{"method":"missing","void":true}}`, ""},
		{"invalid envelope", `{}`, `{"type":"error","message":"Invalid Request"}`},
	} {
		t.Run(example.name, func(t *testing.T) {
			server := runtime.NewServer()
			if err := server.AddMethod("ping", func(_ context.Context, client *runtime.Client, _ ejson.Value) (ejson.Value, error) {
				client.AddResponseHeader("Set-Cookie", "session=one")
				return ejson.Bool(true), nil
			}, runtime.MethodOptions{}); err != nil {
				t.Fatal(err)
			}
			app := New(server, Options{RateLimitMax: 1, RateLimitWindow: 1500 * time.Millisecond})

			for index, status := range []int{http.StatusOK, http.StatusTooManyRequests} {
				response := httptest.NewRecorder()
				app.ServeHTTP(response, httptest.NewRequest(http.MethodPost, protocol.HTTPPath, strings.NewReader(example.body)))
				if response.Code != status || response.Header().Get("RateLimit-Limit") != "1" || response.Header().Get("RateLimit-Remaining") != "0" || response.Header().Get("RateLimit-Reset") != "2" {
					t.Fatalf("request %d: status=%d, headers=%v", index+1, response.Code, response.Header())
				}
				if index == 0 && response.Body.String() != example.wantBody {
					t.Fatalf("body = %q, want %q", response.Body.String(), example.wantBody)
				}
				if index == 0 && strings.Contains(example.body, `"ping"`) && response.Header().Get("Set-Cookie") != "session=one" {
					t.Fatal("successful response lost its cookie")
				}
			}
		})
	}
}

func TestDisabledLimiterOmitsQuotaHeaders(t *testing.T) {
	app := New(runtime.NewServer(), Options{DisableRateLimit: true})
	response := httptest.NewRecorder()
	app.ServeHTTP(response, httptest.NewRequest(http.MethodPost, protocol.HTTPPath, strings.NewReader(`{}`)))
	for _, name := range []string{"RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"} {
		if response.Header().Get(name) != "" {
			t.Errorf("disabled limiter emitted %s", name)
		}
	}
}

func TestLimiterResetFollowsOldestRequest(t *testing.T) {
	limit := &limiter{entries: map[string][]time.Time{"client": {time.Now().Add(-1500 * time.Millisecond)}}, max: 3, window: 2500 * time.Millisecond}
	allowed, remaining, reset := limit.consume("client")
	if !allowed || remaining != 1 || reset > time.Second || reset <= 500*time.Millisecond {
		t.Fatalf("consume = %t, %d, %s; want reset to the current window", allowed, remaining, reset)
	}
}

func TestHTTPAuthenticationUsesJavaScriptTruthiness(t *testing.T) {
	for _, identity := range []ejson.Value{ejson.Int(0), ejson.String(""), ejson.Object(), ejson.Array()} {
		name, _ := ejson.NewCodec().Stringify(identity, false)
		t.Run(name, func(t *testing.T) {
			server := runtime.NewServer()
			if err := server.SetAuth(func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) { return identity, nil },
				func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) { return ejson.Null(), nil }); err != nil {
				t.Fatal(err)
			}
			called := false
			if err := server.AddMethod("private", func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) {
				called = true
				return ejson.Bool(true), nil
			}, runtime.MethodOptions{Protected: true}); err != nil {
				t.Fatal(err)
			}
			response := httptest.NewRecorder()
			New(server, Options{DisableRateLimit: true}).ServeHTTP(response, httptest.NewRequest(http.MethodPost, protocol.HTTPPath, strings.NewReader(`{"payload":{"method":"private"}}`)))
			want := identity.Kind() == ejson.KindObject || identity.Kind() == ejson.KindArray
			if called != want || strings.Contains(response.Body.String(), protocol.ErrorMethodForbidden) == want {
				t.Fatalf("called=%t, response=%s; want authenticated=%t", called, response.Body.String(), want)
			}
		})
	}
}
