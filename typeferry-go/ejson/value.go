package ejson

import (
	"math"
	"slices"
	"strconv"
	"strings"
)

// Kind identifies one value in TypeFerry's lossless wire domain.
type Kind uint8

const (
	KindNull Kind = iota
	KindBool
	KindInt
	KindFloat
	KindString
	KindArray
	KindObject
	KindDate
	KindBinary
	KindRegex
	KindCustom
)

// Field preserves insertion order for non-index object keys. Wire encoding
// emits JavaScript array-index keys first, independent of insertion order.
type Field struct {
	Key   string
	Value Value
}

// Value represents JSON primitives and TypeFerry's tagged EJSON values.
// Constructors copy mutable input, so a parsed value does not borrow a caller's
// slice or byte buffer.
type Value struct {
	kind       Kind
	bool       bool
	int        int64
	float      float64
	numberText string
	text       string
	flags      string
	items      []Value
	fields     []Field
	bytes      []byte
	inner      *Value
}

func Null() Value                   { return Value{kind: KindNull} }
func Bool(value bool) Value         { return Value{kind: KindBool, bool: value} }
func Int(value int64) Value         { return Value{kind: KindInt, int: value} }
func Float(value float64) Value     { return Value{kind: KindFloat, float: value} }
func String(value string) Value     { return Value{kind: KindString, text: value} }
func Date(milliseconds int64) Value { return Value{kind: KindDate, int: milliseconds} }
func Binary(data []byte) Value      { return Value{kind: KindBinary, bytes: slices.Clone(data)} }
func Regex(source, flags string) Value {
	return Value{kind: KindRegex, text: source, flags: flags}
}
func Custom(name string, inner Value) Value {
	copy := cloneValue(inner)
	return Value{kind: KindCustom, text: name, inner: &copy}
}
func Array(items ...Value) Value {
	copy := make([]Value, len(items))
	for index, item := range items {
		copy[index] = cloneValue(item)
	}
	return Value{kind: KindArray, items: copy}
}
func Object(fields ...Field) Value {
	copy := make([]Field, len(fields))
	for index, field := range fields {
		copy[index] = Field{Key: field.Key, Value: cloneValue(field.Value)}
	}
	return Value{kind: KindObject, fields: copy}
}

func (value Value) Kind() Kind { return value.kind }

func (value Value) Fields() []Field { return Object(value.fields...).fields }

func (value Value) Items() []Value { return Array(value.items...).items }

func (value Value) Lookup(key string) (Value, bool) {
	for _, field := range value.fields {
		if field.Key == key {
			return cloneValue(field.Value), true
		}
	}
	return Value{}, false
}

func cloneValue(value Value) Value {
	value.bytes = slices.Clone(value.bytes)
	if value.items != nil {
		value.items = Array(value.items...).items
	}
	if value.fields != nil {
		value.fields = Object(value.fields...).fields
	}
	if value.inner != nil {
		inner := cloneValue(*value.inner)
		value.inner = &inner
	}
	return value
}

func (value Value) Text() (string, bool) {
	return value.text, value.kind == KindString
}

func (value Value) Integer() (int64, bool) {
	return value.int, value.kind == KindInt
}

func (value Value) Boolean() (bool, bool) {
	return value.bool, value.kind == KindBool
}

func (value Value) Number() (float64, bool) {
	switch value.kind {
	case KindFloat:
		return value.float, true
	case KindInt:
		return float64(value.int), true
	default:
		return 0, false
	}
}

func (value Value) IsNaN() bool {
	return value.kind == KindFloat && math.IsNaN(value.float)
}

// NumberText retains the original spelling of parsed finite JSON numbers for
// application coercion, including integer literals larger than int64. Number
// still supplies a float64 approximation, and Stringify still uses the existing
// wire/cache-key normalization. Constructed values return their numeric spelling.
func (value Value) NumberText() (string, bool) {
	if value.numberText != "" {
		return value.numberText, true
	}
	if value.kind == KindInt {
		return strconv.FormatInt(value.int, 10), true
	}
	if value.kind != KindFloat || math.IsNaN(value.float) || math.IsInf(value.float, 0) {
		return "", false
	}
	text := strconv.FormatFloat(value.float, 'g', -1, 64)
	if !strings.ContainsAny(text, ".e") {
		text += ".0"
	}
	return text, true
}
