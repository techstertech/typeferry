package runtime

import (
	"context"
	"math"
	"testing"

	"github.com/leonardoventurini/typeferry/typeferry-go/ejson"
)

func TestAuthenticationUsesJavaScriptTruthiness(t *testing.T) {
	cases := []struct {
		name     string
		identity ejson.Value
		accepted bool
	}{
		{"null", ejson.Null(), false},
		{"false", ejson.Bool(false), false},
		{"integer zero", ejson.Int(0), false},
		{"positive zero", ejson.Float(0), false},
		{"negative zero", ejson.Float(math.Copysign(0, -1)), false},
		{"NaN", ejson.Float(math.NaN()), false},
		{"empty string", ejson.String(""), false},
		{"true", ejson.Bool(true), true},
		{"nonzero number", ejson.Int(-1), true},
		{"infinity", ejson.Float(math.Inf(1)), true},
		{"string", ejson.String("identity"), true},
		{"empty array", ejson.Array(), true},
		{"empty object", ejson.Object(), true},
		{"epoch date", ejson.Date(0), true},
		{"empty binary", ejson.Binary(nil), true},
	}

	for _, example := range cases {
		t.Run(example.name, func(t *testing.T) {
			server := NewServer()
			client := NewClient("")
			client.SetAuthenticated(true)
			client.SetContext(ejson.Object(ejson.Field{Key: "user", Value: ejson.Object(ejson.Field{Key: "_id", Value: ejson.String("previous")})}))

			err := server.SetAuth(func(context.Context, *Client, ejson.Value) (ejson.Value, error) {
				return example.identity, nil
			}, func(context.Context, *Client, ejson.Value) (ejson.Value, error) { return ejson.Null(), nil })
			if err != nil {
				t.Fatal(err)
			}
			if err := server.Authenticate(context.Background(), client, ejson.Object()); err != nil {
				t.Fatal(err)
			}
			if client.Authenticated() != example.accepted {
				t.Fatalf("authenticated = %t, want %t", client.Authenticated(), example.accepted)
			}
			if !example.accepted && (client.Context().Kind() != ejson.KindNull || client.UserID() != "") {
				t.Fatal("rejected identity retained authenticated context")
			}
		})
	}
}

func TestCacheKeyUsesJavaScriptIndexOrder(t *testing.T) {
	server := NewServer()
	calls := 0
	err := server.AddMethod("cached", func(context.Context, *Client, ejson.Value) (ejson.Value, error) {
		calls++
		return ejson.Int(int64(calls)), nil
	}, MethodOptions{Cache: true})
	if err != nil {
		t.Fatal(err)
	}

	for _, keys := range [][]string{{"10", "2"}, {"2", "10"}} {
		fields := make([]ejson.Field, 0, len(keys))
		for _, key := range keys {
			fields = append(fields, ejson.Field{Key: key, Value: ejson.String(key)})
		}

		value, err := server.Call(context.Background(), "cached", ejson.Object(fields...), nil)
		if count, ok := value.Integer(); err != nil || !ok || count != 1 {
			t.Fatalf("index-equivalent params bypassed cache: %v, %v", value, err)
		}
	}
	if calls != 1 {
		t.Fatalf("handler calls = %d, want 1", calls)
	}
}
