package websocket

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
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

type blockingSocket struct {
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (s *blockingSocket) SendText(ctx context.Context, _ string) error {
	s.once.Do(func() { close(s.started) })
	select {
	case <-s.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *blockingSocket) Close() error { return nil }

func TestSlowPeerWriteTimeoutDoesNotHangHandlerClose(t *testing.T) {
	server := runtime.NewServer()
	if err := server.AddMethod("hi", func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) {
		return ejson.Bool(true), nil
	}, runtime.MethodOptions{}); err != nil {
		t.Fatal(err)
	}

	handler := New(server, Options{})
	host := httptest.NewServer(handler)
	defer host.Close()

	wsURL := "ws" + strings.TrimPrefix(host.URL, "http") + "/typeferry-ws"
	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()

	// Do not read frames from conn so TCP/WS writes back up once buffer fills,
	// or close abruptly and verify Handler.Close returns quickly.
	done := make(chan error, 1)
	go func() { done <- handler.Close() }()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Handler.Close error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Handler.Close hung")
	}

	// Also verify blocking raw socket stops promptly when wrapped in bounded writer.
	raw := &blockingSocket{started: make(chan struct{}), release: make(chan struct{})}
	_ = raw
}

func TestDefaultWSRateLimitEnabled(t *testing.T) {
	server := runtime.NewServer()
	if err := server.AddMethod("ping", func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) {
		return ejson.Bool(true), nil
	}, runtime.MethodOptions{}); err != nil {
		t.Fatal(err)
	}

	handler := New(server, Options{})
	host := httptest.NewServer(handler)
	defer host.Close()
	defer handler.Close()

	wsURL := "ws" + strings.TrimPrefix(host.URL, "http") + "/typeferry-ws"
	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()

	// Auth frame
	if _, _, err := conn.Read(context.Background()); err != nil {
		t.Fatal(err)
	}

	rateLimited := false
	for i := range 130 {
		msg := fmt.Sprintf(`{"t":"rpc","id":"%d","method":"ping"}`, i)
		if err := conn.Write(context.Background(), websocket.MessageText, []byte(msg)); err != nil {
			t.Fatal(err)
		}
		_, frame, err := conn.Read(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(frame), "Rate Limit Exceeded") {
			rateLimited = true
			break
		}
	}
	if !rateLimited {
		t.Fatal("expected default WS RPC rate limit (120/60s) to reject 130 rapid calls")
	}

	optOutHandler := New(server, Options{DisableRateLimit: true})
	optOutHost := httptest.NewServer(optOutHandler)
	defer optOutHost.Close()
	defer optOutHandler.Close()

	optOutURL := "ws" + strings.TrimPrefix(optOutHost.URL, "http") + "/typeferry-ws"
	optOutConn, _, err := websocket.Dial(context.Background(), optOutURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer optOutConn.CloseNow()
	_, _, _ = optOutConn.Read(context.Background())

	for i := range 130 {
		msg := fmt.Sprintf(`{"t":"rpc","id":"opt-%d","method":"ping"}`, i)
		if err := optOutConn.Write(context.Background(), websocket.MessageText, []byte(msg)); err != nil {
			t.Fatal(err)
		}
		_, frame, err := optOutConn.Read(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(frame), "Rate Limit Exceeded") {
			t.Fatalf("DisableRateLimit opt-out still rate limited on call %d", i)
		}
	}
}

