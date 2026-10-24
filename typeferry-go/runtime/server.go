// Package runtime owns TypeFerry's server methods, clients, and events without
// depending on an HTTP or WebSocket host.
package runtime

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/leonardoventurini/typeferry/typeferry-go/ejson"
	"github.com/leonardoventurini/typeferry/typeferry-go/protocol"
)

const defaultCacheAge = time.Minute
const RedactedMethodTelemetry = "[REDACTED]"

// ErrClosed rejects new work after the runtime begins retiring. Transports
// must stop admission and join their callbacks before releasing application
// resources; Close itself owns client sockets and presence, not method jobs.
var ErrClosed = errors.New("TypeFerry server is closed")

// PublicError exposes its message to the calling client.
type PublicError string

func (errorValue PublicError) Error() string { return string(errorValue) }

type ValidationIssue struct {
	Path    []string
	Message string
}

func (issue ValidationIssue) String() string {
	return strings.Join(issue.Path, ".") + ": " + issue.Message
}

type SchemaValidationError struct {
	Issues []ValidationIssue
}

func (validation *SchemaValidationError) Error() string {
	return protocol.ErrorInvalidParams + ": " + strings.Join(validation.Errors(), ", ")
}

func (validation *SchemaValidationError) Errors() []string {
	errors := make([]string, len(validation.Issues))
	for index, issue := range validation.Issues {
		errors[index] = issue.String()
	}
	return errors
}

type Header struct {
	Name  string
	Value string
}

// Client carries the connection context and response metadata for one call.
// A transport may update its auth state, while handlers may append headers.
type Client struct {
	mu            sync.RWMutex
	id            string
	context       ejson.Value
	authenticated bool
	userID        string
	response      []Header
	headers       map[string]string
	remoteAddress string
	userAgent     string
	socket        Socket
	meta          ejson.Value
}

func NewClient(id string) *Client {
	if id == "" {
		id = newID()
	}
	return &Client{id: id, context: ejson.Null(), meta: ejson.Object(), headers: make(map[string]string)}
}

func (client *Client) ID() string { return client.id }

func (client *Client) Context() ejson.Value {
	client.mu.RLock()
	defer client.mu.RUnlock()
	return client.context
}

func (client *Client) SetContext(value ejson.Value) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.context = value
	client.userID = ""
	user, found := value.Lookup("user")
	if !found {
		return
	}
	id, found := user.Lookup("_id")
	if !found {
		return
	}
	client.userID, _ = id.Text()
}

func (client *Client) SetAuthenticated(value bool) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.authenticated = value
}

func (client *Client) Authenticated() bool {
	client.mu.RLock()
	defer client.mu.RUnlock()
	return client.authenticated
}

func (client *Client) UserID() string {
	client.mu.RLock()
	defer client.mu.RUnlock()
	return client.userID
}

func (client *Client) AddResponseHeader(name, value string) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.response = append(client.response, Header{Name: name, Value: value})
}

func (client *Client) ResponseHeaders() []Header {
	client.mu.RLock()
	defer client.mu.RUnlock()
	return append([]Header(nil), client.response...)
}

func (client *Client) SetRequestMetadata(headers map[string]string, remoteAddress, userAgent string) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.headers = make(map[string]string, len(headers))
	for name, value := range headers {
		client.headers[strings.ToLower(name)] = value
	}
	client.remoteAddress = remoteAddress
	client.userAgent = userAgent
}

func (client *Client) Header(name string) string {
	client.mu.RLock()
	defer client.mu.RUnlock()
	return client.headers[strings.ToLower(name)]
}

func (client *Client) RemoteAddress() string {
	client.mu.RLock()
	defer client.mu.RUnlock()
	return client.remoteAddress
}

func (client *Client) UserAgent() string {
	client.mu.RLock()
	defer client.mu.RUnlock()
	return client.userAgent
}

func (client *Client) SetSocket(socket Socket) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.socket = socket
}

func (client *Client) Socket() Socket {
	client.mu.RLock()
	defer client.mu.RUnlock()
	return client.socket
}

func (client *Client) SetMeta(value ejson.Value) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.meta = value
}

func (client *Client) Meta() ejson.Value {
	client.mu.RLock()
	defer client.mu.RUnlock()
	return client.meta
}

