// Package redistransport carries TypeFerry cluster events over Redis pub/sub.
package redistransport

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/leonardoventurini/typeferry/typeferry-go/ejson"
	"github.com/leonardoventurini/typeferry/typeferry-go/protocol"
	"github.com/leonardoventurini/typeferry/typeferry-go/runtime"
)

type Publisher interface {
	Publish(context.Context, string, string) error
}

type Options struct {
	SigningSecret string
}

type Envelope struct {
	Event       string
	Channel     string
	Message     string
	ExcludeUUID string
}

func FormatSigningInput(event, channel, message, excludeUUID string) string {
	if channel == "" {
		channel = protocol.NoChannel
	}
	return fmt.Sprintf(
		"%d:%s|%d:%s|%d:%s|%d:%s",
		len(event), event,
		len(channel), channel,
		len(message), message,
		len(excludeUUID), excludeUUID,
	)
}

func SignEnvelope(event, channel, message, excludeUUID, signingSecret string) string {
	mac := hmac.New(sha256.New, []byte(signingSecret))
	_, _ = mac.Write([]byte(FormatSigningInput(event, channel, message, excludeUUID)))
	return hex.EncodeToString(mac.Sum(nil))
}

func PublishEnvelope(event, channel, message, excludeUUID string) (string, string, error) {
	return PublishEnvelopeSigned(event, channel, message, excludeUUID, "")
}

func PublishEnvelopeSigned(event, channel, message, excludeUUID, signingSecret string) (string, string, error) {
	if channel == "" {
		channel = protocol.NoChannel
	}
	fields := []ejson.Field{
		{Key: "event", Value: ejson.String(event)},
		{Key: "channel", Value: ejson.String(channel)},
		{Key: "message", Value: ejson.String(message)},
	}
	if excludeUUID != "" {
		fields = append(fields, ejson.Field{Key: "excludeUuid", Value: ejson.String(excludeUUID)})
	}
	if signingSecret != "" {
		fields = append(fields, ejson.Field{
			Key:   "sig",
			Value: ejson.String(SignEnvelope(event, channel, message, excludeUUID, signingSecret)),
		})
	}
	payload, err := ejson.NewCodec().Stringify(ejson.Object(fields...), false)
	return protocol.RedisEventsChannel, payload, err
}

func ParseEnvelope(payload string) (Envelope, error) {
	return ParseEnvelopeSigned(payload, "")
}

func ParseEnvelopeSigned(payload, signingSecret string) (Envelope, error) {
	value, err := ejson.NewCodec().Parse(payload)
	if err != nil {
		return Envelope{}, err
	}
	if value.Kind() != ejson.KindObject {
		return Envelope{}, errors.New("Redis event must be an object")
	}
	readRequired := func(key string) (string, bool) {
		field, ok := value.Lookup(key)
		if !ok {
			return "", false
		}
		return field.Text()
	}
	readOptional := func(key string) (string, bool) {
		field, ok := value.Lookup(key)
		if !ok || field.Kind() == ejson.KindNull {
			return "", true
		}
		return field.Text()
	}

	eventName, okEvent := readRequired("event")
	messageText, okMsg := readRequired("message")
	channelName, okChannel := readOptional("channel")
	excludeUUID, okExclude := readOptional("excludeUuid")
	if !okEvent || !okMsg || eventName == "" || messageText == "" || !okChannel || !okExclude {
		return Envelope{}, errors.New("Redis event is incomplete")
	}
	if channelName == "" {
		channelName = protocol.NoChannel
	}
	if signingSecret != "" {
		sig, okSig := readRequired("sig")
		if !okSig {
			return Envelope{}, errors.New("Redis event signature is invalid")
		}
		expected := SignEnvelope(eventName, channelName, messageText, excludeUUID, signingSecret)
		if !hmac.Equal([]byte(sig), []byte(expected)) {
			return Envelope{}, errors.New("Redis event signature is invalid")
		}
	}
	return Envelope{Event: eventName, Channel: channelName, Message: messageText, ExcludeUUID: excludeUUID}, nil
}

type Adapter struct {
	server    *runtime.Server
	publisher Publisher
	options   Options
}

func New(server *runtime.Server, publisher Publisher) *Adapter {
	return NewWithOptions(server, publisher, Options{})
}

func NewWithOptions(server *runtime.Server, publisher Publisher, options Options) *Adapter {
	adapter := &Adapter{server: server, publisher: publisher, options: options}
	server.SetEventPublisher(adapter)
	return adapter
}

func (adapter *Adapter) Publish(ctx context.Context, event, channel, message, excludeUUID string) error {
	redisChannel, payload, err := PublishEnvelopeSigned(event, channel, message, excludeUUID, adapter.options.SigningSecret)
	if err != nil {
		return err
	}
	return adapter.publisher.Publish(ctx, redisChannel, payload)
}

func (adapter *Adapter) Receive(ctx context.Context, payload string) error {
	envelope, err := ParseEnvelopeSigned(payload, adapter.options.SigningSecret)
	if err != nil {
		return err
	}
	return adapter.server.PropagateEvent(ctx, envelope.Event, envelope.Channel, envelope.Message, envelope.ExcludeUUID)
}
