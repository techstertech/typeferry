package websocket

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/coder/websocket"
	"github.com/leonardoventurini/typeferry/typeferry-go/ejson"
	"github.com/leonardoventurini/typeferry/typeferry-go/runtime"
)

func TestWebSocketOriginPolicyDistinguishesOmittedAndEmptyAllowlists(t *testing.T) {
	for _, example := range []struct {
		name            string
		origins         []string
		origin          string
		allowOriginless bool
		allowed         bool
		presentEmpty    bool
	}{
		{"omitted missing", nil, "", false, true, false},
		{"omitted named", nil, "https://other.test", false, true, false},
		{"empty missing", []string{}, "", false, false, false},
		{"empty named", []string{}, "https://other.test", false, false, false},
		{"empty string is not originless opt-in", []string{""}, "", false, false, false},
		{"listed origin", []string{"https://allowed.test"}, "https://allowed.test", false, true, false},
		{"missing origin", []string{"https://allowed.test"}, "", false, false, false},
		{"originless opt-in", []string{}, "", true, true, false},
		{"opt-in never admits named mismatch", []string{}, "https://other.test", true, false, false},
		{"present empty is not absent", []string{"https://allowed.test"}, "", true, false, true},
		{"listed empty does not admit empty header", []string{""}, "", true, false, true},
		{"omitted allowlist admits empty header", nil, "", false, true, true},
	} {
		t.Run(example.name, func(t *testing.T) {
			var authCalls atomic.Int64
			handler := New(runtime.NewServer(), Options{Origins: example.origins, AllowOriginless: example.allowOriginless,
				Authenticate: func(context.Context, *runtime.Client, Handshake) (ejson.Value, error) {
					authCalls.Add(1)
					return ejson.Object(), nil
				}})
			host := httptest.NewServer(handler)
			defer host.Close()
			defer handler.Close()

			url := "ws" + strings.TrimPrefix(host.URL, "http") + "/typeferry-ws"
			headers := http.Header{}
			if example.origin != "" || example.presentEmpty {
				headers.Set("Origin", example.origin)
			}
			connection, response, err := websocket.Dial(context.Background(), url, &websocket.DialOptions{HTTPHeader: headers})
			if !example.allowed {
				if err == nil {
					connection.CloseNow()
					t.Fatal("denied origin was upgraded")
				}
				if response == nil || response.StatusCode != http.StatusForbidden || authCalls.Load() != 0 {
					t.Fatalf("denied handshake: response=%v, auth=%d, error=%v", response, authCalls.Load(), err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer connection.CloseNow()
			if _, _, err := connection.Read(context.Background()); err != nil {
				t.Fatal(err)
			}
			if authCalls.Load() != 1 {
				t.Fatalf("accepted handshake invoked auth %d times", authCalls.Load())
			}
		})
	}
}
