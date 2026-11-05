// Package websocket adapts TypeFerry's transport-neutral runtime to text frames.
package websocket

import (
	"context"
	"errors"
	"net"
	"regexp"
	"sync"
	"sync/atomic"
	"time"

	"github.com/leonardoventurini/typeferry/typeferry-go/ejson"
	authidentity "github.com/leonardoventurini/typeferry/typeferry-go/internal/identity"
	"github.com/leonardoventurini/typeferry/typeferry-go/protocol"
	"github.com/leonardoventurini/typeferry/typeferry-go/runtime"
)

const AuthenticationTimeout = 5 * time.Second

var validID = regexp.MustCompile(`^[a-zA-Z0-9-]{1,64}$`)

type Handshake struct {
	Path    string
	Headers map[string]string
	Query   map[string]string
}

type HandshakeAuthenticator func(context.Context, *runtime.Client, Handshake) (ejson.Value, error)

// Dispatcher owns one connection's protocol state. The socket must serialize
// concurrent writes; the HTTP adapter provides that guarantee.
type Dispatcher struct {
	server      *runtime.Server
	socket      runtime.Socket
	client      *runtime.Client
	query       map[string]string
	handshake   Handshake
	auth        HandshakeAuthenticator
	pendingPing atomic.Bool
	limit       *rateLimiter
	authTimeout time.Duration

	lifecycle sync.Mutex
	closing   bool
	lifetime  context.Context
	cancel    context.CancelFunc
	callbacks sync.WaitGroup
	closeOnce sync.Once
}

type rateLimiter struct {
	mu       sync.Mutex
	capacity float64
	tokens   float64
	interval time.Duration
	last     time.Time
}

func (limit *rateLimiter) take() bool {
	limit.mu.Lock()
	defer limit.mu.Unlock()
	now := time.Now()
	limit.tokens += now.Sub(limit.last).Seconds() / limit.interval.Seconds() * limit.capacity
	if limit.tokens > limit.capacity {
		limit.tokens = limit.capacity
	}
	limit.last = now
	if limit.tokens < 1 {
		return false
	}
	limit.tokens--
	return true
}

func (dispatcher *Dispatcher) SetRateLimit(max int, interval time.Duration) {
	if max > 0 && interval > 0 {
		dispatcher.limit = &rateLimiter{capacity: float64(max), tokens: float64(max), interval: interval, last: time.Now()}
	}
}

func NewDispatcher(server *runtime.Server, socket runtime.Socket, query map[string]string, auth HandshakeAuthenticator) *Dispatcher {
	id := query["uuid"]
	if !validID.MatchString(id) {
		id = ""
	}
	client := runtime.NewClient(id)
	client.SetSocket(socket)
	client.SetMeta(parseMeta(query["meta"]))
	lifetime, cancel := context.WithCancel(context.Background())
	return &Dispatcher{server: server, socket: socket, client: client, query: query, auth: auth, authTimeout: AuthenticationTimeout, lifetime: lifetime, cancel: cancel}
}

func (dispatcher *Dispatcher) Client() *runtime.Client { return dispatcher.client }

func (dispatcher *Dispatcher) SetHandshake(handshake Handshake) {
	dispatcher.handshake = handshake
}

func (dispatcher *Dispatcher) Open(ctx context.Context) error {
	dispatcher.lifecycle.Lock()
	if dispatcher.closing {
		dispatcher.lifecycle.Unlock()
		return net.ErrClosed
	}
	dispatcher.server.AddClient(dispatcher.client)
	if dispatcher.auth == nil && (!dispatcher.server.HasAuth() || dispatcher.query["token"] == "") {
		dispatcher.lifecycle.Unlock()
		return dispatcher.send(ctx, ejson.Field{Key: "t", Value: ejson.String(protocol.MessageAuth)}, ejson.Field{Key: "authenticated", Value: ejson.Bool(false)})
	}
	// Register callback ownership before Close can start waiting. The timeout
	// decides authentication; retirement still joins the callback's cleanup.
	dispatcher.callbacks.Add(1)
	dispatcher.lifecycle.Unlock()

	authCtx, cancel := context.WithTimeout(ctx, dispatcher.authTimeout)
	defer cancel()
	stop := context.AfterFunc(dispatcher.lifetime, cancel)
	defer stop()
	type authResult struct {
		identity ejson.Value
		err      error
	}
	result := make(chan authResult, 1)
	go func() {
		defer dispatcher.callbacks.Done()
		value := authResult{identity: ejson.Null()}
		defer func() {
			if recover() != nil {
				value = authResult{identity: ejson.Null(), err: errors.New("authentication callback panicked")}
			}
			result <- value
		}()
		if dispatcher.auth != nil {
			value.identity, value.err = dispatcher.auth(authCtx, dispatcher.client, dispatcher.handshake)
			return
		}
		value.identity, value.err = dispatcher.server.AuthenticateValue(authCtx, dispatcher.client, ejson.Object(ejson.Field{Key: "token", Value: ejson.String(dispatcher.query["token"])}))
	}()
	select {
	case <-authCtx.Done():
	case auth := <-result:
		dispatcher.lifecycle.Lock()
		if !dispatcher.closing && auth.err == nil && authCtx.Err() == nil {
			acceptIdentity(dispatcher.client, auth.identity)
			dispatcher.server.RefreshClientPresence(dispatcher.client)
		}
		dispatcher.lifecycle.Unlock()
	}
	return dispatcher.send(ctx, ejson.Field{Key: "t", Value: ejson.String(protocol.MessageAuth)}, ejson.Field{Key: "authenticated", Value: ejson.Bool(dispatcher.client.Authenticated())})
}

