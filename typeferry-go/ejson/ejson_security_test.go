package ejson

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestLargeFlatObjectPerformanceAndOrder(t *testing.T) {
	var builder strings.Builder
	builder.WriteByte('{')
	for i := range 10000 {
		if i > 0 {
			builder.WriteByte(',')
		}
		fmt.Fprintf(&builder, `"k%d":%d`, i, i)
	}
	builder.WriteString(`,"k0":-1}`)

	start := time.Now()
	codec := NewCodec()
	decoded, err := codec.Parse(builder.String())
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("Parse took %s, expected O(N) (<500ms)", elapsed)
	}
	fields := decoded.Fields()
	if len(fields) != 10000 || fields[0].Key != "k0" {
		t.Fatalf("unexpected field count/order: len=%d first=%v", len(fields), fields[0])
	}
	if val, ok := fields[0].Value.Integer(); !ok || val != -1 {
		t.Fatalf("duplicate key k0 value = %v, want -1", fields[0].Value)
	}
}

func TestDepthLimitEnforcedOnParseAndStringify(t *testing.T) {
	codec := NewCodec()

	okSource := strings.Repeat("[", 128) + "1" + strings.Repeat("]", 128)
	if _, err := codec.Parse(okSource); err != nil {
		t.Fatalf("depth 128 rejected unexpectedly: %v", err)
	}

	tooDeepSource := strings.Repeat("[", 130) + "1" + strings.Repeat("]", 130)
	if _, err := codec.Parse(tooDeepSource); err == nil {
		t.Fatal("expected Parse to reject depth > 128")
	}

	deepValue := Int(1)
	for range 130 {
		deepValue = Value{kind: KindArray, items: []Value{deepValue}}
	}
	if _, err := codec.Stringify(deepValue, false); err == nil {
		t.Fatal("expected Stringify to reject depth > 128")
	}
}

func TestDeepBinaryNoQuadraticClone(t *testing.T) {
	codec := NewCodec()
	source := strings.Repeat(`{"a":`, 120) + `{"$binary":"AQID"}` + strings.Repeat("}", 120)
	start := time.Now()
	if _, err := codec.Parse(source); err != nil {
		t.Fatalf("Parse failed: %v", err)
	}
	if time.Since(start) > 200*time.Millisecond {
		t.Fatalf("deep binary decode too slow: %s", time.Since(start))
	}
}

func TestNestedEscapeRespectsMaxDepth(t *testing.T) {
	codec := NewCodec()
	deepEscape := strings.Repeat(`{"$escape":`, 130) + `{"$date":0}` + strings.Repeat("}", 130)
	if _, err := codec.Parse(deepEscape); err == nil {
		t.Fatal("expected Parse to reject nested $escape exceeding maxEJSONDepth")
	}

	val := Object(Field{Key: "$date", Value: Int(0)})
	for range 128 {
		val = Object(Field{Key: "$escape", Value: val})
	}
	if _, err := codec.decodeValue(val, 0); err == nil {
		t.Fatal("expected decodeValue to reject nested $escape exceeding maxEJSONDepth")
	}
	if _, err := codec.Stringify(val, false); err == nil {
		t.Fatal("expected Stringify to reject nested $escape exceeding maxEJSONDepth")
	}
}
