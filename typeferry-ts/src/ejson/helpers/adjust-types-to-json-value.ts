/**
 * for both arrays and objects, in-place modification.
 */
import {
  MAX_EJSON_DEPTH,
  defineOwnProperty,
  isInfOrNaN,
  isObject,
  isObjectRecord,
  keysOf,
} from '../utils'
import { toJSONValueHelper } from './to-json-value-helper'

export const adjustTypesToJSONValue = (obj: unknown, depth = 0): unknown => {
  if (depth > MAX_EJSON_DEPTH) {
    throw new RangeError('Maximum EJSON nesting depth exceeded')
  }

  // Is it an atom that we need to adjust?
  if (obj === null) {
    return null
  }

  const maybeChanged = toJSONValueHelper(obj, depth)
  if (maybeChanged !== undefined) {
    return maybeChanged
  }

  // Other atoms are unchanged.
  if (!isObject(obj)) {
    return obj
  }

  // Iterate over array or object structure.
  if (!isObjectRecord(obj)) return obj

  keysOf(obj).forEach(key => {
    const value = obj[key]
    if (!isObject(value) && value !== undefined && !isInfOrNaN(value)) {
      return // continue
    }

    const changed = toJSONValueHelper(value, depth)
    if (changed !== undefined) {
      defineOwnProperty(obj, key, changed)
      return // on to the next key
    }
    // if we get here, value is an object but not adjustable
    // at this level.  recurse.
    adjustTypesToJSONValue(value, depth + 1)
  })
  return obj
}
