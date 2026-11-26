export type DynamicFunction = (
  this: unknown,
  ...args: unknown[]
) => unknown

export const isFunction = (value: unknown): value is DynamicFunction =>
  typeof value === 'function'

export const isObject = (value: unknown): boolean => typeof value === 'object'

export const isObjectRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'

export const keysOf = (value: object): string[] => Object.keys(value)

export const lengthOf = (value: object): number => Object.keys(value).length

export const hasOwn = (value: object, property: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, property)

export function convertMapToObject<TKey extends PropertyKey, TValue>(
  map: ReadonlyMap<TKey, TValue>,
): Record<TKey, TValue> {
  const result = {} as Record<TKey, TValue>

  for (const [key, value] of map) result[key] = value

  return result
}

export const MAX_EJSON_DEPTH = 128

export function defineOwnProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

export const isArguments = (value: unknown): value is IArguments =>
  Object.prototype.toString.call(value) === '[object Arguments]'

export const isInfOrNaN = (value: unknown): boolean =>
  typeof value === 'number' &&
  (Number.isNaN(value) || value === Infinity || value === -Infinity)

export const checkError = {
  maxStack: (message: string): boolean =>
    new RegExp('Maximum call stack size exceeded', 'g').test(message),
}

export function handleError<TThis, TArguments extends unknown[], TResult>(
  fn: (this: TThis, ...args: TArguments) => TResult,
): (this: TThis, ...args: TArguments) => TResult {
  return function (this: TThis, ...args: TArguments): TResult {
    try {
      return fn.apply(this, args)
    } catch (error) {
      if (
        error instanceof Error &&
        checkError.maxStack(error.message)
      ) {
        throw new Error('Converting circular structure to JSON')
      }

      throw error
    }
  }
}

export const quote = (value: string): string => JSON.stringify(value)

export type PolyfillableArray = Array<number> & {
  $Uint8ArrayPolyfill?: boolean
}

export function newBinary(length: number): PolyfillableArray | Uint8Array {
  if (typeof Uint8Array === 'undefined' || typeof ArrayBuffer === 'undefined') {
    const result: PolyfillableArray = []

    for (let index = 0; index < length; index++) result.push(0)

    result.$Uint8ArrayPolyfill = true

    return result
  }

  return new Uint8Array(new ArrayBuffer(length))
}

export const isObjectAndNotNull = (value: unknown): value is object =>
  value !== null && typeof value === 'object'
