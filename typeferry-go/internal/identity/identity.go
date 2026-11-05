// Package identity keeps JavaScript authentication truthiness consistent across
// the runtime and transport-owned handshake callbacks.
package identity

import (
	"math"

	"github.com/leonardoventurini/typeferry/typeferry-go/ejson"
)

func Accepted(value ejson.Value) bool {
	switch value.Kind() {
	case ejson.KindNull:
		return false
	case ejson.KindBool:
		accepted, _ := value.Boolean()
		return accepted
	case ejson.KindInt, ejson.KindFloat:
		number, _ := value.Number()
		return number != 0 && !math.IsNaN(number)
	case ejson.KindString:
		text, _ := value.Text()
		return text != ""
	default:
		// JavaScript containers and tagged native objects remain truthy even
		// when their contents are empty or their numeric value is zero.
		return true
	}
}
