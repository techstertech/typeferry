package websocket

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/leonardoventurini/typeferry/typeferry-go/ejson"
	"github.com/leonardoventurini/typeferry/typeferry-go/runtime"
)

type fixtureSocket struct {
	mu     sync.Mutex
	sent   []string
	closed bool
}

func (socket *fixtureSocket) SendText(_ context.Context, message string) error {
	socket.mu.Lock()
	defer socket.mu.Unlock()
	socket.sent = append(socket.sent, message)
	return nil
}

func (socket *fixtureSocket) Close() error {
	socket.mu.Lock()
	defer socket.mu.Unlock()
	socket.closed = true
	return nil
}

func (socket *fixtureSocket) next(t *testing.T) map[string]any {
	t.Helper()
	socket.mu.Lock()
	defer socket.mu.Unlock()
	if len(socket.sent) == 0 {
		t.Fatal("expected a server frame")
	}
	var result map[string]any
	if err := json.Unmarshal([]byte(socket.sent[0]), &result); err != nil {
		t.Fatal(err)
	}
	socket.sent = socket.sent[1:]
	return result
}

func (socket *fixtureSocket) empty() bool {
	socket.mu.Lock()
	defer socket.mu.Unlock()
	return len(socket.sent) == 0
}

type operation struct {
	Op      string            `json:"op"`
	Query   map[string]string `json:"query"`
	Frame   map[string]any    `json:"frame"`
	Event   string            `json:"event"`
	Channel string            `json:"channel"`
	Params  any               `json:"params"`
	Methods []struct {
		Name      string `json:"name"`
		Handler   string `json:"handler"`
		Protected bool   `json:"protected"`
		Cache     bool   `json:"cache"`
	} `json:"methods"`
	Events []struct {
		Name string `json:"name"`
	} `json:"events"`
	Auth *struct {
		AcceptToken string `json:"accept_token"`
		User        struct {
			ID string `json:"_id"`
		} `json:"user"`
	} `json:"auth"`
}

func TestSharedWebSocketFixtures(t *testing.T) {
	paths, err := filepath.Glob("../../docs/conformance/fixtures/ws/*.seq.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) == 0 {
		t.Fatal("no WebSocket fixtures")
	}
	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			file, err := os.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			server := runtime.NewServer()
			socket := &fixtureSocket{}
			var dispatcher *Dispatcher
			scanner := bufio.NewScanner(file)
			for scanner.Scan() {
				var step operation
				if err := json.Unmarshal(scanner.Bytes(), &step); err != nil {
					t.Fatal(err)
				}
				switch step.Op {
				case "setup":
					for _, definition := range step.Methods {
						name := definition.Handler
						var count atomic.Int64

						if err := server.AddMethod(definition.Name, func(_ context.Context, _ *runtime.Client, value ejson.Value) (ejson.Value, error) {
							switch {
							case name == "increment_counter":
								return ejson.Int(count.Add(1)), nil
							case name == "echo_params":
								return value, nil
							case strings.HasPrefix(name, "return_const:"):
								return ejson.String(strings.TrimPrefix(name, "return_const:")), nil
							case strings.HasPrefix(name, "raise_public:"):
								return ejson.Null(), runtime.PublicError(strings.TrimPrefix(name, "raise_public:"))
							default:
								return ejson.Null(), errors.New("unknown fixture handler")
							}
						}, runtime.MethodOptions{Protected: definition.Protected, Cache: definition.Cache}); err != nil {
							t.Fatal(err)
						}
					}
					for _, event := range step.Events {
						if err := server.AddEvent(event.Name, runtime.EventOptions{}); err != nil {
							t.Fatal(err)
						}
					}
					if step.Auth != nil {
						accept := step.Auth.AcceptToken
						user := step.Auth.User.ID
						if err := server.SetAuth(func(_ context.Context, _ *runtime.Client, value ejson.Value) (ejson.Value, error) {
							token, _ := value.Lookup("token")
							text, _ := token.Text()
							if text != accept {
								return ejson.Null(), nil
							}
							return ejson.Object(ejson.Field{Key: "user", Value: ejson.Object(ejson.Field{Key: "_id", Value: ejson.String(user)})}), nil
						}, func(context.Context, *runtime.Client, ejson.Value) (ejson.Value, error) { return ejson.Bool(true), nil }); err != nil {
							t.Fatal(err)
						}
					}
				case "connect":
					dispatcher = NewDispatcher(server, socket, step.Query, nil)
					if err := dispatcher.Open(context.Background()); err != nil {
						t.Fatal(err)
					}
				case "send":
					encoded, err := json.Marshal(step.Frame)
					if err != nil {
						t.Fatal(err)
					}
					dispatcher.Receive(context.Background(), string(encoded))
				case "server_emit":
					data, err := json.Marshal(step.Params)
					if err != nil {
						t.Fatal(err)
					}
					params, err := server.Codec().Parse(string(data))
					if err != nil {
						t.Fatal(err)
					}
					if err := server.EmitEvent(context.Background(), step.Event, step.Channel, params); err != nil {
						t.Fatal(err)
					}
				case "expect_server_frame":
					actual := socket.next(t)
					if _, present := step.Frame["uuid"]; !present {
						delete(actual, "uuid")
					}
					if !reflect.DeepEqual(actual, step.Frame) {
						t.Fatalf("frame = %#v, want %#v", actual, step.Frame)
					}
				case "expect_no_server_frame":
					if !socket.empty() {
						t.Fatal("unexpected server frame")
					}
				case "disconnect":
					dispatcher.Close()
				default:
					t.Fatalf("unknown operation %q", step.Op)
				}
			}
			if err := scanner.Err(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