func acceptIdentity(client *runtime.Client, identity ejson.Value) {
	accepted := authidentity.Accepted(identity)
	client.SetAuthenticated(accepted)
	if accepted {
		client.SetContext(identity)
	} else {
		client.SetContext(ejson.Null())
	}
}

// Receive processes one frame synchronously for application-owned dispatchers.
// The HTTP adapter admits frames in read order, then runs returned RPC work
// concurrently so a long method cannot block a following cancellation call.
func (dispatcher *Dispatcher) Receive(ctx context.Context, text string) {
	if work := dispatcher.prepare(ctx, text); work != nil {
		work()
	}
}

// prepare keeps parsing, heartbeat and rate admission in incoming frame order.
// Only the application call and its correlated response run asynchronously.
func (dispatcher *Dispatcher) prepare(ctx context.Context, text string) func() {
	frame, err := dispatcher.server.Codec().Parse(text)
	if err != nil || frame.Kind() != ejson.KindObject {
		return nil
	}
	kind, _ := fieldText(frame, "t")
	switch kind {
	case protocol.MessagePing:
		_ = dispatcher.send(ctx, ejson.Field{Key: "t", Value: ejson.String(protocol.MessagePong)})
	case protocol.MessagePong:
		dispatcher.pendingPing.Store(false)
	case protocol.MessageRPC, protocol.MessageRPCVoid:
		if dispatcher.limit != nil && !dispatcher.limit.take() {
			if kind == protocol.MessageRPC {
				id, _ := fieldText(frame, "id")
				dispatcher.sendFailure(ctx, id, protocol.ErrorRateLimit)
			}
			return nil
		}
		method, _ := fieldText(frame, "method")
		params, ok := frame.Lookup("params")
		if !ok {
			params = ejson.Null()
		}
		return func() {
			// Recovery belongs to the protocol task, including middleware and
			// validation hooks. Never expose the recovered application value.
			defer func() {
				if recover() != nil && kind == protocol.MessageRPC {
					id, _ := fieldText(frame, "id")
					dispatcher.sendFailure(ctx, id, protocol.ErrorInternal)
				}
			}()
			result, callError := dispatcher.server.Call(ctx, method, params, dispatcher.client)
			if kind == protocol.MessageRPCVoid {
				return
			}
			id, _ := fieldText(frame, "id")
			fields := []ejson.Field{{Key: "t", Value: ejson.String(protocol.MessageRPCResponse)}, {Key: "id", Value: ejson.String(id)}}
			if callError == nil {
				fields = append(fields, ejson.Field{Key: "result", Value: result})
			} else {
				message := protocol.ErrorInternal
				var public runtime.PublicError
				var validation *runtime.SchemaValidationError
				if errors.As(callError, &public) || errors.As(callError, &validation) {
					message = callError.Error()
				}
				fields = append(fields, ejson.Field{Key: "error", Value: ejson.String(message)})
				if validation != nil {
					values := make([]ejson.Value, len(validation.Errors()))
					for index, issue := range validation.Errors() {
						values[index] = ejson.String(issue)
					}
					fields = append(fields, ejson.Field{Key: "errors", Value: ejson.Array(values...)})
				}
			}
			_ = dispatcher.send(ctx, fields...)
		}
	}
	return nil
}

func (dispatcher *Dispatcher) sendFailure(ctx context.Context, id, message string) {
	_ = dispatcher.send(ctx,
		ejson.Field{Key: "t", Value: ejson.String(protocol.MessageRPCResponse)},
		ejson.Field{Key: "id", Value: ejson.String(id)},
		ejson.Field{Key: "error", Value: ejson.String(message)},
	)
}

func fieldText(value ejson.Value, name string) (string, bool) {
	field, ok := value.Lookup(name)
	if !ok {
		return "", false
	}
	return field.Text()
}

func (dispatcher *Dispatcher) send(ctx context.Context, fields ...ejson.Field) error {
	frame, err := dispatcher.server.Codec().Stringify(ejson.Object(fields...), false)
	if err != nil {
		return err
	}
	return dispatcher.socket.SendText(ctx, frame)
}

// Close cancels and joins authentication callbacks before removing the client.
// Callbacks must observe their context and return; Close cannot forcibly stop
// application Go code and must be called outside a callback it owns.
func (dispatcher *Dispatcher) Close() {
	dispatcher.closeOnce.Do(func() {
		dispatcher.lifecycle.Lock()
		dispatcher.closing = true
		dispatcher.lifecycle.Unlock()

		dispatcher.cancel()
		_ = dispatcher.socket.Close()
		dispatcher.callbacks.Wait()
		dispatcher.server.DeleteClient(dispatcher.client)
	})
}
