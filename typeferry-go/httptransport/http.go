// Package httptransport mounts TypeFerry's POST /__h protocol on net/http.
package httptransport

import (
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/leonardoventurini/typeferry/typeferry-go/ejson"
	"github.com/leonardoventurini/typeferry/typeferry-go/protocol"
	"github.com/leonardoventurini/typeferry/typeferry-go/runtime"
)

const (
	defaultBodyLimit  = 4 * 1024 * 1024
	defaultRateMax    = 120
	defaultRateWindow = time.Minute
)

type Options struct {
	// Origins is unrestricted when nil; a non-nil empty slice denies named origins.
	Origins []string
	// AllowOriginless admits missing Origin headers only for this HTTP handler.
	AllowOriginless  bool
	MaxBodyBytes     int64
	DisableRateLimit bool
	RateLimitMax     int
	RateLimitWindow  time.Duration
	ClientAddress    func(*http.Request) string
}

type limiter struct {
	mu      sync.Mutex
	entries map[string][]time.Time
	max     int
	window  time.Duration
}

func (limit *limiter) consume(key string) (bool, int, time.Duration) {
	limit.mu.Lock()
	defer limit.mu.Unlock()
	now := time.Now()
	old := limit.entries[key]
	kept := old[:0]
	for _, instant := range old {
		if now.Sub(instant) < limit.window {
			kept = append(kept, instant)
		}
	}
	if len(kept) >= limit.max {
		limit.entries[key] = kept
		return false, 0, limit.window - now.Sub(kept[0])
	}
	kept = append(kept, now)
	limit.entries[key] = kept
	return true, limit.max - len(kept), limit.window - now.Sub(kept[0])
}

// Handler applies transport-level origin, size, and rate policy before calling
// an application-owned Server. It never binds a listener itself.
type Handler struct {
	server  *runtime.Server
	options Options
	origins map[string]struct{}
	limit   *limiter
}

func New(server *runtime.Server, options Options) *Handler {
	if options.MaxBodyBytes <= 0 {
		options.MaxBodyBytes = defaultBodyLimit
	}
	if options.RateLimitMax <= 0 {
		options.RateLimitMax = defaultRateMax
	}
	if options.RateLimitWindow <= 0 {
		options.RateLimitWindow = defaultRateWindow
	}
	var origins map[string]struct{}
	if options.Origins != nil {
		origins = make(map[string]struct{}, len(options.Origins))
	}
	for _, origin := range options.Origins {
		origins[origin] = struct{}{}
	}
	handler := &Handler{server: server, options: options, origins: origins}
	if !options.DisableRateLimit {
		handler.limit = &limiter{entries: make(map[string][]time.Time), max: options.RateLimitMax, window: options.RateLimitWindow}
	}
	return handler
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.URL.Path != protocol.HTTPPath {
		http.NotFound(response, request)
		return
	}
	if request.Method != http.MethodPost {
		response.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !handler.originAllowed(request.Header.Get("Origin")) {
		response.WriteHeader(http.StatusForbidden)
		return
	}
	address := handler.clientAddress(request)
	if handler.limit != nil {
		allowed, remaining, reset := handler.limit.consume(address)
		response.Header().Set("RateLimit-Limit", intString(handler.limit.max))
		response.Header().Set("RateLimit-Remaining", intString(remaining))
		resetSeconds := reset / time.Second
		if reset%time.Second > 0 {
			resetSeconds++
		}
		response.Header().Set("RateLimit-Reset", intString(int(resetSeconds)))
		if !allowed {
			response.WriteHeader(http.StatusTooManyRequests)
			return
		}
	}
	if request.ContentLength > handler.options.MaxBodyBytes {
		response.WriteHeader(http.StatusRequestEntityTooLarge)
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, handler.options.MaxBodyBytes+1))
	if err != nil {
		response.WriteHeader(http.StatusBadRequest)
		return
	}
	if int64(len(body)) > handler.options.MaxBodyBytes {
		response.WriteHeader(http.StatusRequestEntityTooLarge)
		return
	}
	handler.dispatch(response, request, address, string(body))
}

func (handler *Handler) originAllowed(origin string) bool {
	if handler.origins == nil {
		return true
	}
	if origin == "" {
		return handler.options.AllowOriginless
	}
	_, allowed := handler.origins[origin]
	return allowed
}

func (handler *Handler) clientAddress(request *http.Request) string {
	if handler.options.ClientAddress != nil {
		return handler.options.ClientAddress(request)
	}
	address := request.RemoteAddr
	if host, _, err := net.SplitHostPort(address); err == nil {
		return host
	}
	return address
}

