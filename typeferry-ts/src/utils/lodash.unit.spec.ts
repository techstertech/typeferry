import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isEmpty,
  isPlainObject,
  merge,
  omit,
  pick,
  range,
  throttle,
} from './lodash'

describe('isPlainObject', () => {
  it('returns true for a plain object literal', () => {
    expect(isPlainObject({ a: 1 })).toBe(true)
  })

  it('returns true for an empty object literal', () => {
    expect(isPlainObject({})).toBe(true)
  })

  it('returns true for Object.create(null)', () => {
    expect(isPlainObject(Object.create(null))).toBe(true)
  })

  it('returns false for null', () => {
    expect(isPlainObject(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isPlainObject(undefined)).toBe(false)
  })

  it('returns false for an array', () => {
    expect(isPlainObject([1, 2, 3])).toBe(false)
  })

  it('returns false for a Date', () => {
    expect(isPlainObject(new Date())).toBe(false)
  })

  it('returns false for a number', () => {
    expect(isPlainObject(42)).toBe(false)
  })

  it('returns false for a string', () => {
    expect(isPlainObject('hello')).toBe(false)
  })

  it('returns false for a class instance', () => {
    class Foo {}
    expect(isPlainObject(new Foo())).toBe(false)
  })

  it('returns false for a RegExp', () => {
    expect(isPlainObject(/test/)).toBe(false)
  })

  it('returns false for a function', () => {
    expect(isPlainObject(() => {})).toBe(false)
  })
})

describe('isEmpty', () => {
  it('returns true for null', () => {
    expect(isEmpty(null)).toBe(true)
  })

  it('returns true for undefined', () => {
    expect(isEmpty(undefined)).toBe(true)
  })

  it('returns true for an empty string', () => {
    expect(isEmpty('')).toBe(true)
  })

  it('returns true for an empty array', () => {
    expect(isEmpty([])).toBe(true)
  })

  it('returns true for an empty object', () => {
    expect(isEmpty({})).toBe(true)
  })

  it('returns false for a non-empty string', () => {
    expect(isEmpty('hello')).toBe(false)
  })

  it('returns false for a non-empty array', () => {
    expect(isEmpty([1])).toBe(false)
  })

  it('returns false for a non-empty object', () => {
    expect(isEmpty({ a: 1 })).toBe(false)
  })

  it('returns false for the number 0', () => {
    expect(isEmpty(0)).toBe(false)
  })

  it('returns false for boolean false', () => {
    expect(isEmpty(false)).toBe(false)
  })

  it('returns false for a positive number', () => {
    expect(isEmpty(42)).toBe(false)
  })

  it('returns false for boolean true', () => {
    expect(isEmpty(true)).toBe(false)
  })
})

describe('merge', () => {
  it('deep merges two objects', () => {
    const target = { a: 1, b: { c: 2 } }
    const source = { b: { d: 3 }, e: 4 }
    const result = merge(target, source)

    expect(result).toEqual({ a: 1, b: { c: 2, d: 3 }, e: 4 })
  })

  it('returns the target object (mutates it)', () => {
    const target = { a: 1 }
    const source = { b: 2 }
    const result = merge(target, source)

    expect(result).toBe(target)
  })

  it('skips undefined source values', () => {
    const target = { a: 1, b: 2 }
    const source = { a: undefined, b: 3 }
    const result = merge(target, source)

    expect(result).toEqual({ a: 1, b: 3 })
  })

  it('handles multiple sources', () => {
    const target = { a: 1 }
    const result = merge(target, { b: 2 }, { c: 3 })

    expect(result).toEqual({ a: 1, b: 2, c: 3 })
  })

  it('deeply merges nested objects', () => {
    const target = { a: { b: { c: 1 } } }
    const source = { a: { b: { d: 2 } } }
    const result = merge(target, source)

    expect(result).toEqual({ a: { b: { c: 1, d: 2 } } })
  })

  it('replaces arrays rather than merging them', () => {
    const target = { arr: [1, 2, 3] }
    const source = { arr: [4, 5] }
    const result = merge(target, source)

    expect(result).toEqual({ arr: [4, 5] })
  })

  it('overwrites primitives with objects', () => {
    const target = { a: 1 } as any
    const source = { a: { nested: true } }
    const result = merge(target, source)

    expect(result).toEqual({ a: { nested: true } })
  })

  it('overwrites objects with primitives', () => {
    const target = { a: { nested: true } } as any
    const source = { a: 42 }
    const result = merge(target, source)

    expect(result).toEqual({ a: 42 })
  })

  it('handles an empty source', () => {
    const target = { a: 1 }
    const result = merge(target, {})

    expect(result).toEqual({ a: 1 })
  })

  it('later sources override earlier ones', () => {
    const target = { a: 1 }
    const result = merge(target, { a: 2 }, { a: 3 })

    expect(result).toEqual({ a: 3 })
  })

  it('ignores __proto__, constructor, and prototype keys to prevent prototype pollution', () => {
    const target: Record<string, unknown> = { safe: 1 }
    const malicious = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"pollutedCtor":true}},"prototype":{"pollutedProto":true}}',
    ) as Record<string, unknown>

    const result = merge(target, malicious)

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(({} as Record<string, unknown>)['pollutedCtor']).toBeUndefined()
    expect(({} as Record<string, unknown>)['pollutedProto']).toBeUndefined()
    expect(result).toEqual({ safe: 1 })
  })
})

