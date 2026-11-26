import { describe, expect, it } from 'vitest'

import { EJSON } from './index'

describe('EJSON security hardening', () => {
  it('does not treat plain objects with a callee property as Arguments', () => {
    const payload = '{"callee":1,"length":200000000}'
    const decoded = EJSON.parse(payload) as Record<string, unknown>

    expect(decoded).toEqual({ callee: 1, length: 200_000_000 })
    expect(Array.isArray(decoded)).toBe(false)
  })

  it('prevents __proto__ override in EJSON.parse and $escape', () => {
    const plain = EJSON.parse('{"__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >
    expect(Object.getPrototypeOf(plain)).toBe(Object.prototype)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    expect(Object.hasOwn(plain, '__proto__')).toBe(true)

    const escaped = EJSON.parse(
      '{"$escape":{"__proto__":{"$date":0}}}',
    ) as Record<string, unknown>
    expect(escaped instanceof Date).toBe(false)
    expect(Object.getPrototypeOf(escaped)).toBe(Object.prototype)
    expect(() => EJSON.stringify(escaped, { canonical: true })).not.toThrow()
  })

  it('enforces a maximum recursion depth instead of overflowing the call stack', () => {
    const depth = 160
    const deepJson = '['.repeat(depth) + '1' + ']'.repeat(depth)

    expect(() => EJSON.parse(deepJson)).toThrow(/depth/i)

    let deepObject: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < depth; i++) deepObject = { nested: deepObject }
    expect(() => EJSON.stringify(deepObject, { canonical: true })).toThrow(
      /depth/i,
    )
  })
})
