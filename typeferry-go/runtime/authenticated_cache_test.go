package runtime

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/leonardoventurini/typeferry/typeferry-go/ejson"
)

func TestAuthenticatedCachedMethodsKeepCallerResultsSeparate(t *testing.T) {
	for _, protected := range []bool{false, true} {
		t.Run(fmt.Sprintf("protected=%t", protected), func(t *testing.T) {
			server := NewServer()
			calls := 0
			err := server.AddMethod("identity", func(_ context.Context, client *Client, _ ejson.Value) (ejson.Value, error) {
				calls++
				return ejson.String(client.UserID()), nil
			}, MethodOptions{Cache: true, Protected: protected})
			if err != nil {
				t.Fatal(err)
			}

			for _, userID := range []string{"first", "second", "first"} {
				client := NewClient("")
				client.SetContext(ejson.Object(ejson.Field{Key: "user", Value: ejson.Object(ejson.Field{Key: "_id", Value: ejson.String(userID)})}))
				client.SetAuthenticated(true)

				result, err := server.Call(context.Background(), "identity", ejson.Null(), client)
				if value, ok := result.Text(); err != nil || !ok || value != userID {
					t.Fatalf("caller %s received %v, %v", userID, result, err)
				}
			}
			if calls != 3 {
				t.Fatalf("handler calls = %d, want 3", calls)
			}
		})
	}
}

func TestAuthenticatedCachedMethodRechecksInlinePermission(t *testing.T) {
	server := NewServer()
	client := NewClient("")
	client.SetAuthenticated(true)
	allowed := true
	denied := PublicError("Permission revoked")
	err := server.AddMethod("private", func(context.Context, *Client, ejson.Value) (ejson.Value, error) {
		if !allowed {
			return ejson.Null(), denied
		}
		return ejson.String("private result"), nil
	}, MethodOptions{Cache: true, Protected: true})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := server.Call(context.Background(), "private", ejson.Null(), client); err != nil {
		t.Fatal(err)
	}
	allowed = false

	if _, err := server.Call(context.Background(), "private", ejson.Null(), client); !errors.Is(err, denied) {
		t.Fatalf("revoked permission returned %v, want %v", err, denied)
	}
}

func TestCachedMethodSeparatesAnonymousAndAuthenticatedTransitions(t *testing.T) {
	server := NewServer()
	client := NewClient("")
	calls := 0
	err := server.AddMethod("view", func(_ context.Context, client *Client, _ ejson.Value) (ejson.Value, error) {
		calls++
		return ejson.String(fmt.Sprintf("authenticated=%t,call=%d", client.Authenticated(), calls)), nil
	}, MethodOptions{Cache: true})
	if err != nil {
		t.Fatal(err)
	}

	steps := []struct {
		authenticated bool
		key           string
		want          string
	}{
		{false, "anonymous-first", "authenticated=false,call=1"},
		{true, "anonymous-first", "authenticated=true,call=2"},
		{true, "anonymous-first", "authenticated=true,call=3"},
		{true, "authenticated-first", "authenticated=true,call=4"},
		{false, "authenticated-first", "authenticated=false,call=5"},
		{false, "anonymous-first", "authenticated=false,call=1"},
		{false, "authenticated-first", "authenticated=false,call=5"},
	}
	for _, step := range steps {
		client.SetAuthenticated(step.authenticated)
		result, err := server.Call(context.Background(), "view", ejson.String(step.key), client)
		if value, ok := result.Text(); err != nil || !ok || value != step.want {
			t.Errorf("authenticated=%t, key=%s: got %v, %v; want %s", step.authenticated, step.key, result, err, step.want)
		}
	}
	if calls != 5 {
		t.Fatalf("handler calls = %d, want 5", calls)
	}
}

func TestAnonymousCachedResultExpires(t *testing.T) {
	server := NewServer()
	calls := 0
	const cacheAge = time.Millisecond

	err := server.AddMethod("expiring", func(context.Context, *Client, ejson.Value) (ejson.Value, error) {
		calls++
		return ejson.Int(int64(calls)), nil
	}, MethodOptions{Cache: true, MaxAge: cacheAge})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.Call(context.Background(), "expiring", ejson.Null(), nil); err != nil {
		t.Fatal(err)
	}

	time.Sleep(2 * cacheAge)

	result, err := server.Call(context.Background(), "expiring", ejson.Null(), nil)
	if value, ok := result.Integer(); err != nil || !ok || value != 2 {
		t.Fatalf("expired result = %v, %v; want second execution", result, err)
	}
}
