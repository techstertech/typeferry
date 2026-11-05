package websocket

import (
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"

	"github.com/leonardoventurini/typeferry/typeferry-go/ejson"
)

const maxMetaBytes = 10000

func parseMeta(raw string) ejson.Value {
	if raw == "" || len(raw) > maxMetaBytes {
		return ejson.Object()
	}

	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	value, err := readMetaValue(decoder)
	if err != nil || value.Kind() != ejson.KindObject {
		return ejson.Object()
	}
	if _, err := decoder.Token(); err != io.EOF {
		return ejson.Object()
	}
	return value
}

// Metadata is JSON, not EJSON. Read ordered fields directly so tag-shaped
// objects remain literal and duplicate keys retain their first insertion slot.
func readMetaValue(decoder *json.Decoder) (ejson.Value, error) {
	token, err := decoder.Token()
	if err != nil {
		return ejson.Value{}, err
	}
	switch value := token.(type) {
	case nil:
		return ejson.Null(), nil
	case bool:
		return ejson.Bool(value), nil
	case string:
		return ejson.String(value), nil
	case json.Number:
		if integer, err := value.Int64(); err == nil {
			return ejson.Int(integer), nil
		}
		number, err := value.Float64()
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return ejson.Value{}, err
		}
		return ejson.Float(number), nil
	case json.Delim:
		if value == '[' {
			var items []ejson.Value
			for decoder.More() {
				item, err := readMetaValue(decoder)
				if err != nil {
					return ejson.Value{}, err
				}
				items = append(items, item)
			}
			_, err := decoder.Token()
			return ejson.Array(items...), err
		}
		if value == '{' {
			var fields []ejson.Field
			positions := make(map[string]int)
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return ejson.Value{}, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return ejson.Value{}, errors.New("metadata key must be a string")
				}
				item, err := readMetaValue(decoder)
				if err != nil {
					return ejson.Value{}, err
				}
				if index, found := positions[key]; found {
					fields[index].Value = item
				} else {
					positions[key] = len(fields)
					fields = append(fields, ejson.Field{Key: key, Value: item})
				}
			}
			_, err := decoder.Token()
			return ejson.Object(fields...), err
		}
	}
	return ejson.Value{}, errors.New("invalid JSON metadata")
}
