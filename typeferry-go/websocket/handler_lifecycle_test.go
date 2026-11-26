package websocket

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/leonardoventurini/typeferry/typeferry-go/ejson"
	"github.com/leonardoventurini/typeferry/typeferry-go/runtime"
)

const lifecycleTimeout = 2 * time.Second

type lifecycleHost struct {
	methods *runtime.Server
	handler *Handler
	http    *httptest.Server
}

func newLifecycleHost(t *testing.T, options Options) *lifecycleHost {
	t.Helper()
	methods := runtime.NewServer()
	handler := New(methods, options)
	host := &lifecycleHost{methods: methods, handler: handler, http: httptest.NewServer(handler)}

	t.Cleanup(func() {
		if err := handler.Close(); err != nil {
			t.Error(err)
		}
		host.http.Close()
		if err := methods.Close(); err != nil {
			t.Error(err)
		}
	})
	return host
}

func (host *lifecycleHost) dial(t *testing.T) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), lifecycleTimeout)
	defer cancel()
	connection, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(host.http.URL, "http")+"/typeferry-ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.CloseNow() })
	return connection
}

func lifecycleRead(t *testing.T, connection *websocket.Conn) map[string]json.RawMessage {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), lifecycleTimeout)
	defer cancel()
	kind, payload, err := connection.Read(ctx)
	var frame map[string]json.RawMessage
	if err != nil || kind != websocket.MessageText || json.Unmarshal(payload, &frame) != nil {
		t.Fatalf("lifecycle frame = %s %v", payload, err)
	}
	return frame
}

func lifecycleSend(t *testing.T, connection *websocket.Conn, kind, id, method string) {
	t.Helper()
	payload, err := json.Marshal(map[string]string{"t": kind, "id": id, "method": method})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), lifecycleTimeout)
	defer cancel()
	if err := connection.Write(ctx, websocket.MessageText, payload); err != nil {
		t.Fatal(err)
	}
}

func lifecycleSignal(t *testing.T, signal <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(lifecycleTimeout):
		t.Fatal(message)
	}
}

// Cleanup releases callbacks even on a failing assertion, so a red lifecycle
// test cannot strand the test host or an in-flight application goroutine.
func lifecycleRelease(t *testing.T) (<-chan struct{}, func()) {
	t.Helper()
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	return release, unblock
}

func TestRPCDoesNotBlockFollowingCallsOrVoid(t *testing.T) {
	for _, kind := range []string{"rpc", "rpc:void"} {
		t.Run(kind, func(t *testing.T) {
			host := newLifecycleHost(t, Options{AllowOriginless: true})
			release, unblock := lifecycleRelease(t)
			entered := make(chan struct{})
			if err := host.methods.AddMethod("held", func(ctx context.Context, _ *runtime.Client, _ ejson.Value) (ejson.Value, error) {
				close(entered)
				select {
				case <-release:
				case <-ctx.Done():
				}
				return ejson.String("released"), nil
			}, runtime.MethodOptions{}); err != nil {
				t.Fatal(err)
			}
			if err := host.methods.AddMethod("release", func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) {
				unblock()
				return ejson.Bool(true), nil
			}, runtime.MethodOptions{}); err != nil {
				t.Fatal(err)
			}
			connection := host.dial(t)
			lifecycleRead(t, connection)
			lifecycleSend(t, connection, kind, "held", "held")
			lifecycleSignal(t, entered, "held RPC did not start")
			lifecycleSend(t, connection, "ping", "", "")
			if frame := lifecycleRead(t, connection); string(frame["t"]) != `"pong"` {
				t.Fatalf("pending RPC blocked heartbeat: %v", frame)
			}
			lifecycleSend(t, connection, "rpc", "release", "release")
			responses := 1
			if kind == "rpc" {
				responses = 2
			}
			results := make(map[string]string)
			for range responses {
				frame := lifecycleRead(t, connection)
				var id string
				if err := json.Unmarshal(frame["id"], &id); err != nil {
					t.Fatal(err)
				}
				results[id] = string(frame["result"])
			}
			if results["release"] != "true" || (kind == "rpc" && results["held"] != `"released"`) {
				t.Fatalf("concurrent RPC results = %v", results)
			}
		})
	}
}