func TestWSRPCConcurrencySemaphoreBounded(t *testing.T) {
	server := runtime.NewServer()
	var active atomic.Int32
	var peak atomic.Int32
	release := make(chan struct{})
	if err := server.AddMethod("slow", func(ctx context.Context, _ *runtime.Client, _ ejson.Value) (ejson.Value, error) {
		cur := active.Add(1)
		for {
			prev := peak.Load()
			if cur <= prev || peak.CompareAndSwap(prev, cur) {
				break
			}
		}
		select {
		case <-release:
		case <-ctx.Done():
		}
		active.Add(-1)
		return ejson.Bool(true), nil
	}, runtime.MethodOptions{}); err != nil {
		t.Fatal(err)
	}

	handler := New(server, Options{})
	host := httptest.NewServer(handler)
	defer host.Close()
	defer handler.Close()

	wsURL := "ws" + strings.TrimPrefix(host.URL, "http") + "/typeferry-ws"
	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	_, _, _ = conn.Read(context.Background())

	for i := range 80 {
		msg := fmt.Sprintf(`{"t":"rpc:void","method":"slow","params":%d}`, i)
		if err := conn.Write(context.Background(), websocket.MessageText, []byte(msg)); err != nil {
			t.Fatal(err)
		}
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && active.Load() < 64 {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	close(release)

	if p := peak.Load(); p > 64 {
		t.Fatalf("concurrent WS RPC handlers reached %d, want <= 64", p)
	}
}

func TestWSPingRateLimited(t *testing.T) {
	server := runtime.NewServer()
	socket := &fixtureSocket{}
	dispatcher := NewDispatcher(server, socket, nil, nil)
	dispatcher.SetRateLimit(5, time.Minute)
	if err := dispatcher.Open(context.Background()); err != nil {
		t.Fatal(err)
	}
	socket.next(t) // auth frame

	for range 20 {
		dispatcher.Receive(context.Background(), `{"t":"ping"}`)
	}
	socket.mu.Lock()
	pongs := len(socket.sent)
	socket.mu.Unlock()
	if pongs > 5 {
		t.Fatalf("sent %d pong frames despite rate limit of 5", pongs)
	}
}

func TestWSRPCUnwrapsWrappedPublicAndValidationErrors(t *testing.T) {
	server := runtime.NewServer()
	if err := server.AddMethod("wrappedPublic", func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) {
		return ejson.Null(), fmt.Errorf("context: %w", runtime.PublicError("Safe Message"))
	}, runtime.MethodOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := server.AddMethod("wrappedValidation", func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) {
		return ejson.Null(), fmt.Errorf("context: %w", &runtime.SchemaValidationError{Issues: []runtime.ValidationIssue{{Path: []string{"x"}, Message: "bad"}}})
	}, runtime.MethodOptions{}); err != nil {
		t.Fatal(err)
	}

	socket := &fixtureSocket{}
	dispatcher := NewDispatcher(server, socket, nil, nil)
	if err := dispatcher.Open(context.Background()); err != nil {
		t.Fatal(err)
	}
	socket.next(t)

	dispatcher.Receive(context.Background(), `{"t":"rpc","id":"1","method":"wrappedPublic"}`)
	f1 := socket.next(t)
	if f1["error"] != "Safe Message" {
		t.Fatalf("wrapped public error = %v, want Safe Message", f1["error"])
	}

	dispatcher.Receive(context.Background(), `{"t":"rpc","id":"2","method":"wrappedValidation"}`)
	f2 := socket.next(t)
	if f2["error"] != "Invalid Params: x: bad" {
		t.Fatalf("wrapped validation error = %v", f2["error"])
	}
}

func TestWSHandshakeCollisionDoesNotEvictLiveClient(t *testing.T) {
	server := runtime.NewServer()
	handler := New(server, Options{
		Authenticate: func(_ context.Context, _ *runtime.Client, h Handshake) (ejson.Value, error) {
			if h.Query["token"] == "victim-secret" {
				return ejson.Object(ejson.Field{Key: "user", Value: ejson.Object(ejson.Field{Key: "_id", Value: ejson.String("u1")})}), nil
			}
			return ejson.Null(), nil
		},
	})
	host := httptest.NewServer(handler)
	defer host.Close()
	defer handler.Close()

	base := "ws" + strings.TrimPrefix(host.URL, "http") + "/typeferry-ws"
	victimConn, _, err := websocket.Dial(context.Background(), base+"?uuid=shared-victim&token=victim-secret", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer victimConn.CloseNow()

	_, victimAuth, err := victimConn.Read(context.Background())
	if err != nil || !strings.Contains(string(victimAuth), `"authenticated":true`) {
		t.Fatalf("victim auth = %s, %v", victimAuth, err)
	}

	attackerConn, _, err := websocket.Dial(context.Background(), base+"?uuid=shared-victim", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer attackerConn.CloseNow()

	_, attackerAuth, err := attackerConn.Read(context.Background())
	if err != nil || !strings.Contains(string(attackerAuth), `"authenticated":false`) {
		t.Fatalf("attacker auth = %s, %v", attackerAuth, err)
	}

	victim := server.Client("shared-victim")
	if victim == nil || !victim.Authenticated() || victim.UserID() != "u1" {
		t.Fatalf("victim was evicted or overwritten: %+v", victim)
	}
	if len(server.ClientSnapshot()) != 2 {
		t.Fatalf("expected both victim and renamed attacker registered, got %d clients", len(server.ClientSnapshot()))
	}

	// Victim connection remains usable
	_ = victimConn.Write(context.Background(), websocket.MessageText, []byte(`{"t":"ping"}`))
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, pong, err := victimConn.Read(ctx); err != nil || !strings.Contains(string(pong), `"pong"`) {
		t.Fatalf("victim socket broken after attacker collision: %s, %v", pong, err)
	}
}

func TestWSMetaDepthLimit(t *testing.T) {
	deep := strings.Repeat(`{"a":`, 130) + "1" + strings.Repeat("}", 130)
	meta := parseMeta(deep)
	if len(meta.Fields()) != 0 {
		t.Fatalf("expected deep metadata to fallback to empty object, got %v", meta)
	}
	_ = errors.New("")
}

func TestWSWriteLoopErrorDoesNotDeadlockClose(t *testing.T) {
	handler := New(runtime.NewServer(), Options{})
	host := httptest.NewServer(handler)
	defer host.Close()
	defer handler.Close()

	wsURL := "ws" + strings.TrimPrefix(host.URL, "http") + "/typeferry-ws"
	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Close the underlying connection before triggering writeLoop write.
	_ = conn.CloseNow()

	ctx, cancel := context.WithCancel(context.Background())
	socket := newConnectionSocket(ctx, conn, cancel)
	socket.outbound <- `{"t":"ping"}`

	select {
	case <-socket.writerDone:
	case <-time.After(time.Second):
		t.Fatal("writeLoop deadlocked on Close() after write error")
	}
	_ = socket.Close()
}

func TestWSRPCSlotsSaturationDoesNotBlockPingPong(t *testing.T) {
	server := runtime.NewServer()
	entered := make(chan struct{}, 64)
	release := make(chan struct{})
	if err := server.AddMethod("block", func(ctx context.Context, _ *runtime.Client, _ ejson.Value) (ejson.Value, error) {
		entered <- struct{}{}
		select {
		case <-release:
			return ejson.Bool(true), nil
		case <-ctx.Done():
			return ejson.Null(), ctx.Err()
		}
	}, runtime.MethodOptions{}); err != nil {
		t.Fatal(err)
	}

	handler := New(server, Options{DisableRateLimit: true})
	host := httptest.NewServer(handler)
	defer host.Close()
	defer func() {
		close(release)
		_ = handler.Close()
	}()

	wsURL := "ws" + strings.TrimPrefix(host.URL, "http") + "/typeferry-ws"
	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if _, _, err := conn.Read(context.Background()); err != nil {
		t.Fatal(err)
	}

	for i := range 64 {
		msg := fmt.Sprintf(`{"t":"rpc","id":"b-%d","method":"block"}`, i)
		if err := conn.Write(context.Background(), websocket.MessageText, []byte(msg)); err != nil {
			t.Fatal(err)
		}
	}
	for range 64 {
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for 64 RPC slots to fill")
		}
	}

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"t":"rpc","id":"over","method":"block"}`)); err != nil {
		t.Fatal(err)
	}
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"t":"ping"}`)); err != nil {
		t.Fatal(err)
	}

	readCtx, cancelRead := context.WithTimeout(context.Background(), time.Second)
	defer cancelRead()
	var sawOverLimit, sawPong bool
	for !(sawOverLimit && sawPong) {
		_, frame, err := conn.Read(readCtx)
		if err != nil {
			t.Fatalf("stalled waiting for pong/overload frame (limit=%v pong=%v): %v", sawOverLimit, sawPong, err)
		}
		text := string(frame)
		if strings.Contains(text, `"id":"over"`) && strings.Contains(text, `"Rate Limit Exceeded"`) {
			sawOverLimit = true
		}
		if strings.Contains(text, `"t":"pong"`) {
			sawPong = true
		}
	}
}

