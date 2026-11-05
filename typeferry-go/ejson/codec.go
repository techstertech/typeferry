package ejson

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"
)

const validRegexFlags = "gimuy"

type TypeFactory func(Value) (Value, error)

// Codec scopes custom-type registrations to one application rather than a
// process global. Registration and decoding are safe for concurrent calls.
type Codec struct {
	mu        sync.RWMutex
	factories map[string]TypeFactory
}

func NewCodec() *Codec {
	return &Codec{factories: make(map[string]TypeFactory)}
}

func (codec *Codec) RegisterType(name string, factory TypeFactory) error {
	if name == "" || factory == nil {
		return errors.New("custom EJSON type requires a name and factory")
	}

	codec.mu.Lock()
	defer codec.mu.Unlock()
	if _, exists := codec.factories[name]; exists {
		return fmt.Errorf("custom EJSON type %s is already registered", name)
	}
	codec.factories[name] = factory
	return nil
}

// Parse decodes one complete EJSON document, preserving object key order.
func (codec *Codec) Parse(source string) (Value, error) {
	decoder := json.NewDecoder(strings.NewReader(source))
	decoder.UseNumber()
	value, err := codec.readValue(decoder)
	if err != nil {
		return Value{}, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return Value{}, errors.New("EJSON contains trailing data")
		}
		return Value{}, err
	}
	return codec.decodeValue(value)
}

func (codec *Codec) readValue(decoder *json.Decoder) (Value, error) {
	token, err := decoder.Token()
	if err != nil {
		return Value{}, err
	}
	switch item := token.(type) {
	case nil:
		return Null(), nil
	case bool:
		return Bool(item), nil
	case string:
		return String(item), nil
	case json.Number:
		if !strings.ContainsAny(string(item), ".eE") {
			if integer, err := item.Int64(); err == nil {
				value := Int(integer)
				value.numberText = string(item)
				return value, nil
			}
		}
		number, err := item.Float64()
		if err != nil || math.IsInf(number, 0) {
			return Value{}, fmt.Errorf("invalid EJSON number %s", item)
		}
		value := Float(number)
		value.numberText = string(item)
		return value, nil
	case json.Delim:
		switch item {
		case '[':
			var items []Value
			for decoder.More() {
				value, err := codec.readValue(decoder)
				if err != nil {
					return Value{}, err
				}
				items = append(items, value)
			}
			_, err := decoder.Token()
			return Array(items...), err
		case '{':
			var fields []Field
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return Value{}, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return Value{}, errors.New("EJSON object key must be a string")
				}
				value, err := codec.readValue(decoder)
				if err != nil {
					return Value{}, err
				}
				// JSON.parse keeps the first insertion position on duplicate keys.
				position := -1
				for index := range fields {
					if fields[index].Key == key {
						position = index
						break
					}
				}
				if position < 0 {
					fields = append(fields, Field{key, value})
				} else {
					fields[position].Value = value
				}
			}
			if _, err := decoder.Token(); err != nil {
				return Value{}, err
			}
			return Object(fields...), nil
		}
	}
	return Value{}, fmt.Errorf("unsupported EJSON token %v", token)
}

func (codec *Codec) decodeValue(value Value) (Value, error) {
	switch value.kind {
	case KindArray:
		items := make([]Value, 0, len(value.items))
		for _, item := range value.items {
			decoded, err := codec.decodeValue(item)
			if err != nil {
				return Value{}, err
			}
			items = append(items, decoded)
		}
		return Array(items...), nil
	case KindObject:
		if hasKeys(value.fields, "$escape") {
			inner := value.fields[0].Value
			if inner.kind != KindObject {
				return Value{}, errors.New("$escape value must be an object")
			}
			fields := make([]Field, 0, len(inner.fields))
			for _, field := range inner.fields {
				decoded, err := codec.decodeValue(field.Value)
				if err != nil {
					return Value{}, err
				}
				fields = append(fields, Field{Key: field.Key, Value: decoded})
			}
			return Object(fields...), nil
		}
		fields := make([]Field, 0, len(value.fields))
		for _, field := range value.fields {
			decoded, err := codec.decodeValue(field.Value)
			if err != nil {
				return Value{}, err
			}
			fields = append(fields, Field{Key: field.Key, Value: decoded})
		}
		return codec.decodeObject(fields)
	default:
		return value, nil
	}
}

