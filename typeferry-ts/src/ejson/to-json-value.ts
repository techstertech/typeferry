import { adjustTypesToJSONValue } from './helpers/adjust-types-to-json-value'
import { toJSONValueHelper } from './helpers/to-json-value-helper'
import { EJSON } from './index'
import { MAX_EJSON_DEPTH, isObject } from './utils'

export const toJSONValue = (item: unknown, depth = 0): unknown => {
  if (depth > MAX_EJSON_DEPTH) {
    throw new RangeError('Maximum EJSON nesting depth exceeded')
  }

  const changed = toJSONValueHelper(item, depth)
  if (changed !== undefined) {
    return changed
  }

  let newItem = item

  if (isObject(item)) {
    newItem = EJSON.clone(item)
    adjustTypesToJSONValue(newItem, depth)
  }

  return newItem
}