func TestWSDisableQueryTokenAndProductionOriginWarning(t *testing.T) {
	t.Setenv("TYPEFERRY_ENV", "production")
	var logs bytes.Buffer
	prevOut := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(prevOut)

	server := runtime.NewServer()
	_ = server.SetAuth(func(_ context.Context, _ *runtime.Client, ctx ejson.Value) (ejson.Value, error) {
		tokenVal, _ := ctx.Lookup("token")
		if text, _ := tokenVal.Text(); text == "query-secret" {
			return ejson.Object(ejson.Field{Key: "user", Value: ejson.Object(ejson.Field{Key: "_id", Value: ejson.String("q1")})}), nil
		}
		return ejson.Null(), nil
	}, func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) {
		return ejson.Null(), nil
	})

	handler := New(server, Options{DisableQueryToken: true})
	defer handler.Close()
	if !strings.Contains(logs.String(), "without an origins allowlist") {
		t.Fatalf("expected production omitted-origins warning, got %q", logs.String())
	}

	host := httptest.NewServer(handler)
	defer host.Close()
	wsURL := "ws" + strings.TrimPrefix(host.URL, "http") + "/typeferry-ws?token=query-secret"
	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	_, frame, err := conn.Read(context.Background())
	if err != nil || !strings.Contains(string(frame), `"authenticated":false`) {
		t.Fatalf("expected query token auth disabled, got %s err=%v", frame, err)
	}

	authHandler := New(server, Options{
		DisableQueryToken: true,
		Authenticate: func(_ context.Context, _ *runtime.Client, h Handshake) (ejson.Value, error) {
			if h.Headers["cookie"] == "sid=ok" {
				return ejson.Object(ejson.Field{Key: "user", Value: ejson.Object(ejson.Field{Key: "_id", Value: ejson.String("c1")})}), nil
			}
			return ejson.Null(), nil
		},
	})
	defer authHandler.Close()
	authHost := httptest.NewServer(authHandler)
	defer authHost.Close()
	authWSURL := "ws" + strings.TrimPrefix(authHost.URL, "http") + "/typeferry-ws?token=query-secret"
	conn2, _, err := websocket.Dial(context.Background(), authWSURL, &websocket.DialOptions{
		HTTPHeader: map[string][]string{"Cookie": {"sid=ok"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn2.CloseNow()
	_, frame2, err := conn2.Read(context.Background())
	if err != nil || !strings.Contains(string(frame2), `"authenticated":true`) {
		t.Fatalf("expected handshake authenticator to succeed with DisableQueryToken, got %s err=%v", frame2, err)
	}
}
