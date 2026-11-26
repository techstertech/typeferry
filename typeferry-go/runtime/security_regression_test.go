package runtime

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/leonardoventurini/typeferry/typeferry-go/ejson"
	"github.com/leonardoventurini/typeferry/typeferry-go/protocol"
)

func TestRoomNameLengthPrefixedColonSeparation(t *testing.T) {
	if roomName("user:42", "alert") == roomName("user", "42:alert") {
		t.Fatalf("room names collided: %q", roomName("user:42", "alert"))
	}

	server := NewServer()
	if err := server.AddEvent("alert", EventOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := server.AddEvent("42:alert", EventOptions{}); err != nil {
		t.Fatal(err)
	}

	sock1 := &recordingSocket{}
	sock2 := &recordingSocket{}
	c1 := NewClient("c1")
	c2 := NewClient("c2")
	c1.SetSocket(sock1)
	c2.SetSocket(sock2)
	server.AddClient(c1)
	server.AddClient(c2)

	if _, err := server.Call(context.Background(), protocol.MethodOn, ejson.Object(
		ejson.Field{Key: "events", Value: ejson.Array(ejson.String("alert"))},
		ejson.Field{Key: "channel", Value: ejson.String("user:42")},
	), c1); err != nil {
		t.Fatal(err)
	}
	if _, err := server.Call(context.Background(), protocol.MethodOn, ejson.Object(
		ejson.Field{Key: "events", Value: ejson.Array(ejson.String("42:alert"))},
		ejson.Field{Key: "channel", Value: ejson.String("user")},
	), c2); err != nil {
		t.Fatal(err)
	}

	if err := server.EmitEvent(context.Background(), "alert", "user:42", ejson.String("secret")); err != nil {
		t.Fatal(err)
	}

	if len(sock1.sent) != 1 || len(sock2.sent) != 0 {
		t.Fatalf("cross-room leak: sock1=%d sock2=%d", len(sock1.sent), len(sock2.sent))
	}
}

func TestLogoutEvictsAllRooms(t *testing.T) {
	server := NewServer()
	if err := server.AddEvent("feed", EventOptions{Protected: true}); err != nil {
		t.Fatal(err)
	}
	sock := &recordingSocket{}
	client := NewClient("c1")
	client.SetSocket(sock)
	client.SetAuthenticated(true)
	server.AddClient(client)

	if _, err := server.Call(context.Background(), protocol.MethodOn, ejson.Object(
		ejson.Field{Key: "events", Value: ejson.Array(ejson.String("feed"))},
		ejson.Field{Key: "channel", Value: ejson.String("main")},
	), client); err != nil {
		t.Fatal(err)
	}
	if server.RoomSize("main", "feed") != 1 {
		t.Fatalf("room size = %d, want 1", server.RoomSize("main", "feed"))
	}

	if _, err := server.Call(context.Background(), protocol.MethodLogout, ejson.Null(), client); err != nil {
		t.Fatal(err)
	}
	if server.RoomSize("main", "feed") != 0 {
		t.Fatalf("room still occupied after rpc:logout: %d", server.RoomSize("main", "feed"))
	}
	if err := server.EmitEvent(context.Background(), "feed", "main", ejson.String("after-logout")); err != nil {
		t.Fatal(err)
	}
	if len(sock.sent) != 0 {
		t.Fatalf("logged-out socket received protected event: %v", sock.sent)
	}
}

func TestSubscriptionBoundsAndAuthRecheck(t *testing.T) {
	server := NewServer()
	for i := range 1030 {
		name := fmt.Sprintf("e-%d", i)
		if err := server.AddEvent(name, EventOptions{}); err != nil {
			t.Fatal(err)
		}
	}

	sock := &recordingSocket{}
	client := NewClient("bounded")
	client.SetSocket(sock)
	server.AddClient(client)

	tooMany := make([]ejson.Value, 257)
	for i := range tooMany {
		tooMany[i] = ejson.String(fmt.Sprintf("e-%d", i))
	}
	resTooMany, err := server.Call(context.Background(), protocol.MethodOn, ejson.Object(
		ejson.Field{Key: "events", Value: ejson.Array(tooMany...)},
	), client)
	if err != nil {
		t.Fatal(err)
	}
	if len(resTooMany.Fields()) > 0 {
		t.Fatalf("expected >256 events call to be rejected/empty, got %d fields", len(resTooMany.Fields()))
	}

	resLongChan, err := server.Call(context.Background(), protocol.MethodOn, ejson.Object(
		ejson.Field{Key: "events", Value: ejson.Array(ejson.String("e-0"))},
		ejson.Field{Key: "channel", Value: ejson.String(strings.Repeat("a", 257))},
	), client)
	if err != nil {
		t.Fatal(err)
	}
	if len(resLongChan.Fields()) > 0 {
		t.Fatalf("expected >256 byte channel to be rejected/empty, got %v", resLongChan)
	}

	for batch := range 11 {
		batchEvents := make([]ejson.Value, 0, 100)
		for j := range 100 {
			idx := batch*100 + j
			if idx >= 1030 {
				break
			}
			batchEvents = append(batchEvents, ejson.String(fmt.Sprintf("e-%d", idx)))
		}
		_, _ = server.Call(context.Background(), protocol.MethodOn, ejson.Object(
			ejson.Field{Key: "events", Value: ejson.Array(batchEvents...)},
		), client)
	}
	server.mu.RLock()
	roomCount := len(server.clientRooms[client])
	server.mu.RUnlock()
	if roomCount > 1024 {
		t.Fatalf("client room count %d exceeded cap 1024", roomCount)
	}

	if err := server.AddEvent("priv-race", EventOptions{
		Protected: true,
		ShouldSubscribe: func(c *Client, _ string, _ string) bool {
			c.SetAuthenticated(false)
			return true
		},
	}); err != nil {
		t.Fatal(err)
	}
	c2 := NewClient("racer")
	c2.SetSocket(&recordingSocket{})
	c2.SetAuthenticated(true)
	server.AddClient(c2)
	resRace, err := server.Call(context.Background(), protocol.MethodOn, ejson.Object(
		ejson.Field{Key: "events", Value: ejson.Array(ejson.String("priv-race"))},
	), c2)
	if err != nil {
		t.Fatal(err)
	}
	v, _ := resRace.Lookup("priv-race")
	if b, _ := v.Boolean(); b {
		t.Fatal("client joined protected room after becoming unauthenticated during ShouldSubscribe")
	}
}

func TestSetAuthMarksLoginSensitive(t *testing.T) {
	server := NewServer()
	if err := server.SetAuth(
		func(context.Context, *Client, ejson.Value) (ejson.Value, error) { return ejson.Null(), nil },
		func(context.Context, *Client, ejson.Value) (ejson.Value, error) {
			return ejson.Object(ejson.Field{Key: "token", Value: ejson.String("super-secret-jwt")}), nil
		},
	); err != nil {
		t.Fatal(err)
	}
	var observed []MethodExecution
	server.OnMethodExecution(func(event MethodExecution) {
		observed = append(observed, event)
	})
	if _, err := server.Call(context.Background(), protocol.MethodLogin, ejson.Object(
		ejson.Field{Key: "password", Value: ejson.String("hunter2")},
	), NewClient("c1")); err != nil {
		t.Fatal(err)
	}
	if len(observed) != 1 {
		t.Fatalf("events = %d, want 1", len(observed))
	}
	pText, _ := observed[0].Params.Text()
	rText, _ := observed[0].Result.Text()
	if pText != RedactedMethodTelemetry || rText != RedactedMethodTelemetry {
		t.Fatalf("rpc:login telemetry not redacted: params=%v result=%v", observed[0].Params, observed[0].Result)
	}
}

func TestMethodCacheEvictsErrorsCanceledAndBoundsSize(t *testing.T) {
	server := NewServer()
	calls := 0
	shouldFail := true
	if err := server.AddMethod("flaky", func(_ context.Context, _ *Client, _ ejson.Value) (ejson.Value, error) {
		calls++
		if shouldFail {
			return ejson.Null(), PublicError("transient")
		}
		return ejson.Int(int64(calls)), nil
	}, MethodOptions{Cache: true}); err != nil {
		t.Fatal(err)
	}

	_, err := server.Call(context.Background(), "flaky", ejson.String("k"), nil)
	if err == nil {
		t.Fatal("expected first call error")
	}
	shouldFail = false
	res, err := server.Call(context.Background(), "flaky", ejson.String("k"), nil)
	if err != nil {
		t.Fatalf("second call should not receive cached error: %v", err)
	}
	if n, _ := res.Integer(); n != 2 {
		t.Fatalf("second call returned %v, want 2", res)
	}

	// Cancel in-flight request: should not remain cached as context.Canceled
	var mu sync.Mutex
	allowReturn := false
	cancelCalls := 0
	if err := server.AddMethod("cancellable", func(ctx context.Context, _ *Client, _ ejson.Value) (ejson.Value, error) {
		cancelCalls++
		mu.Lock()
		ok := allowReturn
		mu.Unlock()
		if !ok {
			<-ctx.Done()
			return ejson.Null(), ctx.Err()
		}
		return ejson.String("ok"), nil
	}, MethodOptions{Cache: true}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := server.Call(ctx, "cancellable", ejson.String("x"), nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
	mu.Lock()
	allowReturn = true
	mu.Unlock()
	resCancel, err := server.Call(context.Background(), "cancellable", ejson.String("x"), nil)
	if text, ok := resCancel.Text(); err != nil || !ok || text != "ok" {
		t.Fatalf("unexpected response after canceled call: %v, %v", resCancel, err)
	}

	// Mid-call auth upgrade must not store result in anonymous cache.
	if err := server.AddMethod("auth-midflight", func(_ context.Context, c *Client, _ ejson.Value) (ejson.Value, error) {
		c.SetAuthenticated(true)
		return ejson.String("secret"), nil
	}, MethodOptions{Cache: true}); err != nil {
		t.Fatal(err)
	}
	upgraded := NewClient("up")
	_, err = server.Call(context.Background(), "auth-midflight", ejson.String("same"), upgraded)
	if err != nil {
		t.Fatal(err)
	}
	if len(server.methods["auth-midflight"].cache) != 0 {
		t.Fatal("anonymous cache retained entry from call that became authenticated")
	}

	// Bound cache size at 1000.
	boundedCalls := 0
	if err := server.AddMethod("bounded", func(_ context.Context, _ *Client, v ejson.Value) (ejson.Value, error) {
		boundedCalls++
		return v, nil
	}, MethodOptions{Cache: true}); err != nil {
		t.Fatal(err)
	}
	for i := range 1005 {
		if _, err := server.Call(context.Background(), "bounded", ejson.Int(int64(i)), nil); err != nil {
			t.Fatal(err)
		}
	}
	if len(server.methods["bounded"].cache) > 1000 {
		t.Fatalf("cache grew unboundedly: %d entries", len(server.methods["bounded"].cache))
	}
}

func TestCacheCoalescedWaiterIgnoresElevatedLeaderAndLogoutClearsAuthFirst(t *testing.T) {
	server := NewServer()
	leaderEntered := make(chan struct{})
	releaseLeader := make(chan struct{})
	callNum := 0
	var mu sync.Mutex
	if err := server.AddMethod("coalesce", func(_ context.Context, c *Client, _ ejson.Value) (ejson.Value, error) {
		mu.Lock()
		callNum++
		n := callNum
		mu.Unlock()
		if n == 1 {
			close(leaderEntered)
			<-releaseLeader
			c.SetAuthenticated(true)
			return ejson.String("leader-elevated-secret"), nil
		}
		return ejson.String("anon-safe"), nil
	}, MethodOptions{Cache: true}); err != nil {
		t.Fatal(err)
	}

	leader := NewClient("leader")
	waiter := NewClient("waiter")
	leaderDone := make(chan ejson.Value, 1)
	waiterDone := make(chan ejson.Value, 1)

	go func() {
		v, _ := server.Call(context.Background(), "coalesce", ejson.String("k"), leader)
		leaderDone <- v
	}()
	<-leaderEntered
	go func() {
		v, _ := server.Call(context.Background(), "coalesce", ejson.String("k"), waiter)
		waiterDone <- v
	}()
	// Wait until waiter reaches <-cached.ready before releasing leader.
	time.Sleep(25 * time.Millisecond)
	close(releaseLeader)

	lv := <-leaderDone
	wv := <-waiterDone
	if ls, _ := lv.Text(); ls != "leader-elevated-secret" {
		t.Fatalf("leader got %q", ls)
	}
	if ws, _ := wv.Text(); ws != "anon-safe" {
		t.Fatalf("coalesced waiter received elevated leader result %q", ws)
	}
}
