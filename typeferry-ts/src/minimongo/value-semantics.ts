export interface ValueSemantics {
  clone<TValue>(value: TValue): TValue
  equals(left: unknown, right: unknown, options?: { readonly keyOrderSensitive?: boolean }): boolean
  compare(left: unknown, right: unknown, collator?: Intl.Collator): number
}

function isBinary(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasClone(value: Record<string, unknown>): value is Record<string, unknown> & {
  clone(): unknown
} {
  return typeof value.clone === 'function'
}

function cloneValue<TValue>(value: TValue): TValue {
  if (!isRecord(value)) return value
  if (value instanceof Date) return new Date(value.valueOf()) as TValue
  if (value instanceof RegExp) return new RegExp(value.source, value.flags) as TValue
  if (isBinary(value)) return value.slice() as TValue
  if (hasClone(value)) return value.clone() as TValue
  if (Array.isArray(value)) return value.map(item => cloneValue(item)) as TValue

  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    Object.defineProperty(result, key, {
      value: cloneValue(value[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }

  return result as TValue
}

function equalValues(
  left: unknown,
  right: unknown,
  keyOrderSensitive: boolean,
): boolean {
  if (left === right) return true
  if (Number.isNaN(left) && Number.isNaN(right)) return true
  if (typeof left !== typeof right) return false
  if (!isRecord(left) || !isRecord(right)) return false
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.valueOf() === right.valueOf()
  }
  if (isBinary(left) || isBinary(right)) {
    if (!isBinary(left) || !isBinary(right) || left.length !== right.length) return false

    return left.every((byte, index) => byte === right[index])
  }
  if (left instanceof RegExp || right instanceof RegExp) {
    return left instanceof RegExp
      && right instanceof RegExp
      && left.source === right.source
      && left.flags === right.flags
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false

    return left.every((value, index) => equalValues(value, right[index], keyOrderSensitive))
  }
  if (typeof (left as { equals?: unknown }).equals === 'function') {
    return Boolean((left as { equals(value: unknown): unknown }).equals(right))
  }

  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  if (keyOrderSensitive && leftKeys.some((key, index) => key !== rightKeys[index])) return false

  return leftKeys.every(key => Object.hasOwn(right, key)
    && equalValues(left[key], right[key], keyOrderSensitive))
}

const TYPE_ORDER = new Map<string, number>([
  ['undefined', -1],
  ['null', 0],
  ['number', 1],
  ['string', 2],
  ['object', 3],
  ['array', 4],
  ['binary', 5],
  ['boolean', 7],
  ['date', 8],
  ['regexp', 9],
])

function valueType(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (isBinary(value)) return 'binary'
  if (value instanceof Date) return 'date'
  if (value instanceof RegExp) return 'regexp'

  return typeof value
}

function compareValues(left: unknown, right: unknown, collator?: Intl.Collator): number {
  if (equalValues(left, right, true)) return 0

  const leftType = valueType(left)
  const rightType = valueType(right)
  const typeDifference = (TYPE_ORDER.get(leftType) ?? 100) - (TYPE_ORDER.get(rightType) ?? 100)
  if (typeDifference !== 0) return typeDifference < 0 ? -1 : 1

  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1
  if (typeof left === 'string' && typeof right === 'string') {
    const result = collator ? collator.compare(left, right) : left < right ? -1 : 1

    return Math.sign(result)
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') return left ? 1 : -1
  if (left instanceof Date && right instanceof Date) return left < right ? -1 : 1
  if (left instanceof RegExp && right instanceof RegExp) return left.toString() < right.toString() ? -1 : 1
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      const result = compareValues(left[index], right[index], collator)
      if (result !== 0) return result
    }

    return left.length < right.length ? -1 : 1
  }
  if (isBinary(left) && isBinary(right)) {
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      const difference = (left[index] ?? 0) - (right[index] ?? 0)
      if (difference !== 0) return difference < 0 ? -1 : 1
    }

    return left.length < right.length ? -1 : 1
  }
  if (isRecord(left) && isRecord(right)) {
    const leftEntries = Object.entries(left)
    const rightEntries = Object.entries(right)
    for (let index = 0; index < Math.min(leftEntries.length, rightEntries.length); index += 1) {
      const leftEntry = leftEntries[index]
      const rightEntry = rightEntries[index]
      if (!leftEntry || !rightEntry) continue
      if (leftEntry[0] !== rightEntry[0]) return leftEntry[0] < rightEntry[0] ? -1 : 1
      const result = compareValues(leftEntry[1], rightEntry[1], collator)
      if (result !== 0) return result
    }

    return leftEntries.length < rightEntries.length ? -1 : 1
  }

  return String(left) < String(right) ? -1 : 1
}

export const localValueSemantics: ValueSemantics = {
  clone: cloneValue,
  equals(left, right, options) {
    return equalValues(left, right, options?.keyOrderSensitive ?? false)
  },
  compare: compareValues,
}