describe('throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls the function immediately on leading edge by default', () => {
    const fn = vi.fn()
    const throttled = throttle(fn, 100)

    throttled()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('throttles subsequent calls within the wait period', () => {
    const fn = vi.fn()
    const throttled = throttle(fn, 100)

    throttled()
    throttled()
    throttled()

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('fires trailing call after wait period', () => {
    const fn = vi.fn()
    const throttled = throttle(fn, 100)

    throttled('first')
    throttled('second')

    vi.advanceTimersByTime(100)

    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith('second')
  })

  it('allows another call after the wait period expires', () => {
    const fn = vi.fn()
    const throttled = throttle(fn, 100)

    throttled()
    vi.advanceTimersByTime(100)

    throttled()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('cancel() prevents pending trailing invocation', () => {
    const fn = vi.fn()
    const throttled = throttle(fn, 100)

    throttled('first')
    throttled('second')
    throttled.cancel()

    vi.advanceTimersByTime(200)

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('first')
  })

  it('respects leading: false option by not calling immediately', () => {
    const fn = vi.fn()
    const throttled = throttle(fn, 100, { leading: false })

    // With leading:false, the function should not be called immediately
    throttled('first')
    expect(fn).not.toHaveBeenCalled()
  })

  it('fires trailing call when leading is false', () => {
    const fn = vi.fn()
    const throttled = throttle(fn, 100, { leading: false })

    throttled('first')
    expect(fn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenLastCalledWith('first')
  })

  it('respects trailing: false option', () => {
    const fn = vi.fn()
    const throttled = throttle(fn, 100, { trailing: false })

    throttled('first')
    throttled('second')

    vi.advanceTimersByTime(200)

    // With trailing:false, the trailing call should not fire
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('first')
  })

  it('cancel() resets internal state allowing immediate re-invocation', () => {
    const fn = vi.fn()
    const throttled = throttle(fn, 100)

    throttled()
    expect(fn).toHaveBeenCalledTimes(1)

    throttled.cancel()

    // After cancel, lastCallTime is reset, so remaining <= 0
    throttled()
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('range', () => {
  it('generates a range from 0 to n-1 with one argument', () => {
    expect(range(5)).toEqual([0, 1, 2, 3, 4])
  })

  it('generates a range from start to end-1 with two arguments', () => {
    expect(range(2, 5)).toEqual([2, 3, 4])
  })

  it('returns an empty array for range(0)', () => {
    expect(range(0)).toEqual([])
  })

  it('returns an empty array when start equals end', () => {
    expect(range(3, 3)).toEqual([])
  })

  it('generates a single-element range', () => {
    expect(range(1)).toEqual([0])
  })

  it('generates range(0, 1)', () => {
    expect(range(0, 1)).toEqual([0])
  })
})

describe('omit', () => {
  it('removes specified keys from an object', () => {
    const obj = { a: 1, b: 2, c: 3 }
    expect(omit(obj, ['b'])).toEqual({ a: 1, c: 3 })
  })

  it('returns a new object', () => {
    const obj = { a: 1, b: 2 }
    const result = omit(obj, ['b'])

    expect(result).not.toBe(obj)
  })

  it('does not modify the original object', () => {
    const obj = { a: 1, b: 2, c: 3 }
    omit(obj, ['b'])

    expect(obj).toEqual({ a: 1, b: 2, c: 3 })
  })

  it('handles omitting multiple keys', () => {
    const obj = { a: 1, b: 2, c: 3, d: 4 }
    expect(omit(obj, ['a', 'c'])).toEqual({ b: 2, d: 4 })
  })

  it('handles omitting non-existent keys gracefully', () => {
    const obj = { a: 1, b: 2 } as any
    expect(omit(obj, ['z'])).toEqual({ a: 1, b: 2 })
  })

  it('returns a copy when no keys are omitted', () => {
    const obj = { a: 1 }
    const result = omit(obj, [])

    expect(result).toEqual({ a: 1 })
    expect(result).not.toBe(obj)
  })
})

describe('pick', () => {
  it('keeps only the specified keys', () => {
    const obj = { a: 1, b: 2, c: 3 }
    expect(pick(obj, ['a', 'c'])).toEqual({ a: 1, c: 3 })
  })

  it('returns a new object', () => {
    const obj = { a: 1, b: 2 }
    const result = pick(obj, ['a'])

    expect(result).not.toBe(obj)
  })

  it('skips keys that do not exist on the object', () => {
    const obj = { a: 1, b: 2 } as any
    expect(pick(obj, ['a', 'z'])).toEqual({ a: 1 })
  })

  it('returns an empty object when no keys match', () => {
    const obj = { a: 1 } as any
    expect(pick(obj, ['x', 'y'])).toEqual({})
  })

  it('returns an empty object for empty keys array', () => {
    const obj = { a: 1, b: 2 }
    expect(pick(obj, [])).toEqual({})
  })

  it('preserves values of picked keys', () => {
    const obj = { a: { nested: true }, b: [1, 2] }
    const result = pick(obj, ['a', 'b'])

    expect(result.a).toBe(obj.a)
    expect(result.b).toBe(obj.b)
  })
})
