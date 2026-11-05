// Package ejson implements TypeFerry's ordered, lossless JSON extension.
//
// Ordinary objects emit JavaScript array-index keys first, then retain the
// insertion order of other keys. Canonical mode sorts other keys by UTF-16
// code units. TypeFerry cache keys use ordinary encoding. Tagged values use
// dedicated kinds; a plain object shaped like a tag is escaped on the wire. A Codec
// scopes custom-type factories to one application and is safe for concurrent
// parsing and registration.
package ejson
