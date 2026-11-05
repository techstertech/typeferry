package ejson

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fixtureValue struct {
	Kind    string              `json:"__kind"`
	Value   json.RawMessage     `json:"value"`
	Items   []fixtureValue      `json:"items"`
	Entries [][]json.RawMessage `json:"entries"`
	Millis  int64               `json:"millis"`
	Base64  string              `json:"base64"`
	Source  string              `json:"source"`
	Flags   string              `json:"flags"`
	Sign    int                 `json:"sign"`
	Type    string              `json:"type"`
	Inner   *fixtureValue       `json:"inner"`
}

type fixture struct {
	Name      string       `json:"name"`
	Canonical bool         `json:"canonical"`
	Value     fixtureValue `json:"value"`
	Encoded   string       `json:"encoded"`
	Register  struct {
		CustomTypes []string `json:"custom_types"`
	} `json:"register"`
}

func rehydrate(t *testing.T, input fixtureValue) Value {
	t.Helper()

	switch input.Kind {
	case "null":
		return Null()
	case "bool":
		var value bool
		if err := json.Unmarshal(input.Value, &value); err != nil {
			t.Fatal(err)
		}
		return Bool(value)
	case "int":
		var value int64
		if err := json.Unmarshal(input.Value, &value); err != nil {
			t.Fatal(err)
		}
		return Int(value)
	case "float":
		var value float64
		if err := json.Unmarshal(input.Value, &value); err != nil {
			t.Fatal(err)
		}
		return Float(value)
	case "string":
		var value string
		if err := json.Unmarshal(input.Value, &value); err != nil {
			t.Fatal(err)
		}
		return String(value)
	case "array":
		items := make([]Value, 0, len(input.Items))
		for _, item := range input.Items {
			items = append(items, rehydrate(t, item))
		}
		return Array(items...)
	case "object":
		fields := make([]Field, 0, len(input.Entries))
		for _, entry := range input.Entries {
			if len(entry) != 2 {
				t.Fatalf("invalid object entry: %q", entry)
			}
			var key string
			var nested fixtureValue
			if err := json.Unmarshal(entry[0], &key); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(entry[1], &nested); err != nil {
				t.Fatal(err)
			}
			fields = append(fields, Field{Key: key, Value: rehydrate(t, nested)})
		}
		return Object(fields...)
	case "date":
		return Date(input.Millis)
	case "binary":
		data, err := base64.StdEncoding.DecodeString(input.Base64)
		if err != nil {
			t.Fatal(err)
		}
		return Binary(data)
	case "regex":
		return Regex(input.Source, input.Flags)
	case "inf_nan":
		switch input.Sign {
		case 0:
			return Float(math.NaN())
		case 1:
			return Float(math.Inf(1))
		case -1:
			return Float(math.Inf(-1))
		}
	case "custom":
		if input.Inner == nil {
			t.Fatal("custom fixture missing inner value")
		}
		return Custom(input.Type, rehydrate(t, *input.Inner))
	}
	t.Fatalf("unknown fixture kind %q", input.Kind)
	return Null()
}

func TestSharedEJSONFixtures(t *testing.T) {
	paths, err := filepath.Glob("../../docs/conformance/fixtures/ejson/*.case.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) == 0 {
		t.Fatal("no EJSON fixtures found")
	}

	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var example fixture
		if err := json.Unmarshal(data, &example); err != nil {
			t.Fatal(err)
		}
		t.Run(filepath.Base(path), func(t *testing.T) {
			codec := NewCodec()
			for _, name := range example.Register.CustomTypes {
				if err := codec.RegisterType(name, func(value Value) (Value, error) {
					return Custom(name, value), nil
				}); err != nil {
					t.Fatal(err)
				}
			}

			encoded, err := codec.Stringify(rehydrate(t, example.Value), example.Canonical)
			if err != nil {
				t.Fatal(err)
			}
			if encoded != example.Encoded {
				t.Fatalf("encode mismatch\n got: %s\nwant: %s", encoded, example.Encoded)
			}

			decoded, err := codec.Parse(example.Encoded)
			if err != nil {
				t.Fatal(err)
			}
			reencoded, err := codec.Stringify(decoded, example.Canonical)
			if err != nil {
				t.Fatal(err)
			}
			if reencoded != example.Encoded {
				t.Fatalf("round-trip mismatch\n got: %s\nwant: %s", reencoded, example.Encoded)
			}
		})
	}
}

func TestCanonicalObjectOrder(t *testing.T) {
	value := Object(
		Field{Key: "z", Value: Int(1)},
		Field{Key: "a", Value: Object(Field{Key: "y", Value: Int(2)}, Field{Key: "x", Value: Int(3)})},
	)
	codec := NewCodec()
	encoded, err := codec.Stringify(value, true)
	if err != nil {
		t.Fatal(err)
	}
	if encoded != `{"a":{"x":3,"y":2},"z":1}` {
		t.Fatalf("canonical order: %s", encoded)
	}
}

func TestCanonicalTaggedObjectOrder(t *testing.T) {
	codec := NewCodec()
	encoded, err := codec.Stringify(Regex("x", "gi"), true)
	if err != nil {
		t.Fatal(err)
	}
	if encoded != `{"$flags":"gi","$regexp":"x"}` {
		t.Fatalf("canonical tag order: %s", encoded)
	}
}

func TestRejectMalformedBinaryAndUnregisteredCustomType(t *testing.T) {
	codec := NewCodec()
	for _, source := range []string{`{"$binary":"AQI"}`, `{"$binary":"A===  "}`, `{"$type":"unknown","$value":1}`} {
		if _, err := codec.Parse(source); err == nil {
			t.Fatalf("accepted %s", source)
		}
	}
}

func TestRegexFlagsAreFilteredAndDeduplicated(t *testing.T) {
	codec := NewCodec()
	decoded, err := codec.Parse(`{"$regexp":"x","$flags":"ggimzy"}`)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := codec.Stringify(decoded, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(encoded, `"$flags":"gimy"`) {
		t.Fatalf("flags: %s", encoded)
	}
}
