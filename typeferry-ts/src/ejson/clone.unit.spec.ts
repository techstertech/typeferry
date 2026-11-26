import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { EJSON } from './index'
import { clone } from './clone'

describe('clone', () => {
  describe('primitives', () => {
    it('returns numbers as-is', () => {
      expect(clone(42)).toBe(42)
    })

    it('returns strings as-is', () => {
      expect(clone('hello')).toBe('hello')
    })

    it('returns booleans as-is', () => {
      expect(clone(true)).toBe(true)
      expect(clone(false)).toBe(false)
    })

    it('returns undefined as-is', () => {
      expect(clone(undefined)).toBeUndefined()
    })

    it('returns null as-is', () => {
      expect(clone(null)).toBeNull()
    })
  })

  describe('Date', () => {
    it('clones a Date to a new instance with the same time', () => {
      const d = new Date('2024-06-15')
      const cloned = clone(d)
      expect(cloned).toEqual(d)
      expect(cloned).not.toBe(d)
      expect(cloned).toBeInstanceOf(Date)
    })
  })

  describe('RegExp', () => {
    it('returns the same RegExp reference', () => {
      const r = /test/gi
      const cloned = clone(r)
      // clonePrimitive returns { handled: true, result: val } for RegExp
      expect(cloned).toBe(r)
    })
  })

  describe('arrays', () => {
    it('clones a simple array', () => {
      const arr = [1, 2, 3]
      const cloned = clone(arr)
      expect(cloned).toEqual([1, 2, 3])
      expect(cloned).not.toBe(arr)
    })

    it('deep clones nested arrays', () => {
      const inner = [1, 2]
      const arr = [inner, 3]
      const cloned = clone(arr)
      expect(cloned).toEqual([[1, 2], 3])
      expect(cloned[0]!).not.toBe(inner)
    })

    it('handles circular references in arrays by removing them', () => {
      const arr: any[] = [1, 2]
      arr.push(arr)
      const cloned = clone(arr)
      // The circular reference should be filtered out
      expect(cloned).toEqual([1, 2])
    })
  })

  describe('plain objects', () => {
    it('clones a simple object', () => {
      const obj = { a: 1, b: 'two' }
      const cloned = clone(obj)
      expect(cloned).toEqual({ a: 1, b: 'two' })
      expect(cloned).not.toBe(obj)
    })

    it('deep clones nested objects', () => {
      const obj = { a: { b: { c: 3 } } }
      const cloned = clone(obj)
      expect(cloned).toEqual({ a: { b: { c: 3 } } })
      expect(cloned.a).not.toBe(obj.a)
      expect(cloned.a.b).not.toBe(obj.a.b)
    })

    it('handles circular references in objects by skipping them', () => {
      const obj: any = { a: 1 }
      obj.self = obj
      const cloned = clone(obj)
      expect(cloned.a).toBe(1)
      // self should be absent because it was already visited
      expect(cloned.self).toBeUndefined()
    })
  })

  describe('arguments objects', () => {
    it('does not treat plain objects with forged callee as arguments objects', () => {
      const argsLike = { 0: 'a', 1: 'b', length: 2, callee: () => {} }
      const cloned = clone(argsLike) as Record<string, unknown>
      expect(Array.isArray(cloned)).toBe(false)
      expect(cloned['0']).toBe('a')
      expect(cloned['1']).toBe('b')
    })

    it('clones real arguments objects', () => {
      function captureArgs(..._values: unknown[]) {
        return arguments
      }
      const args = captureArgs.call(null, 'x', 'y', 'z')
      const cloned = clone(args)
      expect(Array.isArray(cloned)).toBe(true)
      expect(cloned).toEqual(['x', 'y', 'z'])
    })
  })

  describe('ObjectId-like objects', () => {
    it('converts ObjectId-like objects to string', () => {
      const objectId = {
        _bsontype: 'ObjectId',
        toString: () => '507f1f77bcf86cd799439011',
      }
      const cloned = clone(objectId)
      expect(cloned).toBe('507f1f77bcf86cd799439011')
    })
  })

  describe('mongoose model-like objects', () => {
    it('clones the _doc property of model-like objects', () => {
      class model {
        _doc: any
        constructor(doc: any) {
          this._doc = doc
        }
      }
      const m = new model({ name: 'test', value: 42 })
      const cloned = clone(m)
      expect(cloned).toEqual({ name: 'test', value: 42 })
    })
  })

  describe('binary data (Uint8Array)', () => {
    it('clones a Uint8Array', () => {
      const buf = new Uint8Array([10, 20, 30])
      const cloned = clone(buf)
      expect(cloned).toEqual(new Uint8Array([10, 20, 30]))
      expect(cloned).not.toBe(buf)
    })
  })

  describe('objects with clone() method', () => {
    it('delegates to val.clone() when available', () => {
      const original = {
        value: 99,
        clone: vi.fn().mockReturnValue({ value: 99, cloned: true }),
      }
      const cloned = clone(original)
      expect(original.clone).toHaveBeenCalled()
      expect(cloned).toEqual({ value: 99, cloned: true })
    })
  })

  describe('custom EJSON types', () => {
    afterEach(() => {
      const types = EJSON._getTypes(true) as Map<string, any>
      types.delete('CloneTestType')
    })

    it('round-trips custom types through toJSONValue/fromJSONValue', () => {
      EJSON.addType('CloneTestType', (val) => ({
        typeName: () => 'CloneTestType',
        toJSONValue: () => val,
        value: val,
      }))

      const custom = {
        typeName: () => 'CloneTestType',
        toJSONValue: () => ({ x: 42 }),
      }

      const cloned = clone(custom)
      expect(cloned).toBeDefined()
      expect(cloned.typeName()).toBe('CloneTestType')
    })
  })

  describe('shared nested references', () => {
    it('handles objects appearing multiple times by skipping revisits', () => {
      const shared = { shared: true }
      const obj = { a: shared, b: shared }
      const cloned = clone(obj)

      // a is cloned but b has the same reference as a, so it gets skipped
      expect(cloned.a).toEqual({ shared: true })
      // b is skipped because `shared` was already seen in the WeakSet
      expect(cloned.b).toBeUndefined()
    })

    it('handles arrays with shared object references', () => {
      const shared = { v: 1 }
      const arr = [shared, shared]
      const cloned = clone(arr)
      // Second reference to shared is filtered out
      expect(cloned).toEqual([{ v: 1 }])
    })
  })
})
