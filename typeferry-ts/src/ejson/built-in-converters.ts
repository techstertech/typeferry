import { decodeBase64, encodeBase64 } from './base64'
import { customTypes } from './custom-types'
import { EJSON } from './index'
import { MAX_EJSON_DEPTH, defineOwnProperty, hasOwn, isInfOrNaN, keysOf, lengthOf } from './utils'

type EJSONRecord = Record<string, unknown>

interface CustomEJSONValue {
  typeName(): string
  toJSONValue(): unknown
}

export interface EJSONConverter {
  matchJSONValue(value: unknown): boolean
  matchObject(value: unknown): boolean
  toJSONValue(value: unknown, depth?: number): unknown
  fromJSONValue(value: unknown, depth?: number): unknown
}

function isRecord(value: unknown): value is EJSONRecord {
  return typeof value === 'object' && value !== null
}

function requireRecord(value: unknown): EJSONRecord {
  if (!isRecord(value)) throw new TypeError('Invalid EJSON converter input')

  return value
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Invalid EJSON string value')

  return value
}

export const dateConverter = {
    matchJSONValue: value =>
      isRecord(value) && hasOwn(value, '$date') && lengthOf(value) === 1,
    matchObject: value => value instanceof Date,
    toJSONValue: value => {
      if (!(value instanceof Date)) throw new TypeError('Expected Date')

      return { $date: value.getTime() }
    },
    fromJSONValue: value => new Date(Number(requireRecord(value)['$date'])),
} satisfies EJSONConverter

export const regexpConverter = {
    matchJSONValue: value =>
      isRecord(value) &&
      hasOwn(value, '$regexp') &&
      hasOwn(value, '$flags') &&
      lengthOf(value) === 2,
    matchObject: value => value instanceof RegExp,
    toJSONValue: value => {
      if (!(value instanceof RegExp)) throw new TypeError('Expected RegExp')

      return { $regexp: value.source, $flags: value.flags }
    },
    fromJSONValue: value => {
      const record = requireRecord(value)
      const pattern = requireString(record['$regexp'])
      const flags = requireString(record['$flags'])
        .slice(0, 50)
        .replace(/[^gimuy]/g, '')
        .replace(/(.)(?=.*\1)/g, '')

      // eslint-disable-next-line security/detect-non-literal-regexp -- intentional EJSON deserialization
      return new RegExp(pattern, flags)
    },
} satisfies EJSONConverter

export const infNaNConverter = {
    matchJSONValue: value =>
      isRecord(value) && hasOwn(value, '$InfNaN') && lengthOf(value) === 1,
    matchObject: isInfOrNaN,
    toJSONValue: value => ({
      $InfNaN: Number.isNaN(value) ? 0 : value === Infinity ? 1 : -1,
    }),
    fromJSONValue: value => Number(requireRecord(value)['$InfNaN']) / 0,
} satisfies EJSONConverter

export const binaryConverter = {
    matchJSONValue: value =>
      isRecord(value) && hasOwn(value, '$binary') && lengthOf(value) === 1,
    matchObject: value => EJSON.isBinary(value),
    toJSONValue: value => {
      if (!EJSON.isBinary(value)) throw new TypeError('Expected EJSON binary')

      return { $binary: encodeBase64(value) }
    },
    fromJSONValue: value =>
      decodeBase64(requireString(requireRecord(value)['$binary'])),
} satisfies EJSONConverter

export const escapeConverter = {
    matchJSONValue: value =>
      isRecord(value) && hasOwn(value, '$escape') && lengthOf(value) === 1,
    matchObject: value => {
      if (!isRecord(value)) return false

      const keyCount = lengthOf(value)

      return (
        (keyCount === 1 || keyCount === 2) &&
        builtinConverters.some(converter => converter.matchJSONValue(value))
      )
    },
    toJSONValue: (value, depth = 0) => {
      if (depth > MAX_EJSON_DEPTH) {
        throw new RangeError('Maximum EJSON nesting depth exceeded')
      }

      const record = requireRecord(value)
      const escaped: EJSONRecord = {}

      for (const key of keysOf(record)) {
        defineOwnProperty(escaped, key, EJSON.toJSONValue(record[key], depth + 1))
      }

      return { $escape: escaped }
    },
    fromJSONValue: (value, depth = 0) => {
      if (depth > MAX_EJSON_DEPTH) {
        throw new RangeError('Maximum EJSON nesting depth exceeded')
      }

      const escaped = requireRecord(requireRecord(value)['$escape'])
      const result: EJSONRecord = {}

      for (const key of keysOf(escaped)) {
        defineOwnProperty(result, key, EJSON.fromJSONValue(escaped[key], depth + 2))
      }

      return result
    },
} satisfies EJSONConverter

export const customConverter = {
    matchJSONValue: value =>
      isRecord(value) &&
      hasOwn(value, '$type') &&
      hasOwn(value, '$value') &&
      lengthOf(value) === 2,
    matchObject: value => EJSON._isCustomType(value),
    toJSONValue: value => {
      const custom = value as CustomEJSONValue

      return { $type: custom.typeName(), $value: custom.toJSONValue() }
    },
    fromJSONValue: value => {
      const record = requireRecord(value)
      const typeName = requireString(record['$type'])
      const factory = customTypes.get(typeName)

      if (!factory) throw new Error(`Custom EJSON type ${typeName} is not defined`)

      return factory(record['$value'])
    },
} satisfies EJSONConverter

export const builtinConverters: readonly EJSONConverter[] = [
  dateConverter,
  regexpConverter,
  infNaNConverter,
  binaryConverter,
  escapeConverter,
  customConverter,
]
