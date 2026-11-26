package redistransport

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/leonardoventurini/typeferry/typeferry-go/runtime"
)

type redisFixture struct {
	Publish *struct {
		Event       string `json:"event"`
		Channel     string `json:"channel"`
		Message     string `json:"message"`
		ExcludeUUID string `json:"exclude_uuid"`
	} `json:"publish"`
	ExpectedChannel string         `json:"expected_redis_channel"`
	ExpectedPayload map[string]any `json:"expected_payload_decoded"`
	IncomingPayload string         `json:"incoming_payload"`
	ExpectedRoute   struct {
		Channel     string `json:"channel"`
		Event       string `json:"event"`
		Payload     string `json:"payload"`
		ExcludeUUID string `json:"exclude_uuid"`
	} `json:"expected_propagate_call"`
}

func TestSharedRedisFixtures(t *testing.T) {
	paths, err := filepath.Glob("../../docs/conformance/fixtures/redis/*.case.json")
	if err != nil || len(paths) == 0 {
		t.Fatalf("Redis fixtures: %v", err)
	}
	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var fixture redisFixture
			if err := json.Unmarshal(data, &fixture); err != nil {
				t.Fatal(err)
			}
			if fixture.Publish != nil {
				channel, payload, err := PublishEnvelope(fixture.Publish.Event, fixture.Publish.Channel, fixture.Publish.Message, fixture.Publish.ExcludeUUID)
				if err != nil {
					t.Fatal(err)
				}
				var decoded map[string]any
				if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
					t.Fatal(err)
				}
				if channel != fixture.ExpectedChannel || !reflect.DeepEqual(decoded, fixture.ExpectedPayload) {
					t.Fatalf("publish %q %#v, want %q %#v", channel, decoded, fixture.ExpectedChannel, fixture.ExpectedPayload)
				}
			}
			if fixture.IncomingPayload != "" {
				route, err := ParseEnvelope(fixture.IncomingPayload)
				if err != nil {
					t.Fatal(err)
				}
				if route.Event != fixture.ExpectedRoute.Event || route.Channel != fixture.ExpectedRoute.Channel || route.Message != fixture.ExpectedRoute.Payload || route.ExcludeUUID != fixture.ExpectedRoute.ExcludeUUID {
					t.Fatalf("route %#v, want %#v", route, fixture.ExpectedRoute)
				}
			}
		})
	}
}

type fakePublisher struct{ channel, payload string }

func (fake *fakePublisher) Publish(_ context.Context, channel, payload string) error {
	fake.channel, fake.payload = channel, payload
	return nil
}

func TestClusterAdapterPublishes(t *testing.T) {
	server := runtime.NewServer()
	fake := &fakePublisher{}
	adapter := New(server, fake)
	if err := adapter.Publish(context.Background(), "changed", "room", `{"t":"event"}`, "peer"); err != nil {
		t.Fatal(err)
	}
	if fake.channel != "events" {
		t.Fatalf("channel = %q", fake.channel)
	}
	route, err := ParseEnvelope(fake.payload)
	if err != nil || route.ExcludeUUID != "peer" {
		t.Fatalf("route = %#v, %v", route, err)
	}
}

func TestRedisHMACSigningAndStrictValidation(t *testing.T) {
	const secret = "test-secret"
	if got := FormatSigningInput("chat.message", "room-a", `{"t":"event"}`, "orig-1"); got != `12:chat.message|6:room-a|13:{"t":"event"}|6:orig-1` {
		t.Fatalf("signing input = %q", got)
	}
	_, payload, err := PublishEnvelopeSigned("chat.message", "room-a", `{"t":"event"}`, "orig-1", secret)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["sig"] != "2fe864725cc91a1de99652933920ffbd5bd716753b3b4a155584e49ea0d4fed0" {
		t.Fatalf("sig = %v", decoded["sig"])
	}
	env, err := ParseEnvelopeSigned(payload, secret)
	if err != nil || env.Event != "chat.message" || env.ExcludeUUID != "orig-1" {
		t.Fatalf("ParseEnvelopeSigned = %#v, %v", env, err)
	}

	if _, err := ParseEnvelopeSigned(`{"event":"chat.message","channel":"room-a","message":"{}"}`, secret); err == nil {
		t.Fatal("expected missing sig to fail")
	}
	if _, err := ParseEnvelopeSigned(strings.Replace(payload, "chat.message", "chat.evil", 1), secret); err == nil {
		t.Fatal("expected tampered payload to fail HMAC verification")
	}
	if _, err := ParseEnvelopeSigned(`{"event":"chat.message","channel":123,"message":"{}"}`, ""); err == nil {
		t.Fatal("expected non-string channel to be rejected")
	}
	if _, err := ParseEnvelopeSigned(`{"event":"chat.message","channel":"room-a","message":"{}","excludeUuid":42}`, ""); err == nil {
		t.Fatal("expected non-string excludeUuid to be rejected")
	}

	server := runtime.NewServer()
	fake := &fakePublisher{}
	adapter := NewWithOptions(server, fake, Options{SigningSecret: secret})
	if err := adapter.Publish(context.Background(), "chat.message", "room-a", `{"t":"event"}`, "orig-1"); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Receive(context.Background(), fake.payload); err != nil {
		t.Fatalf("adapter.Receive signed payload failed: %v", err)
	}
	if err := adapter.Receive(context.Background(), `{"event":"chat.message","channel":"room-a","message":"{}"}`); err == nil {
		t.Fatal("adapter.Receive should reject unsigned payload when SigningSecret is configured")
	}
}