type Handler func(context.Context, *Client, ejson.Value) (ejson.Value, error)
type Middleware func(context.Context, *Client, ejson.Value) (ejson.Value, error)
type Validator func(ejson.Value) (ejson.Value, []ValidationIssue)
type Authenticator func(context.Context, *Client, ejson.Value) (ejson.Value, error)

type MethodOptions struct {
	Protected  bool
	Sensitive  bool
	Cache      bool
	MaxAge     time.Duration
	Validate   Validator
	Middleware []Middleware
}

type cacheEntry struct {
	value   ejson.Value
	err     error
	created time.Time
	ready   chan struct{}
}

type method struct {
	name    string
	handler Handler
	options MethodOptions
	mu      sync.Mutex
	cache   map[string]*cacheEntry
}

type Execution struct {
	ID            string
	ClientContext ejson.Value
}

type executionKey struct{}

func CurrentExecution(ctx context.Context) (Execution, bool) {
	value, ok := ctx.Value(executionKey{}).(Execution)
	return value, ok
}

type MethodExecution struct {
	Method string
	Time   time.Duration
	Params ejson.Value
	Result ejson.Value
}

// Server is safe for concurrent registration and calls. Transports own their
// listeners; constructing a Server never binds a socket.
type Server struct {
	mu                   sync.RWMutex
	presenceMu           sync.Mutex
	id                   string
	methods              map[string]*method
	auth                 Authenticator
	listeners            []func(MethodExecution)
	codec                *ejson.Codec
	events               map[string]*event
	clients              map[string]*Client
	rooms                map[string]map[*Client]struct{}
	clientRooms          map[*Client]map[string]struct{}
	channelAuthorization func(*Client, string) bool
	eventPublisher       EventPublisher
	presenceTracker      PresenceTracker
	closed               bool
	closeOnce            sync.Once
	closeErr             error
}

func NewServer() *Server {
	server := &Server{
		id:          newID(),
		methods:     make(map[string]*method),
		codec:       ejson.NewCodec(),
		events:      make(map[string]*event),
		clients:     make(map[string]*Client),
		rooms:       make(map[string]map[*Client]struct{}),
		clientRooms: make(map[*Client]map[string]struct{}),
	}
	server.installDefaultMethods()
	return server
}

func (server *Server) Codec() *ejson.Codec { return server.codec }

func (server *Server) ID() string { return server.id }