func (handler *Handler) dispatch(response http.ResponseWriter, request *http.Request, address, body string) {
	codec := handler.server.Codec()
	transport, err := codec.Parse(body)
	if err != nil || transport.Kind() != ejson.KindObject {
		handler.writeError(response, protocol.ErrorInvalidRequest, "", "", nil, false)
		return
	}
	payload, ok := transport.Lookup("payload")
	if !ok || payload.Kind() != ejson.KindObject {
		handler.writeError(response, protocol.ErrorInvalidRequest, "", "", nil, false)
		return
	}
	methodValue, _ := payload.Lookup("method")
	methodName, _ := methodValue.Text()
	voidValue, _ := payload.Lookup("void")
	isVoid, _ := voidValue.Boolean()
	if methodName == "" || !handler.server.HasMethod(methodName) {
		handler.writeError(response, protocol.ErrorMethodNotFound, "", methodName, nil, isVoid)
		return
	}

	client := runtime.NewClient(request.Header.Get("X-Client-Id"))
	headers := make(map[string]string, len(request.Header))
	for name, values := range request.Header {
		if len(values) > 0 {
			headers[name] = values[0]
		}
	}
	client.SetRequestMetadata(headers, address, request.UserAgent())
	authInput, ok := transport.Lookup("context")
	if !ok || authInput.Kind() != ejson.KindObject {
		authInput = ejson.Object()
	}
	if token := request.Header.Get("X-Api-Key"); token != "" && token != "undefined" {
		authInput = setField(authInput, "token", ejson.String(strings.TrimPrefix(token, "Bearer ")))
	}
	if err := handler.server.Authenticate(request.Context(), client, authInput); err != nil {
		handler.writeError(response, protocol.ErrorInternal, "", "", nil, isVoid)
		return
	}
	params, ok := payload.Lookup("params")
	if !ok {
		params = ejson.Null()
	}
	result, err := handler.server.Call(request.Context(), methodName, params, client)
	uuidValue, _ := payload.Lookup("uuid")
	uuid, _ := uuidValue.Text()
	if err != nil {
		message := protocol.ErrorInternal
		var public runtime.PublicError
		var validation *runtime.SchemaValidationError
		switch {
		case errors.As(err, &validation):
			message = validation.Error()
			handler.writeError(response, message, uuid, "", validation.Errors(), isVoid)
			return
		case errors.As(err, &public):
			message = public.Error()
			if message == protocol.ErrorMethodForbidden {
				handler.writeError(response, message, "", methodName, nil, isVoid)
				return
			}
		default:
			log.Printf("TypeFerry HTTP dispatch failed: %T", err)
		}
		handler.writeError(response, message, uuid, "", nil, isVoid)
		return
	}
	fields := []ejson.Field{{Key: "type", Value: ejson.String("result")}}
	if uuid != "" {
		fields = append(fields, ejson.Field{Key: "uuid", Value: ejson.String(uuid)})
	}
	fields = append(fields, ejson.Field{Key: "method", Value: ejson.String(methodName)}, ejson.Field{Key: "result", Value: result})
	encoded, err := codec.Stringify(ejson.Object(fields...), false)
	if err != nil {
		handler.writeError(response, protocol.ErrorInternal, uuid, "", nil, isVoid)
		return
	}
	for _, header := range client.ResponseHeaders() {
		response.Header().Add(header.Name, header.Value)
	}
	writeBody(response, encoded)
}

func (handler *Handler) writeError(response http.ResponseWriter, message, uuid, method string, issues []string, silent bool) {
	if silent {
		writeBody(response, "")
		return
	}
	fields := []ejson.Field{{Key: "type", Value: ejson.String("error")}, {Key: "message", Value: ejson.String(message)}}
	if uuid != "" {
		fields = append(fields, ejson.Field{Key: "uuid", Value: ejson.String(uuid)})
	}
	if method != "" {
		fields = append(fields, ejson.Field{Key: "method", Value: ejson.String(method)})
	}
	if issues != nil {
		items := make([]ejson.Value, len(issues))
		for index, issue := range issues {
			items[index] = ejson.String(issue)
		}
		fields = append(fields, ejson.Field{Key: "errors", Value: ejson.Array(items...)})
	}
	encoded, err := handler.server.Codec().Stringify(ejson.Object(fields...), false)
	if err != nil {
		response.WriteHeader(http.StatusInternalServerError)
		return
	}
	writeBody(response, encoded)
}

func writeBody(response http.ResponseWriter, body string) {
	response.Header().Set("Content-Type", "text/plain; charset=utf-8")
	response.Header().Set("Content-Length", intString(len(body)))
	response.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(response, body)
}

func setField(object ejson.Value, key string, value ejson.Value) ejson.Value {
	fields := object.Fields()
	for index := range fields {
		if fields[index].Key == key {
			fields[index].Value = value
			return ejson.Object(fields...)
		}
	}
	return ejson.Object(append(fields, ejson.Field{Key: key, Value: value})...)
}

func intString(value int) string { return strconv.Itoa(value) }
