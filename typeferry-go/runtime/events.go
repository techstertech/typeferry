package runtime

import (
	"context"
	"errors"
	"fmt"

	"github.com/leonardoventurini/typeferry/typeferry-go/ejson"
	"github.com/leonardoventurini/typeferry/typeferry-go/protocol"
)

// Socket is the narrow runtime-facing part of a WebSocket connection.
// Implementations must serialize writes and make Close idempotent.
type Socket interface {
	SendText(context.Context, string) error
	Close() error
}

type EventOptions struct {
	Protected            bool
	User                 bool
	Cluster              bool
	ExcludeOriginator    bool
	RevalidateOnDelivery bool
	ShouldSubscribe      func(*Client, string, string) bool
}

// EventPublisher carries cluster events to a transport such as Redis.
// The transport echoes each published frame through PropagateEvent.
type EventPublisher interface {
	Publish(context.Context, string, string, string, string) error
}

type PresenceTracker interface {
	RegisterClient(*Client)
	RemoveClient(*Client)
	RefreshClient(*Client)
}

func (server *Server) SetPresenceTracker(tracker PresenceTracker) {
	server.presenceMu.Lock()
	defer server.presenceMu.Unlock()
	server.mu.Lock()
	server.presenceTracker = tracker
	clients := make([]*Client, 0, len(server.clients))
	for _, client := range server.clients {
		clients = append(clients, client)
	}
	server.mu.Unlock()
	if tracker != nil {
		for _, client := range clients {
			tracker.RegisterClient(client)
		}
	}
}

func (server *Server) RefreshClientPresence(client *Client) {
	server.presenceMu.Lock()
	defer server.presenceMu.Unlock()
	server.mu.RLock()
	tracker := server.presenceTracker
	current := server.clients[client.ID()] == client
	server.mu.RUnlock()
	if tracker != nil && current {
		tracker.RefreshClient(client)
	}
}

func (server *Server) SetEventPublisher(publisher EventPublisher) {
	server.mu.Lock()
	defer server.mu.Unlock()
	server.eventPublisher = publisher
}

type event struct {
	name    string
	options EventOptions
}

