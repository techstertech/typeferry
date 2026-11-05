package websocket

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/leonardoventurini/typeferry/typeferry-go/protocol"
	"github.com/leonardoventurini/typeferry/typeferry-go/runtime"
)

const PingInterval = 25 * time.Second

type Options struct {
	// Origins is unrestricted when nil; a non-nil empty slice denies named origins.
	Origins []string
	// AllowOriginless admits missing Origin headers only for this WebSocket handler.
	AllowOriginless bool
	Authenticate    HandshakeAuthenticator
	MaxMessageBytes int64
	RateLimitMax    int
	RateLimitWindow time.Duration
}

type Handler struct {
	server    *runtime.Server
	options   Options
	origins   map[string]struct{}
	mu        sync.Mutex
	sockets   map[*connectionSocket]struct{}
	closed    bool
	active    sync.WaitGroup
	closeOnce sync.Once
	closeErr  error
}

func New(server *runtime.Server, options Options) *Handler {
	var origins map[string]struct{}
	if options.Origins != nil {
		origins = make(map[string]struct{}, len(options.Origins))
	}
	for _, origin := range options.Origins {
		origins[origin] = struct{}{}
	}
	return &Handler{server: server, options: options, origins: origins, sockets: make(map[*connectionSocket]struct{})}
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.URL.Path != protocol.WebSocketPath {
		http.NotFound(response, request)
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		http.Error(response, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}
	origin := request.Header.Get("Origin")
	_, originPresent := request.Header["Origin"]
	if handler.origins != nil {
		_, allowed := handler.origins[origin]
		if !originPresent {
			allowed = handler.options.AllowOriginless
		} else if origin == "" {
			allowed = false
		}
		if !allowed {
			http.Error(response, "Forbidden", http.StatusForbidden)
			return
		}
	}
	handler.mu.Lock()
	if handler.closed {
		handler.mu.Unlock()
		http.Error(response, "Service Unavailable", http.StatusServiceUnavailable)
		return
	}
	handler.active.Add(1)
	handler.mu.Unlock()
	defer handler.active.Done()

	connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	limit := handler.options.MaxMessageBytes
	if limit <= 0 {
		limit = 1 << 20
	}
	connection.SetReadLimit(limit)
	ctx, cancel := context.WithCancel(request.Context())
	socket := &connectionSocket{connection: connection, cancel: cancel}
	handler.mu.Lock()
	if handler.closed {
		handler.mu.Unlock()
		_ = socket.Close()
		return
	}
	handler.sockets[socket] = struct{}{}
	handler.mu.Unlock()
	defer func() {
		handler.mu.Lock()
		delete(handler.sockets, socket)
		handler.mu.Unlock()
	}()
	query := make(map[string]string)
	for name, values := range request.URL.Query() {
		if len(values) > 0 {
			query[name] = values[0]
		}
	}
	headers := make(map[string]string)
	for name, values := range request.Header {
		if len(values) > 0 {
			headers[strings.ToLower(name)] = values[0]
		}
	}
	dispatcher := NewDispatcher(handler.server, socket, query, handler.options.Authenticate)
	if handler.options.RateLimitMax > 0 {
		window := handler.options.RateLimitWindow
		if window <= 0 {
			window = time.Minute
		}
		dispatcher.SetRateLimit(handler.options.RateLimitMax, window)
	}
	dispatcher.SetHandshake(Handshake{Path: request.URL.Path, Headers: headers, Query: query})
	dispatcher.Client().SetRequestMetadata(headers, request.RemoteAddr, request.UserAgent())
	frames := make(chan string, 1)
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		defer socket.Close()
		for {
			kind, data, err := connection.Read(ctx)
			if err != nil {
				return
			}
			if kind == websocket.MessageText {
				select {
				case frames <- string(data):
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	var calls sync.WaitGroup
	var pingDone chan struct{}
	defer func() {
		_ = socket.Close()
		calls.Wait()
		<-readDone
		if pingDone != nil {
			<-pingDone
		}
		dispatcher.Close()
	}()
	if err := dispatcher.Open(ctx); err != nil || ctx.Err() != nil {
		return
	}
	pingDone = make(chan struct{})
	go func() {
		defer close(pingDone)
		handler.pingLoop(ctx, dispatcher)
	}()
	for {
		select {
		case text := <-frames:
			if ctx.Err() != nil {
				return
			}
			if work := dispatcher.prepare(ctx, text); work != nil {
				if ctx.Err() != nil {
					return
				}
				calls.Add(1)
				go func() { defer calls.Done(); work() }()
			}
		case <-ctx.Done():
			return
		}
	}
}

func (handler *Handler) pingLoop(ctx context.Context, dispatcher *Dispatcher) {
	ticker := time.NewTicker(PingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if dispatcher.pendingPing.Swap(true) {
				_ = dispatcher.socket.Close()
				return
			}
			if err := dispatcher.socket.SendText(ctx, `{"t":"ping"}`); err != nil {
				_ = dispatcher.socket.Close()
				return
			}
		}
	}
}

// Close stops admission, cancels every upgraded connection and joins its
// authentication, active methods, reader and heartbeat before returning.
// Concurrent closers join the same retirement. Application callbacks must
// observe context cancellation and return; call Close outside those callbacks.
func (handler *Handler) Close() error {
	handler.closeOnce.Do(func() {
		handler.mu.Lock()
		handler.closed = true
		sockets := make([]*connectionSocket, 0, len(handler.sockets))
		for socket := range handler.sockets {
			sockets = append(sockets, socket)
		}
		handler.mu.Unlock()

		for _, socket := range sockets {
			handler.closeErr = errors.Join(handler.closeErr, socket.Close())
		}
		// Add happens under the same admission lock before upgrade; an upgrade
		// already in progress also observes closed and retires before this join.
		handler.active.Wait()
	})
	return handler.closeErr
}

type connectionSocket struct {
	connection *websocket.Conn
	once       sync.Once
	cancel     context.CancelFunc
	closeErr   error
}

func (socket *connectionSocket) SendText(ctx context.Context, message string) error {
	return socket.connection.Write(ctx, websocket.MessageText, []byte(message))
}

func (socket *connectionSocket) Close() error {
	socket.once.Do(func() {
		socket.cancel()
		socket.closeErr = socket.connection.CloseNow()
	})
	return socket.closeErr
}