func (codec *Codec) decodeObject(fields []Field) (Value, error) {
	object := Object(fields...)
	if !tagShape(fields) {
		return object, nil
	}

	lookup := func(key string) Value { value, _ := object.Lookup(key); return value }
	switch {
	case hasKeys(fields, "$date"):
		millis, ok := lookup("$date").Integer()
		if !ok {
			return Value{}, errors.New("$date must be integer milliseconds")
		}
		return Date(millis), nil
	case hasKeys(fields, "$regexp", "$flags"):
		source, sourceOK := lookup("$regexp").Text()
		flags, flagsOK := lookup("$flags").Text()
		if !sourceOK || !flagsOK {
			return Value{}, errors.New("$regexp and $flags must be strings")
		}
		return Regex(source, sanitizeFlags(flags)), nil
	case hasKeys(fields, "$InfNaN"):
		sign, ok := lookup("$InfNaN").Number()
		if !ok {
			return Value{}, errors.New("$InfNaN must be a number")
		}
		switch sign {
		case 0:
			return Float(math.NaN()), nil
		case 1:
			return Float(math.Inf(1)), nil
		default:
			return Float(math.Inf(-1)), nil
		}
	case hasKeys(fields, "$binary"):
		encoded, ok := lookup("$binary").Text()
		if !ok {
			return Value{}, errors.New("$binary must be a string")
		}
		if len(encoded)%4 != 0 {
			return Value{}, errors.New("invalid base64 length")
		}
		encoded = strings.NewReplacer("-", "+", "_", "/").Replace(encoded)
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return Value{}, err
		}
		return Binary(data), nil
	case hasKeys(fields, "$type", "$value"):
		name, ok := lookup("$type").Text()
		if !ok {
			return Value{}, errors.New("$type must be a string")
		}
		codec.mu.RLock()
		factory := codec.factories[name]
		codec.mu.RUnlock()
		if factory == nil {
			return Value{}, fmt.Errorf("Custom EJSON type %s is not defined", name)
		}
		return factory(lookup("$value"))
	}
	return object, nil
}

