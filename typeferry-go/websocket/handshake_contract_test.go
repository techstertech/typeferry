package websocket

import (
	"context"
	"math"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/leonardoventurini/typeferry/typeferry-go/ejson"
	"github.com/leonardoventurini/typeferry/typeferry-go/runtime"
)

func TestHandshakeAuthenticationUsesJavaScriptTruthiness(t *testing.T) {
	for _, useHandshake := range []bool{false, true} {
		for _, identity := range []ejson.Value{ejson.Int(0), ejson.Float(math.Copysign(0, -1)), ejson.Float(math.NaN()), ejson.String(""), ejson.Object(), ejson.Array()} {
			name, _ := ejson.NewCodec().Stringify(identity, false)
			if useHandshake {
				name = "handshake/" + name
			} else {
				name = "token/" + name
			}
			t.Run(name, func(t *testing.T) {
				server := runtime.NewServer()
				err := server.SetAuth(func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) { return identity, nil },
					func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) { return ejson.Null(), nil })
				if err != nil {
					t.Fatal(err)
				}
				var auth HandshakeAuthenticator
				if useHandshake {
					auth = func(context.Context, *runtime.Client, Handshake) (ejson.Value, error) { return identity, nil }
				}
				socket := &fixtureSocket{}
				dispatcher := NewDispatcher(server, socket, map[string]string{"token": "present"}, auth)
				defer dispatcher.Close()
				if err := dispatcher.Open(context.Background()); err != nil {
					t.Fatal(err)
				}
				want := identity.Kind() == ejson.KindObject || identity.Kind() == ejson.KindArray
				if frame := socket.next(t); frame["authenticated"] != want {
					t.Fatalf("auth frame = %v, want authenticated=%t", frame, want)
				}
				if !want && dispatcher.Client().Context().Kind() != ejson.KindNull {
					t.Fatal("rejected connection retained identity context")
				}
				if !socket.empty() {
					t.Fatal("connection emitted more than one auth frame")
				}
			})
		}
	}
}

func TestHandshakeRejectsInvalidUUIDWithoutReusingSanitizedInput(t *testing.T) {
	valid := regexp.MustCompile(`^[a-zA-Z0-9-]{1,64}$`)
	for _, id := range []string{"", "abc!", "!", strings.Repeat("a", 65), "ü"} {
		dispatcher := NewDispatcher(runtime.NewServer(), &fixtureSocket{}, map[string]string{"uuid": id}, nil)
		got := dispatcher.Client().ID()
		if !valid.MatchString(got) || got == id || got == "abc" {
			t.Errorf("invalid UUID %q became %q", id, got)
		}
	}
	for _, id := range []string{"a", "valid-123", strings.Repeat("a", 64)} {
		dispatcher := NewDispatcher(runtime.NewServer(), &fixtureSocket{}, map[string]string{"uuid": id}, nil)
		if got := dispatcher.Client().ID(); got != id {
			t.Errorf("valid UUID %q became %q", id, got)
		}
	}
}

func TestHandshakeMetadataPreservesPlainJSON(t *testing.T) {
	for _, example := range []struct{ raw, want string }{
		{`{"$date":0}`, `{"$escape":{"$date":0}}`},
		{`{"nested":[{"$type":"unregistered","$value":1}]}`, `{"nested":[{"$escape":{"$type":"unregistered","$value":1}}]}`},
		{`{"$binary":"invalid"}`, `{"$escape":{"$binary":"invalid"}}`},
		{`{"$escape":{"$date":0}}`, `{"$escape":{"$escape":{"$escape":{"$date":0}}}}`},
		{`{"second":2,"first":1}`, `{"second":2,"first":1}`},
		{`{"duplicate":1,"duplicate":2}`, `{"duplicate":2}`},
		{"", `{}`}, {`[]`, `{}`}, {`null`, `{}`}, {`1`, `{}`}, {`"text"`, `{}`}, {`{} {}`, `{}`},
	} {
		t.Run(example.raw, func(t *testing.T) {
			server := runtime.NewServer()
			dispatcher := NewDispatcher(server, &fixtureSocket{}, map[string]string{"meta": example.raw}, nil)
			encoded, err := server.Codec().Stringify(dispatcher.Client().Meta(), false)
			if err != nil || encoded != example.want {
				t.Fatalf("meta = %s, %v; want %s", encoded, err, example.want)
			}
		})
	}
}

