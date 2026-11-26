import { adjustTypesFromJSONValue } from './adjust-types-from-json-value'
import { fromJSONValueHelper } from './helpers/from-json-value-helper'
import { EJSON } from './index'
import { MAX_EJSON_DEPTH, isObject } from './utils'

export const fromJSONValue = (item: unknown, depth = 0): unknown => {
  if (depth > MAX_EJSON_DEPTH) {
    throw new RangeError('Maximum EJSON nesting depth exceeded')
  }

  let changed = fromJSONValueHelper(item, depth)

  if (changed === item && isObject(item)) {
    changed = EJSON.clone(item)
    adjustTypesFromJSONValue(changed, depth)
  }

  return changed
}
