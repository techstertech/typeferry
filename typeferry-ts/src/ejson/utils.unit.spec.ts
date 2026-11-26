import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import {
  checkError,
  convertMapToObject,
  handleError,
  hasOwn,
  isArguments,
  isFunction,
  isInfOrNaN,
  isObject,
  isObjectAndNotNull,
  keysOf,
  lengthOf,
  newBinary,
  quote,
} from './utils'

describe('isFunction', () => {
  it('returns true for a function declaration', () => {
    function foo() {}
    expect(isFunction(foo)).toBe(true)
  })

  it('returns true for an arrow function', () => {
    expect(isFunction(() => {})).toBe(true)
  })

  it('returns true for a class (classes are functions)', () => {
    class Foo {}
    expect(isFunction(Foo)).toBe(true)
  })

  it('returns false for a number', () => {
    expect(isFunction(42)).toBe(false)
  })

  it('returns false for a string', () => {
    expect(isFunction('hello')).toBe(false)
  })

  it('returns false for an object', () => {
    expect(isFunction({})).toBe(false)
  })

  it('returns false for null', () => {
    expect(isFunction(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isFunction(undefined)).toBe(false)
  })

  it('returns false for a boolean', () => {
    expect(isFunction(true)).toBe(false)
  })
})

describe('isObject', () => {
  it('returns true for a plain object', () => {
    expect(isObject({})).toBe(true)
  })

  it('returns true for an array', () => {
    expect(isObject([])).toBe(true)
  })

  it('returns true for null (typeof null === "object")', () => {
    expect(isObject(null)).toBe(true)
  })

  it('returns true for a Date', () => {
    expect(isObject(new Date())).toBe(true)
  })

  it('returns false for a number', () => {
    expect(isObject(42)).toBe(false)
  })

  it('returns false for a string', () => {
    expect(isObject('hello')).toBe(false)
  })

  it('returns false for a function', () => {
    expect(isObject(() => {})).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isObject(undefined)).toBe(false)
  })

  it('returns false for a boolean', () => {
    expect(isObject(true)).toBe(false)
  })
})

describe('keysOf', () => {
  it('returns the keys of an object', () => {
    expect(keysOf({ a: 1, b: 2, c: 3 })).toEqual(['a', 'b', 'c'])
  })

  it('returns an empty array for an empty object', () => {
    expect(keysOf({})).toEqual([])
  })

  it('does not include inherited properties', () => {
    const parent = { inherited: true }
    const child = Object.create(parent)
    child.own = true

    expect(keysOf(child)).toEqual(['own'])
  })
})

describe('lengthOf', () => {
  it('returns the number of own keys', () => {
    expect(lengthOf({ a: 1, b: 2, c: 3 })).toBe(3)
  })

  it('returns 0 for an empty object', () => {
    expect(lengthOf({})).toBe(0)
  })

  it('returns 1 for a single-key object', () => {
    expect(lengthOf({ key: 'value' })).toBe(1)
  })
})

describe('hasOwn', () => {
  it('returns true for own properties', () => {
    expect(hasOwn({ a: 1 }, 'a')).toBe(true)
  })

  it('returns false for non-existent properties', () => {
    expect(hasOwn({ a: 1 }, 'b')).toBe(false)
  })

  it('returns false for inherited properties', () => {
    const parent = { inherited: true }
    const child = Object.create(parent)

    expect(hasOwn(child, 'inherited')).toBe(false)
  })

  it('returns true for own properties with undefined value', () => {
    expect(hasOwn({ a: undefined }, 'a')).toBe(true)
  })

  it('works with Object.create(null) objects', () => {
    const obj = Object.create(null)
    obj.key = 'value'

    expect(hasOwn(obj, 'key')).toBe(true)
    expect(hasOwn(obj, 'toString')).toBe(false)
  })
})

describe('convertMapToObject', () => {
  it('converts a Map to a plain object', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
    ])

    expect(convertMapToObject(map)).toEqual({ a: 1, b: 2 })
  })

  it('returns an empty object for an empty Map', () => {
    expect(convertMapToObject(new Map())).toEqual({})
  })

  it('preserves complex values', () => {
    const map = new Map<string, any>([
      ['obj', { nested: true }],
      ['arr', [1, 2, 3]],
    ])
    const result = convertMapToObject(map)

    expect(result).toEqual({ obj: { nested: true }, arr: [1, 2, 3] })
  })
})