func (server *Server) AddMethod(name string, handler Handler, options MethodOptions) error {
	if name == "" || handler == nil {
		return errors.New("method requires a name and handler")
	}
	options.Middleware = append([]Middleware(nil), options.Middleware...)
	if options.MaxAge <= 0 {
		options.MaxAge = defaultCacheAge
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if server.closed {
		return ErrClosed
	}
	server.methods[name] = &method{name: name, handler: handler, options: options, cache: make(map[string]*cacheEntry)}
	return nil
}

func (server *Server) HasMethod(name string) bool {
	server.mu.RLock()
	defer server.mu.RUnlock()
	_, exists := server.methods[name]
	return exists
}

func (server *Server) SetAuth(auth Authenticator, login Handler) error {
	if auth == nil || login == nil {
		return errors.New("auth and login handlers are required")
	}
	server.mu.Lock()
	if server.closed {
		server.mu.Unlock()
		return ErrClosed
	}
	server.auth = auth
	server.mu.Unlock()
	return server.AddMethod(protocol.MethodLogin, login, MethodOptions{})
}

func (server *Server) Authenticate(ctx context.Context, client *Client, input ejson.Value) error {
	identity, err := server.AuthenticateValue(ctx, client, input)
	if err != nil {
		client.SetAuthenticated(false)
		client.SetContext(ejson.Null())
		return err
	}
	authenticated := identity.Kind() != ejson.KindNull
	if boolean, ok := identity.Boolean(); ok && !boolean {
		authenticated = false
	}
	client.SetAuthenticated(authenticated)
	if authenticated {
		client.SetContext(identity)
	} else {
		client.SetContext(ejson.Null())
	}
	return nil
}

// AuthenticateValue runs application auth without mutating the client. A
// transport can enforce its timeout before committing the returned identity.
func (server *Server) AuthenticateValue(ctx context.Context, client *Client, input ejson.Value) (ejson.Value, error) {
	server.mu.RLock()
	if server.closed {
		server.mu.RUnlock()
		return ejson.Null(), ErrClosed
	}
	auth := server.auth
	server.mu.RUnlock()
	if auth == nil {
		return ejson.Null(), nil
	}
	return invoke(Handler(auth), ctx, client, input)
}

func (server *Server) OnMethodExecution(listener func(MethodExecution)) {
	server.mu.Lock()
	defer server.mu.Unlock()
	server.listeners = append(server.listeners, listener)
}

func (server *Server) Call(ctx context.Context, name string, params ejson.Value, client *Client) (ejson.Value, error) {
	if client == nil {
		client = NewClient("")
	}
	server.mu.RLock()
	if server.closed {
		server.mu.RUnlock()
		return ejson.Null(), ErrClosed
	}
	entry := server.methods[name]
	listeners := append([]func(MethodExecution){}, server.listeners...)
	server.mu.RUnlock()
	if entry == nil {
		return ejson.Null(), PublicError(protocol.ErrorMethodNotFound)
	}
	if entry.options.Protected && !client.Authenticated() {
		return ejson.Null(), PublicError(protocol.ErrorMethodForbidden)
	}

	started := time.Now()
	clean := params
	if entry.options.Validate != nil {
		input := params
		if input.Kind() == ejson.KindNull {
			input = ejson.Object()
		}
		var issues []ValidationIssue
		clean, issues = entry.options.Validate(input)
		if len(issues) > 0 {
			return ejson.Null(), &SchemaValidationError{Issues: issues}
		}
	}
	emit := func(result ejson.Value) {
		if len(listeners) == 0 {
			return
		}
		telemetryParams := clean
		telemetryResult := result
		if entry.options.Sensitive {
			telemetryParams = ejson.String(RedactedMethodTelemetry)
			telemetryResult = ejson.String(RedactedMethodTelemetry)
		}
		event := MethodExecution{Method: name, Time: time.Since(started), Params: telemetryParams, Result: telemetryResult}
		for _, listener := range listeners {
			listener(event)
		}
	}

	ctx = context.WithValue(ctx, executionKey{}, Execution{ID: newID(), ClientContext: client.Context()})
	transformed := clean
	for _, step := range entry.options.Middleware {
		var err error
		transformed, err = step(ctx, client, transformed)
		if err != nil {
			return ejson.Null(), err
		}
	}

	key := ""
	var pending *cacheEntry
	// Cached results and pending work belong only to anonymous calls. An
	// authenticated call must execute inline authorization on every invocation.
	if entry.options.Cache && !client.Authenticated() {
		var err error
		key, err = server.codec.Stringify(transformed, false)
		if err != nil {
			return ejson.Null(), err
		}
		entry.mu.Lock()
		cached, found := entry.cache[key]
		if found && time.Since(cached.created) < entry.options.MaxAge {
			entry.mu.Unlock()
			select {
			case <-cached.ready:
			case <-ctx.Done():
				return ejson.Null(), ctx.Err()
			}
			if cached.err != nil {
				return ejson.Null(), cached.err
			}
			emit(cached.value)
			return cached.value, nil
		}
		pending = &cacheEntry{created: time.Now(), ready: make(chan struct{})}
		entry.cache[key] = pending
		entry.mu.Unlock()
	}

	result, err := invoke(entry.handler, ctx, client, transformed)
	if pending != nil {
		entry.mu.Lock()
		pending.value = result
		pending.err = err
		close(pending.ready)
		entry.mu.Unlock()
	}
	if err != nil {
		return ejson.Null(), err
	}
	emit(result)
	return result, nil
}

// invoke converts an application panic to an internal failure before Call
// completes its cache entry. Transport-only recovery would leave a cached
// result pending forever and strand other callers sharing the same key.
func invoke(handler Handler, ctx context.Context, client *Client, params ejson.Value) (result ejson.Value, err error) {
	defer func() {
		if recover() != nil {
			result = ejson.Null()
			err = errors.New("TypeFerry callback panicked")
		}
	}()
	return handler(ctx, client, params)
}

func newID() string {
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		panic(fmt.Errorf("generate TypeFerry id: %w", err))
	}
	data[6] = (data[6] & 0x0f) | 0x40
	data[8] = (data[8] & 0x3f) | 0x80
	return hex.EncodeToString(data[0:4]) + "-" + hex.EncodeToString(data[4:6]) + "-" +
		hex.EncodeToString(data[6:8]) + "-" + hex.EncodeToString(data[8:10]) + "-" + hex.EncodeToString(data[10:16])
}