func TestHandlerCloseCancelsAndJoinsActiveCallsForEveryCloser(t *testing.T) {
	host := newLifecycleHost(t, Options{AllowOriginless: true})
	release, unblock := lifecycleRelease(t)
	abort, _ := lifecycleRelease(t)
	entered, cancelled := make(chan struct{}, 2), make(chan struct{}, 2)
	if err := host.methods.AddMethod("held", func(ctx context.Context, _ *runtime.Client, _ ejson.Value) (ejson.Value, error) {
		entered <- struct{}{}
		select {
		case <-ctx.Done():
		case <-abort:
		}
		cancelled <- struct{}{}
		<-release
		return ejson.Null(), nil
	}, runtime.MethodOptions{}); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		connection := host.dial(t)
		lifecycleRead(t, connection)
		lifecycleSend(t, connection, "rpc", "held", "held")
		lifecycleSignal(t, entered, "RPC did not enter")
	}
	closed := make(chan error, 2)
	for range 2 {
		go func() { closed <- host.handler.Close() }()
	}
	for range 2 {
		lifecycleSignal(t, cancelled, "handler close did not cancel every active RPC")
	}
	select {
	case err := <-closed:
		t.Fatalf("handler close returned before callback cleanup: %v", err)
	default:
	}
	unblock()
	for range 2 {
		select {
		case err := <-closed:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(lifecycleTimeout):
			t.Fatal("handler close did not join callback cleanup")
		}
	}
	if clients := host.methods.ClientSnapshot(); len(clients) != 0 {
		t.Fatalf("clients survived joined close: %d", len(clients))
	}
}

func TestPeerDisconnectCancelsActiveRPC(t *testing.T) {
	host := newLifecycleHost(t, Options{AllowOriginless: true})
	abort, _ := lifecycleRelease(t)
	entered, cancelled := make(chan struct{}), make(chan struct{})
	if err := host.methods.AddMethod("held", func(ctx context.Context, _ *runtime.Client, _ ejson.Value) (ejson.Value, error) {
		close(entered)
		select {
		case <-ctx.Done():
		case <-abort:
		}
		close(cancelled)
		return ejson.Null(), nil
	}, runtime.MethodOptions{}); err != nil {
		t.Fatal(err)
	}
	connection := host.dial(t)
	lifecycleRead(t, connection)
	lifecycleSend(t, connection, "rpc", "held", "held")
	lifecycleSignal(t, entered, "RPC did not enter")
	_ = connection.CloseNow()
	lifecycleSignal(t, cancelled, "disconnect did not cancel active RPC")
	if err := host.handler.Close(); err != nil {
		t.Fatal(err)
	}
	if len(host.methods.ClientSnapshot()) != 0 {
		t.Fatal("disconnected client survived joined retirement")
	}
}

func TestHandlerRetirementCancelsAndJoinsHandshakeCallback(t *testing.T) {
	for _, peerDisconnect := range []bool{false, true} {
		t.Run(fmt.Sprintf("peer-disconnect=%t", peerDisconnect), func(t *testing.T) {
			entered, cancelled := make(chan struct{}), make(chan struct{})
			var release, abort <-chan struct{}
			host := newLifecycleHost(t, Options{AllowOriginless: true, Authenticate: func(ctx context.Context, _ *runtime.Client, _ Handshake) (ejson.Value, error) {
				close(entered)
				select {
				case <-ctx.Done():
				case <-abort:
				}
				close(cancelled)
				<-release
				return ejson.Object(ejson.Field{Key: "user", Value: ejson.String("late")}), nil
			}})
			release, unblock := lifecycleRelease(t)
			abort, _ = lifecycleRelease(t)
			connection := host.dial(t)
			lifecycleSignal(t, entered, "handshake did not enter")
			if peerDisconnect {
				_ = connection.CloseNow()
				lifecycleSignal(t, cancelled, "peer disconnect did not cancel handshake")
			}
			closed := make(chan error, 1)
			go func() { closed <- host.handler.Close() }()
			if !peerDisconnect {
				lifecycleSignal(t, cancelled, "close did not cancel handshake")
			}
			select {
			case err := <-closed:
				t.Fatalf("close returned before handshake cleanup: %v", err)
			default:
			}
			unblock()
			select {
			case err := <-closed:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(lifecycleTimeout):
				t.Fatal("close did not join handshake")
			}
			if len(host.methods.ClientSnapshot()) != 0 {
				t.Fatal("late handshake restored a closed client")
			}
		})
	}
}

// Hold the actual hijack after transport admission to force Close through the
// window before an upgraded socket can be entered in the connection registry.
type heldHijack struct {
	http.ResponseWriter
	entered chan<- struct{}
	release <-chan struct{}
}