func (server *Server) AddEvent(name string, options EventOptions) error {
	if name == "" {
		return errors.New("event name is required")
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if server.closed {
		return ErrClosed
	}
	server.events[name] = &event{name: name, options: options}
	return nil
}

func (server *Server) SetChannelAuthorization(check func(*Client, string) bool) {
	server.mu.Lock()
	defer server.mu.Unlock()
	server.channelAuthorization = check
}

// AddWebSocketClient registers a WebSocket handshake client without displacing an
// already active client sharing the requested UUID; on collision it assigns a
// fresh CSPRNG ID to the incoming client instead.
func (server *Server) AddWebSocketClient(client *Client) {
	server.presenceMu.Lock()
	server.mu.Lock()
	if server.closed {
		server.mu.Unlock()
		server.presenceMu.Unlock()
		if socket := client.Socket(); socket != nil {
			_ = socket.Close()
		}
		return
	}
	for {
		existing := server.clients[client.ID()]
		if existing == nil || existing == client {
			break
		}
		client.setID(newID())
	}
	server.clients[client.ID()] = client
	tracker := server.presenceTracker
	server.mu.Unlock()
	if tracker != nil {
		tracker.RegisterClient(client)
	}
	server.presenceMu.Unlock()
}

// AddClient atomically replaces a live client with the same UUID. The old
// socket closes after releasing the server lock, so stale close callbacks
// cannot remove the replacement.
func (server *Server) AddClient(client *Client) {
	server.presenceMu.Lock()
	server.mu.Lock()
	if server.closed {
		server.mu.Unlock()
		server.presenceMu.Unlock()
		if socket := client.Socket(); socket != nil {
			_ = socket.Close()
		}
		return
	}
	previous := server.clients[client.ID()]
	server.clients[client.ID()] = client
	if previous != nil && previous != client {
		server.leaveAllLocked(previous)
	}
	tracker := server.presenceTracker
	server.mu.Unlock()
	if previous != nil && previous != client {
		if tracker != nil {
			tracker.RemoveClient(previous)
		}
	}
	if tracker != nil {
		tracker.RegisterClient(client)
	}
	server.presenceMu.Unlock()
	if previous != nil && previous != client {
		if socket := previous.Socket(); socket != nil {
			_ = socket.Close()
		}
	}
}

func (server *Server) DeleteClient(client *Client) bool {
	server.presenceMu.Lock()
	defer server.presenceMu.Unlock()
	server.mu.Lock()
	server.leaveAllLocked(client)
	if server.clients[client.ID()] != client {
		server.mu.Unlock()
		return false
	}
	delete(server.clients, client.ID())
	tracker := server.presenceTracker
	server.mu.Unlock()
	if tracker != nil {
		tracker.RemoveClient(client)
	}
	return true
}

func (server *Server) Client(id string) *Client {
	server.mu.RLock()
	defer server.mu.RUnlock()
	return server.clients[id]
}

func (server *Server) ClientSnapshot() []*Client {
	server.mu.RLock()
	defer server.mu.RUnlock()
	clients := make([]*Client, 0, len(server.clients))
	for _, client := range server.clients {
		clients = append(clients, client)
	}
	return clients
}

func (server *Server) ClientsForUser(userID string) []*Client {
	server.mu.RLock()
	defer server.mu.RUnlock()
	var result []*Client
	for _, client := range server.clients {
		if client.UserID() == userID {
			result = append(result, client)
		}
	}
	return result
}

func (server *Server) DisconnectUser(userID string) {
	for _, client := range server.ClientsForUser(userID) {
		if socket := client.Socket(); socket != nil {
			_ = socket.Close()
		}
	}
}

// Close freezes admission, removes presence and retires current sockets.
// Concurrent callers join the same retirement and retain its errors. Already
// admitted methods belong to their transport/caller lifetime; close those
// owners before releasing any backing application services. Socket Close must
// be idempotent and must not recursively call this owning runtime's Close.
func (server *Server) Close() error {
	server.closeOnce.Do(func() {
		server.presenceMu.Lock()
		server.mu.Lock()
		server.closed = true
		clients := make([]*Client, 0, len(server.clients))
		for _, client := range server.clients {
			clients = append(clients, client)
		}
		server.clients = make(map[string]*Client)
		server.rooms = make(map[string]map[*Client]struct{})
		server.clientRooms = make(map[*Client]map[string]struct{})
		tracker := server.presenceTracker
		server.presenceTracker = nil
		server.mu.Unlock()
		if tracker != nil {
			for _, client := range clients {
				tracker.RemoveClient(client)
			}
		}
		server.presenceMu.Unlock()
		// A socket's close callback may remove its client. Release both
		// runtime locks first so that removal can complete without recursion.
		var failures []error
		for _, client := range clients {
			if socket := client.Socket(); socket != nil {
				if err := socket.Close(); err != nil {
					failures = append(failures, err)
				}
			}
		}
		server.closeErr = errors.Join(failures...)
	})
	return server.closeErr
}

func (server *Server) joinLocked(client *Client, room string) {
	if server.rooms[room] == nil {
		server.rooms[room] = make(map[*Client]struct{})
	}
	server.rooms[room][client] = struct{}{}
	if server.clientRooms[client] == nil {
		server.clientRooms[client] = make(map[string]struct{})
	}
	server.clientRooms[client][room] = struct{}{}
}

func (server *Server) leaveLocked(client *Client, room string) {
	delete(server.rooms[room], client)
	if len(server.rooms[room]) == 0 {
		delete(server.rooms, room)
	}
	delete(server.clientRooms[client], room)
	if len(server.clientRooms[client]) == 0 {
		delete(server.clientRooms, client)
	}
}

func (server *Server) leaveAllLocked(client *Client) {
	for room := range server.clientRooms[client] {
		server.leaveLocked(client, room)
	}
}

const (
	maxEventsPerSubscriptionCall = 256
	maxChannelNameBytes          = 256
	maxRoomsPerClient            = 1024
)

func roomName(channel, eventName string) string {
	return fmt.Sprintf("typeferry:%d:%s:%s", len(channel), channel, eventName)
}

func eventNames(params ejson.Value) []string {
	value, ok := params.Lookup("events")
	if !ok || value.Kind() != ejson.KindArray {
		return nil
	}
	items := value.Items()
	if len(items) > maxEventsPerSubscriptionCall {
		return nil
	}
	var result []string
	for _, item := range items {
		if name, ok := item.Text(); ok {
			result = append(result, name)
		}
	}
	return result
}

func eventChannel(params ejson.Value) (string, bool) {
	value, ok := params.Lookup("channel")
	if !ok {
		return protocol.NoChannel, true
	}
	name, ok := value.Text()
	if !ok || name == "" {
		return protocol.NoChannel, true
	}
	if len(name) > maxChannelNameBytes {
		return "", false
	}
	return name, true
}

func (server *Server) subscriptionResult(client *Client, params ejson.Value, subscribe bool) ejson.Value {
	channel, channelOK := eventChannel(params)
	if !channelOK {
		return ejson.Object()
	}
	names := eventNames(params)
	if len(names) == 0 {
		return ejson.Object()
	}
	fields := make([]ejson.Field, 0, len(names))
	for _, name := range names {
		server.mu.RLock()
		entry := server.events[name]
		channelAuthorization := server.channelAuthorization
		server.mu.RUnlock()
		allowed := entry != nil
		if subscribe {
			allowed = allowed && client.Socket() != nil
			if allowed && channelAuthorization != nil {
				allowed = channelAuthorization(client, channel)
			}
			if allowed && (entry.options.Protected || entry.options.User) && !client.Authenticated() {
				allowed = false
			}
			if allowed && entry.options.User && entry.options.ShouldSubscribe == nil && channel != client.UserID() {
				allowed = false
			}
			if allowed && entry.options.ShouldSubscribe != nil {
				allowed = entry.options.ShouldSubscribe(client, name, channel)
			}
		}
		if client.Socket() != nil {
			server.mu.Lock()
			if server.closed || server.clients[client.ID()] != client {
				allowed = false
			}
			if subscribe && allowed {
				// Recheck auth and room cap under lock in case logout/revocation ran concurrently.
				if (entry.options.Protected || entry.options.User) && !client.Authenticated() {
					allowed = false
				} else if entry.options.User && entry.options.ShouldSubscribe == nil && channel != client.UserID() {
					allowed = false
				} else {
					room := roomName(channel, name)
					if _, alreadyIn := server.clientRooms[client][room]; !alreadyIn && len(server.clientRooms[client]) >= maxRoomsPerClient {
						allowed = false
					} else {
						server.joinLocked(client, room)
					}
				}
			}
			if !subscribe {
				server.leaveLocked(client, roomName(channel, name))
			}
			server.mu.Unlock()
		}
		fields = append(fields, ejson.Field{Key: name, Value: ejson.Bool(allowed)})
	}
	return ejson.Object(fields...)
}

func (server *Server) installDefaultMethods() {
	_ = server.AddMethod(protocol.MethodOn, func(_ context.Context, client *Client, params ejson.Value) (ejson.Value, error) {
		return server.subscriptionResult(client, params, true), nil
	}, MethodOptions{})
	_ = server.AddMethod(protocol.MethodOff, func(_ context.Context, client *Client, params ejson.Value) (ejson.Value, error) {
		return server.subscriptionResult(client, params, false), nil
	}, MethodOptions{})
	_ = server.AddMethod(protocol.MethodLogout, func(_ context.Context, client *Client, _ ejson.Value) (ejson.Value, error) {
		// Clear auth before evicting rooms so concurrent rpc:on post-checks see
		// authenticated == false if racing with leaveAllLocked.
		client.SetAuthenticated(false)
		client.SetContext(ejson.Null())
		server.mu.Lock()
		server.leaveAllLocked(client)
		server.mu.Unlock()
		server.RefreshClientPresence(client)
		return ejson.Bool(true), nil
	}, MethodOptions{Protected: true})
}

// EmitEvent sends one event frame to each current subscriber. A later Redis
// adapter may propagate cluster events, but local delivery is always bounded
// by the room snapshot taken under the server lock.
func (server *Server) EmitEvent(ctx context.Context, name, channel string, params ejson.Value) error {
	server.mu.RLock()
	if server.closed {
		server.mu.RUnlock()
		return ErrClosed
	}
	entry := server.events[name]
	if entry == nil {
		server.mu.RUnlock()
		return fmt.Errorf("event %q is not registered", name)
	}
	room := roomName(channel, name)
	clients := make([]*Client, 0, len(server.rooms[room]))
	for client := range server.rooms[room] {
		clients = append(clients, client)
	}
	publisher := server.eventPublisher
	server.mu.RUnlock()
	fields := []ejson.Field{
		{Key: "t", Value: ejson.String(protocol.MessageEvent)},
		{Key: "uuid", Value: ejson.String(newID())},
		{Key: "event", Value: ejson.String(name)},
		{Key: "channel", Value: ejson.String(channel)},
		{Key: "params", Value: params},
	}
	frame, err := server.codec.Stringify(ejson.Object(fields...), false)
	if err != nil {
		return err
	}
	exclude := ""
	if entry.options.ExcludeOriginator {
		value, _ := params.Lookup("uuid")
		exclude, _ = value.Text()
	}
	if entry.options.Cluster && publisher != nil {
		return publisher.Publish(ctx, name, channel, frame, exclude)
	}
	return server.deliverEvent(ctx, entry, name, channel, frame, exclude)
}

// PropagateEvent delivers a cluster frame locally without publishing it again.
func (server *Server) PropagateEvent(ctx context.Context, name, channel, frame, exclude string) error {
	server.mu.RLock()
	if server.closed {
		server.mu.RUnlock()
		return ErrClosed
	}
	entry := server.events[name]
	clients := make([]*Client, 0, len(server.rooms[roomName(channel, name)]))
	for client := range server.rooms[roomName(channel, name)] {
		clients = append(clients, client)
	}
	server.mu.RUnlock()
	return server.deliverEvent(ctx, entry, name, channel, frame, exclude)
}

func (server *Server) deliverEvent(ctx context.Context, entry *event, name, channel, frame, exclude string) error {
	if entry == nil || !entry.options.RevalidateOnDelivery {
		return server.deliver(ctx, func() []*Client {
			server.mu.RLock()
			defer server.mu.RUnlock()
			room := server.rooms[roomName(channel, name)]
			clients := make([]*Client, 0, len(room))
			for client := range room {
				clients = append(clients, client)
			}
			return clients
		}(), frame, exclude)
	}

	room := roomName(channel, name)
	server.mu.RLock()
	if server.closed {
		server.mu.RUnlock()
		return ErrClosed
	}
	clients := make([]*Client, 0, len(server.rooms[room]))
	for client := range server.rooms[room] {
		clients = append(clients, client)
	}
	server.mu.RUnlock()

	var failures []error
	for _, client := range clients {
		if client.ID() == exclude {
			continue
		}
		allowed := server.revalidateSubscriber(entry, name, channel, room, client)
		if !allowed {
			continue
		}
		if socket := client.Socket(); socket != nil {
			if err := socket.SendText(ctx, frame); err != nil {
				failures = append(failures, err)
			}
		}
	}
	return errors.Join(failures...)
}

func (server *Server) revalidateSubscriber(entry *event, name, channel, room string, client *Client) bool {
	userID := client.UserID()
	server.mu.RLock()
	channelAuthorization := server.channelAuthorization
	registered := !server.closed && server.events[name] == entry && server.clients[client.ID()] == client
	server.mu.RUnlock()

	allowed := registered && client.Socket() != nil
	if allowed && channelAuthorization != nil {
		allowed = channelAuthorization(client, channel)
	}
	if allowed && (entry.options.Protected || entry.options.User) && !client.Authenticated() {
		allowed = false
	}
	if allowed && entry.options.User && entry.options.ShouldSubscribe == nil && channel != userID {
		allowed = false
	}
	if allowed && entry.options.ShouldSubscribe != nil {
		allowed = entry.options.ShouldSubscribe(client, name, channel)
	}

	server.mu.Lock()
	defer server.mu.Unlock()
	if server.closed || server.events[name] != entry || server.clients[client.ID()] != client {
		return false
	}
	if _, inRoom := server.rooms[room][client]; !inRoom {
		return false
	}
	if allowed && (entry.options.Protected || entry.options.User) && !client.Authenticated() {
		allowed = false
	}
	if allowed && client.UserID() != userID {
		allowed = false
	}
	if !allowed {
		server.leaveLocked(client, room)
		return false
	}
	return true
}

func (server *Server) deliver(ctx context.Context, clients []*Client, frame, exclude string) error {
	var failures []error
	for _, client := range clients {
		if client.ID() == exclude {
			continue
		}
		if socket := client.Socket(); socket != nil {
			if err := socket.SendText(ctx, frame); err != nil {
				failures = append(failures, err)
			}
		}
	}
	return errors.Join(failures...)
}

func (server *Server) RoomSize(channel, eventName string) int {
	server.mu.RLock()
	defer server.mu.RUnlock()
	return len(server.rooms[roomName(channel, eventName)])
}

func (server *Server) HasAuth() bool {
	server.mu.RLock()
	defer server.mu.RUnlock()
	return server.auth != nil
}