describe('isArguments', () => {
  it('returns true for genuine JS arguments objects', () => {
    function capture(..._items: unknown[]) {
      return arguments
    }
    expect(isArguments(capture(1, 2))).toBe(true)
  })

  it('returns false for plain objects with a callee property (OOM prevention)', () => {
    expect(isArguments({ callee: () => {}, length: 2 })).toBe(false)
  })

  it('returns false for plain objects without callee', () => {
    expect(isArguments({ a: 1 })).toBe(false)
  })

  it('returns false for null', () => {
    expect(isArguments(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isArguments(undefined)).toBe(false)
  })

  it('returns false when callee is a non-function on a plain object', () => {
    expect(isArguments({ callee: 'not-a-function' })).toBe(false)
  })
})

describe('isInfOrNaN', () => {
  it('returns true for NaN', () => {
    expect(isInfOrNaN(NaN)).toBe(true)
  })

  it('returns true for Infinity', () => {
    expect(isInfOrNaN(Infinity)).toBe(true)
  })

  it('returns true for -Infinity', () => {
    expect(isInfOrNaN(-Infinity)).toBe(true)
  })

  it('returns false for a normal number', () => {
    expect(isInfOrNaN(42)).toBe(false)
  })

  it('returns false for zero', () => {
    expect(isInfOrNaN(0)).toBe(false)
  })

  it('returns false for a negative number', () => {
    expect(isInfOrNaN(-5)).toBe(false)
  })

  it('returns false for a string', () => {
    expect(isInfOrNaN('NaN')).toBe(false)
  })
})

describe('checkError', () => {
  describe('maxStack', () => {
    it('returns true for "Maximum call stack size exceeded" message', () => {
      expect(checkError.maxStack('Maximum call stack size exceeded')).toBe(true)
    })

    it('returns true when the message contains the stack overflow text', () => {
      expect(
        checkError.maxStack(
          'Error: Maximum call stack size exceeded at foo',
        ),
      ).toBe(true)
    })

    it('returns false for unrelated error messages', () => {
      expect(checkError.maxStack('Something else went wrong')).toBe(false)
    })

    it('returns false for an empty string', () => {
      expect(checkError.maxStack('')).toBe(false)
    })
  })
})

describe('handleError', () => {
  it('returns the function result when no error is thrown', () => {
    const fn = (a: number, b: number) => a + b
    const wrapped = handleError(fn)

    expect(wrapped(2, 3)).toBe(5)
  })

  it('converts max stack errors to circular structure errors', () => {
    const fn = () => {
      throw new Error('Maximum call stack size exceeded')
    }
    const wrapped = handleError(fn)

    expect(() => wrapped()).toThrow('Converting circular structure to JSON')
  })

  it('re-throws non-stack-overflow errors as-is', () => {
    const fn = () => {
      throw new Error('Some other error')
    }
    const wrapped = handleError(fn)

    expect(() => wrapped()).toThrow('Some other error')
  })

  it('re-throws the exact same error object for non-stack-overflow errors', () => {
    const originalError = new TypeError('custom type error')
    const fn = () => {
      throw originalError
    }
    const wrapped = handleError(fn)

    try {
      wrapped()
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBe(originalError)
    }
  })

  it('preserves the this context', () => {
    const obj = {
      value: 42,
      getValue: handleError(function (this: any) {
        return this.value
      }),
    }

    expect(obj.getValue()).toBe(42)
  })

  it('passes arguments through to the wrapped function', () => {
    const fn = (a: string, b: string) => `${a}-${b}`
    const wrapped = handleError(fn)

    expect(wrapped('hello', 'world')).toBe('hello-world')
  })
})

describe('quote', () => {
  it('wraps a string in double quotes via JSON.stringify', () => {
    expect(quote('hello')).toBe('"hello"')
  })

  it('escapes special characters', () => {
    expect(quote('a "quoted" string')).toBe('"a \\"quoted\\" string"')
  })

  it('handles an empty string', () => {
    expect(quote('')).toBe('""')
  })

  it('escapes newlines', () => {
    expect(quote('line1\nline2')).toBe('"line1\\nline2"')
  })

  it('escapes backslashes', () => {
    expect(quote('back\\slash')).toBe('"back\\\\slash"')
  })
})

describe('newBinary', () => {
  it('returns a Uint8Array of the specified length', () => {
    const result = newBinary(10)

    expect(result).toBeInstanceOf(Uint8Array)
    expect(result.length).toBe(10)
  })

  it('initializes all bytes to zero', () => {
    const result = newBinary(5) as Uint8Array

    for (let i = 0; i < result.length; i++) {
      expect(result[i]).toBe(0)
    }
  })

  it('returns a zero-length Uint8Array for len=0', () => {
    const result = newBinary(0)
    expect(result.length).toBe(0)
  })

  it('is backed by an ArrayBuffer', () => {
    const result = newBinary(8) as Uint8Array
    expect(result.buffer).toBeInstanceOf(ArrayBuffer)
  })

  it('returns a polyfilled array when Uint8Array is undefined', () => {
    const origUint8Array = globalThis.Uint8Array
    const origArrayBuffer = globalThis.ArrayBuffer

    // Temporarily remove Uint8Array and ArrayBuffer.
    vi.stubGlobal('Uint8Array', undefined)
    vi.stubGlobal('ArrayBuffer', undefined)

    try {
      const result = newBinary(3)

      // Should be a plain array
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBe(3)
      expect(result[0]!).toBe(0)
      expect(result[1]!).toBe(0)
      expect(result[2]!).toBe(0)

      // Should have the polyfill flag
      expect((result as any).$Uint8ArrayPolyfill).toBe(true)
    } finally {
      // Restore
      vi.stubGlobal('Uint8Array', origUint8Array)
      vi.stubGlobal('ArrayBuffer', origArrayBuffer)
      vi.unstubAllGlobals()
    }
  })
})

describe('isObjectAndNotNull', () => {
  it('returns true for a plain object', () => {
    expect(isObjectAndNotNull({})).toBe(true)
  })

  it('returns true for an array', () => {
    expect(isObjectAndNotNull([])).toBe(true)
  })

  it('returns false for null', () => {
    expect(isObjectAndNotNull(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isObjectAndNotNull(undefined)).toBe(false)
  })

  it('returns false for a number', () => {
    expect(isObjectAndNotNull(42)).toBe(false)
  })

  it('returns false for a string', () => {
    expect(isObjectAndNotNull('hello')).toBe(false)
  })
})
