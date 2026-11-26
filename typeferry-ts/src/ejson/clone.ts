import { EJSON } from './index'
import {
  MAX_EJSON_DEPTH,
  defineOwnProperty,
  isArguments,
  isFunction,
  isObject,
  isObjectAndNotNull,
  keysOf,
} from './utils'

function clonePrimitive(val: any): { handled: boolean; result?: any } {
  if (!isObject(val)) return { handled: true, result: val }
  if (val === null) return { handled: true, result: null }
  if (val instanceof Date)
    return { handled: true, result: new Date(val.getTime()) }
  if (val instanceof RegExp) return { handled: true, result: val }
  return { handled: false }
}

function cloneSpecialTypes(
  val: any,
  internalClone: (v: any) => any,
): { handled: boolean; result?: any } {
  if (val._bsontype === 'ObjectId' && isFunction(val.toString)) {
    return { handled: true, result: val.toString() }
  }

  /**
   * Embedded documents have different constructors but share document storage
   * and state. Never visit their internal parent backlinks: doing so consumes
   * parent fields in the shared-reference guard before those fields are cloned.
   */
  if (
    (val.constructor?.name === 'model' || isObjectAndNotNull(val.$__)) &&
    isObjectAndNotNull(val._doc)
  ) {
    return { handled: true, result: internalClone(val._doc) }
  }

  if (EJSON.isBinary(val)) {
    const ret = EJSON.newBinary(val.length)
    for (let i = 0; i < val.length; i++) ret[i] = val[i] ?? 0
    return { handled: true, result: ret }
  }

  if (isFunction(val.clone)) {
    return { handled: true, result: val.clone() }
  }

  if (EJSON._isCustomType(val)) {
    return {
      handled: true,
      result: EJSON.fromJSONValue(internalClone(EJSON.toJSONValue(val))),
    }
  }

  return { handled: false }
}

export const clone = (rootVal: any) => {
  const set = new WeakSet()

  function cloneArray(arr: any[], depth: number) {
    set.add(arr)

    return arr
      .map(val => {
        if (isObjectAndNotNull(val)) {
          if (set.has(val as object)) return undefined
          set.add(val as object)
        }
        return internalClone(val, depth + 1)
      })
      .filter(val => val !== undefined)
  }

  function internalClone(internalVal: any, depth = 0): any {
    if (depth > MAX_EJSON_DEPTH) {
      throw new RangeError('Maximum EJSON nesting depth exceeded')
    }

    const primitiveResult = clonePrimitive(internalVal)
    if (primitiveResult.handled) return primitiveResult.result

    const specialResult = cloneSpecialTypes(internalVal, v =>
      internalClone(v, depth + 1),
    )
    if (specialResult.handled) return specialResult.result

    if (Array.isArray(internalVal)) return cloneArray(internalVal, depth)

    if (isArguments(internalVal)) {
      set.add(internalVal)
      return cloneArray(Array.from(internalVal), depth)
    }

    set.add(internalVal)

    const ret: Record<string, unknown> = {}
    keysOf(internalVal).forEach(key => {
      if (isObjectAndNotNull(internalVal[key])) {
        if (set.has(internalVal[key])) return
        set.add(internalVal[key])
      }
      defineOwnProperty(ret, key, internalClone(internalVal[key], depth + 1))
    })

    return ret
  }

  return internalClone(rootVal)
}
