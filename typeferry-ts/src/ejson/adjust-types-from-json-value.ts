/**
 * for both arrays and objects. Tries its best to just
 * use the object you hand it, but may return something
 * different if the object you hand it itself needs changing.
 */
import { fromJSONValueHelper } from './helpers/from-json-value-helper'
import {
  MAX_EJSON_DEPTH,
  defineOwnProperty,
  isObject,
  isObjectRecord,
  keysOf,
} from './utils'

export const adjustTypesFromJSONValue = (obj: unknown, depth = 0): unknown => {
  if (depth > MAX_EJSON_DEPTH) {
    throw new RangeError('Maximum EJSON nesting depth exceeded')
  }

  if (obj === null) {
    return null
  }

  const maybeChanged = fromJSONValueHelper(obj, depth)
  if (maybeChanged !== obj) {
    return maybeChanged
  }

  // Other atoms are unchanged.
  if (!isObject(obj)) {
    return obj
  }

  if (!isObjectRecord(obj)) return obj

  keysOf(obj).forEach(key => {
    const value = obj[key]
    if (isObject(value)) {
      const changed = fromJSONValueHelper(value, depth)
      if (value !== changed) {
        defineOwnProperty(obj, key, changed)
        return
      }
      // if we get here, value is an object but not adjustable
      // at this level.  recurse.
      adjustTypesFromJSONValue(value, depth + 1)
    }
  })
  return obj
}