func hasKeys(fields []Field, names ...string) bool {
	if len(fields) != len(names) {
		return false
	}
	for _, name := range names {
		found := false
		for _, field := range fields {
			if field.Key == name {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func tagShape(fields []Field) bool {
	return hasKeys(fields, "$date") || hasKeys(fields, "$regexp", "$flags") ||
		hasKeys(fields, "$InfNaN") || hasKeys(fields, "$binary") ||
		hasKeys(fields, "$escape") || hasKeys(fields, "$type", "$value")
}

func sanitizeFlags(source string) string {
	runes := []rune(source)
	if len(runes) > 50 {
		runes = runes[:50]
	}
	var result strings.Builder
	for index, flag := range runes {
		if !strings.ContainsRune(validRegexFlags, flag) {
			continue
		}
		if slices.Contains(runes[index+1:], flag) {
			continue
		}
		result.WriteRune(flag)
	}
	return result.String()
}

// Stringify emits TypeFerry's exact wire text. Canonical mode recursively
// sorts non-index keys by UTF-16 units; ordinary mode retains their insertion
// order. Both modes emit JavaScript array-index keys numerically first.
func (codec *Codec) Stringify(value Value, canonical bool) (string, error) {
	var output bytes.Buffer
	if err := writeValue(&output, value, canonical, false); err != nil {
		return "", err
	}
	return output.String(), nil
}

func writeValue(output *bytes.Buffer, value Value, canonical, escaped bool) error {
	switch value.kind {
	case KindNull:
		output.WriteString("null")
	case KindBool:
		output.WriteString(strconv.FormatBool(value.bool))
	case KindInt:
		output.WriteString(strconv.FormatInt(value.int, 10))
	case KindFloat:
		switch {
		case math.IsNaN(value.float):
			return writeTag(output, canonical, Field{Key: "$InfNaN", Value: Int(0)})
		case math.IsInf(value.float, 1):
			return writeTag(output, canonical, Field{Key: "$InfNaN", Value: Int(1)})
		case math.IsInf(value.float, -1):
			return writeTag(output, canonical, Field{Key: "$InfNaN", Value: Int(-1)})
		default:
			encoded, err := json.Marshal(value.float)
			if err != nil {
				return err
			}
			output.Write(encoded)
		}
	case KindString:
		return writeString(output, value.text)
	case KindArray:
		output.WriteByte('[')
		for index, item := range value.items {
			if index > 0 {
				output.WriteByte(',')
			}
			if err := writeValue(output, item, canonical, false); err != nil {
				return err
			}
		}
		output.WriteByte(']')
	case KindObject:
		if tagShape(value.fields) && !escaped {
			output.WriteString(`{"$escape":`)
			if err := writeValue(output, value, canonical, true); err != nil {
				return err
			}
			output.WriteByte('}')
			return nil
		}
		fields := orderedFields(value.fields, canonical)
		output.WriteByte('{')
		for index, field := range fields {
			if index > 0 {
				output.WriteByte(',')
			}
			if err := writeString(output, field.Key); err != nil {
				return err
			}
			output.WriteByte(':')
			if err := writeValue(output, field.Value, canonical, false); err != nil {
				return err
			}
		}
		output.WriteByte('}')
	case KindDate:
		return writeTag(output, canonical, Field{Key: "$date", Value: Int(value.int)})
	case KindBinary:
		return writeTag(output, canonical,
			Field{Key: "$binary", Value: String(base64.StdEncoding.EncodeToString(value.bytes))})
	case KindRegex:
		return writeTag(output, canonical,
			Field{Key: "$regexp", Value: String(value.text)},
			Field{Key: "$flags", Value: String(value.flags)})
	case KindCustom:
		if value.inner == nil {
			return errors.New("custom EJSON value has no inner value")
		}
		return writeTag(output, canonical,
			Field{Key: "$type", Value: String(value.text)},
			Field{Key: "$value", Value: *value.inner})
	default:
		return fmt.Errorf("unsupported EJSON kind %d", value.kind)
	}
	return nil
}

func writeTag(output *bytes.Buffer, canonical bool, fields ...Field) error {
	return writeValue(output, Object(fields...), canonical, true)
}

func writeString(output *bytes.Buffer, value string) error {
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return err
	}
	output.Truncate(output.Len() - 1)
	return nil
}

// JavaScript always enumerates array-index properties before other string
// properties. Canonical mode only changes the order of the remaining keys.
func orderedFields(source []Field, canonical bool) []Field {
	fields := slices.Clone(source)
	sort.SliceStable(fields, func(i, j int) bool {
		left, leftIndex := arrayIndex(fields[i].Key)
		right, rightIndex := arrayIndex(fields[j].Key)
		if leftIndex != rightIndex {
			return leftIndex
		}
		if leftIndex {
			return left < right
		}
		if canonical {
			return slices.Compare(utf16.Encode([]rune(fields[i].Key)), utf16.Encode([]rune(fields[j].Key))) < 0
		}
		return false
	})
	return fields
}

func arrayIndex(key string) (uint64, bool) {
	const reservedIndex = uint64(1<<32 - 1)

	index, err := strconv.ParseUint(key, 10, 32)
	return index, err == nil && index < reservedIndex && strconv.FormatUint(index, 10) == key
}