func TestHandshakeMetadataBoundsRawUTF8Bytes(t *testing.T) {
	for _, excess := range []int{0, 1} {
		raw := `{"x":"` + strings.Repeat("é", 4996) + strings.Repeat(" ", excess) + `"}`
		if len(raw) != 10000+excess {
			t.Fatal("metadata boundary setup has wrong byte length")
		}
		dispatcher := NewDispatcher(runtime.NewServer(), &fixtureSocket{}, map[string]string{"meta": raw}, nil)
		_, present := dispatcher.Client().Meta().Lookup("x")
		if present != (excess == 0) {
			t.Errorf("%d-byte metadata accepted=%t", len(raw), present)
		}
	}
}

func TestNegativeFixtureRejectsDelayedUnexpectedFrame(t *testing.T) {
	socket := &fixtureSocket{}
	published := make(chan struct{})
	timer := time.AfterFunc(10*time.Millisecond, func() {
		defer close(published)
		_ = socket.SendText(context.Background(), `{"t":"unexpected"}`)
	})
	defer func() {
		if !timer.Stop() {
			<-published
		}
	}()

	if socket.quietWithin(100 * time.Millisecond) {
		t.Fatal("negative fixture accepted a delayed server frame")
	}
}

func TestHTTPUpgradePreservesLiteralMetadataAndReplacesInvalidUUID(t *testing.T) {
	type admitted struct {
		id, meta string
		err      error
	}
	observed := make(chan admitted, 1)
	server := runtime.NewServer()
	handler := New(server, Options{Authenticate: func(_ context.Context, client *runtime.Client, _ Handshake) (ejson.Value, error) {
		encoded, err := server.Codec().Stringify(client.Meta(), false)
		observed <- admitted{client.ID(), encoded, err}
		return ejson.Object(), nil
	}})
	host := httptest.NewServer(handler)
	defer host.Close()
	defer handler.Close()

	query := url.Values{"uuid": {"abc!"}, "meta": {`{"$type":"unregistered","$value":1}`}}
	connection, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(host.URL, "http")+"/typeferry-ws?"+query.Encode(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.CloseNow()
	if _, _, err := connection.Read(context.Background()); err != nil {
		t.Fatal(err)
	}
	result := <-observed
	if result.err != nil || result.id == "abc" || result.id == "abc!" || result.meta != `{"$escape":{"$type":"unregistered","$value":1}}` {
		t.Fatalf("admitted handshake = %+v", result)
	}
}

func TestMissingTokenSkipsTokenAuthentication(t *testing.T) {
	server := runtime.NewServer()
	calls := 0
	if err := server.SetAuth(func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) {
		calls++
		return ejson.Object(), nil
	}, func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) { return ejson.Null(), nil }); err != nil {
		t.Fatal(err)
	}
	socket := &fixtureSocket{}
	dispatcher := NewDispatcher(server, socket, nil, nil)
	defer dispatcher.Close()
	if err := dispatcher.Open(context.Background()); err != nil {
		t.Fatal(err)
	}
	if frame := socket.next(t); calls != 0 || frame["authenticated"] != false || !socket.empty() {
		t.Fatalf("missing token: auth calls=%d, frame=%v", calls, frame)
	}
}

func TestJSONMetadataRetainsIntegerAccessors(t *testing.T) {
	dispatcher := NewDispatcher(runtime.NewServer(), &fixtureSocket{}, map[string]string{"meta": `{"count":1}`}, nil)
	value, present := dispatcher.Client().Meta().Lookup("count")
	if count, integer := value.Integer(); !present || !integer || count != 1 {
		t.Fatalf("integer metadata = %v", value)
	}
}