func (response *heldHijack) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	response.entered <- struct{}{}
	<-response.release
	return response.ResponseWriter.(http.Hijacker).Hijack()
}

func TestHandlerCloseJoinsAnAdmittedUpgrade(t *testing.T) {
	methods := runtime.NewServer()
	handler := New(methods, Options{AllowOriginless: true})
	entered := make(chan struct{}, 1)
	var release <-chan struct{}
	var held atomic.Bool
	host := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if held.CompareAndSwap(false, true) {
			response = &heldHijack{ResponseWriter: response, entered: entered, release: release}
		}
		handler.ServeHTTP(response, request)
	}))
	t.Cleanup(func() { _ = handler.Close(); host.Close(); _ = methods.Close() })
	release, unblock := lifecycleRelease(t)
	connection, err := net.DialTimeout("tcp", strings.TrimPrefix(host.URL, "http://"), lifecycleTimeout)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	if _, err := fmt.Fprintf(connection, "GET /typeferry-ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	lifecycleSignal(t, entered, "upgrade did not reach hijack")
	closed := make(chan error, 1)
	go func() { closed <- handler.Close() }()
	// A public 503 proves shutdown has stopped admission before checking the
	// held upgrade's join. No scheduler sleep or private registry assertion.
	deadline := time.Now().Add(lifecycleTimeout)
	for {
		response, err := host.Client().Get(host.URL + "/typeferry-ws")
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode == http.StatusServiceUnavailable {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("shutdown did not stop upgrade admission")
		}
	}
	select {
	case err := <-closed:
		t.Fatalf("close returned before admitted upgrade retired: %v", err)
	default:
	}
	unblock()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(lifecycleTimeout):
		t.Fatal("close did not join released upgrade")
	}
	if len(methods.ClientSnapshot()) != 0 {
		t.Fatal("late upgrade admitted a client during shutdown")
	}
}

func TestConcurrentRPCPanicRetainsInternalErrorAndVoidSilence(t *testing.T) {
	for _, kind := range []string{"rpc", "rpc:void"} {
		t.Run(kind, func(t *testing.T) {
			host := newLifecycleHost(t, Options{AllowOriginless: true})
			var invocations atomic.Int32
			if err := host.methods.AddMethod("panic", func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) {
				invocations.Add(1)
				panic("private callback failure")
			}, runtime.MethodOptions{Cache: true}); err != nil {
				t.Fatal(err)
			}
			if err := host.methods.AddMethod("healthy", func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) {
				return ejson.Int(7), nil
			}, runtime.MethodOptions{}); err != nil {
				t.Fatal(err)
			}
			connection := host.dial(t)
			lifecycleRead(t, connection)
			lifecycleSend(t, connection, kind, "failed", "panic")
			lifecycleSend(t, connection, kind, "cached-failed", "panic")
			lifecycleSend(t, connection, "rpc", "healthy", "healthy")
			count := 1
			if kind == "rpc" {
				count = 3
			}
			seen := make(map[string]bool)
			for range count {
				frame := lifecycleRead(t, connection)
				id := string(frame["id"])
				if seen[id] {
					t.Fatalf("duplicate response: %s", id)
				}
				seen[id] = true
				switch id {
				case `"healthy"`:
					if string(frame["result"]) != "7" {
						t.Fatalf("healthy response = %v", frame)
					}
				case `"failed"`, `"cached-failed"`:
					if kind == "rpc:void" || string(frame["error"]) != `"Internal Error"` {
						t.Fatalf("panic response = %v", frame)
					}
				default:
					t.Fatalf("unexpected response after panic = %v", frame)
				}
			}
			if err := host.handler.Close(); err != nil {
				t.Fatal(err)
			}
			if invocations.Load() < 1 || invocations.Load() > 2 {
				t.Fatalf("unexpected panic invocation count: %d", invocations.Load())
			}
		})
	}
}

func TestHandshakePanicFailsClosedAndRetires(t *testing.T) {
	host := newLifecycleHost(t, Options{AllowOriginless: true, Authenticate: func(context.Context, *runtime.Client, Handshake) (ejson.Value, error) {
		panic("private authentication failure")
	}})
	connection := host.dial(t)
	if frame := lifecycleRead(t, connection); string(frame["authenticated"]) != "false" {
		t.Fatalf("panic authentication = %v", frame)
	}
	_ = connection.CloseNow()
	if err := host.handler.Close(); err != nil {
		t.Fatal(err)
	}
	if len(host.methods.ClientSnapshot()) != 0 {
		t.Fatal("panicked handshake retained a client")
	}
}
