import { MAX_EJSON_DEPTH, defineOwnProperty } from './utils'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortJsonValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_EJSON_DEPTH) {
    throw new RangeError('Maximum EJSON nesting depth exceeded')
  }

  if (Array.isArray(value)) {
    return value.map(item => sortJsonValue(item, depth + 1))
  }

  if (!isPlainObject(value)) {
    return value
  }

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((accumulator, key) => {
      const child = value[key]

      if (child !== undefined) {
        defineOwnProperty(accumulator, key, sortJsonValue(child, depth + 1))
      }

      return accumulator
    }, {})
}

/**
 * Provides deterministic JSON output for EJSON canonical mode without relying
 * on a CommonJS dependency that breaks source-first browser consumers.
 */
export function stableStringify(
  value: unknown,
  space?: number | string,
): string {
  return JSON.stringify(sortJsonValue(value), null, space)
}
