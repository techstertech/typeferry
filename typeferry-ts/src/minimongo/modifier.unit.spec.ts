import { describe, expect, it } from 'vitest'

import { LocalCollectionError } from './errors'
import { createUpsertDocument, modifyDocument } from './modifier'
import { deletePath, setPath } from './path'

interface MutableDocument extends Record<string, unknown> {
  _id: string
  count: number
  nested?: { value: string }
  tags: string[]
  rows?: { value: number }[]
}

function document(): MutableDocument {
  return { _id: 'one', count: 2, nested: { value: 'old' }, tags: ['a'] }
}

describe('modifyDocument', () => {
  it('applies numeric, set, unset, and rename operators', () => {
    const target = document()

    modifyDocument(target, {
      $inc: { count: 3 },
      $set: { 'nested.value': 'new' },
      $rename: { 'nested.value': 'renamed' },
      $unset: { missing: true },
    })

    expect(target).toEqual({ _id: 'one', count: 5, nested: {}, tags: ['a'], renamed: 'new' })
  })

  it('applies array modifiers without aliasing modifier values', () => {
    const target: MutableDocument = {
      ...document(),
      rows: [{ value: 3 }],
    }
    const item = { value: 2 }

    modifyDocument(target, {
      $push: { rows: { $each: [{ value: 1 }, item], $sort: { value: 1 }, $slice: 2 } },
      $addToSet: { tags: { $each: ['a', 'b'] } },
    })

    item.value = 9
    expect(target.tags).toEqual(['a', 'b'])
    expect(target.rows).toEqual([{ value: 1 }, { value: 2 }])
  })

  it('uses selector array metadata for positional updates', () => {
    const target: MutableDocument = {
      ...document(),
      rows: [{ value: 1 }, { value: 2 }],
    }

    modifyDocument(target, { $set: { 'rows.$.value': 7 } }, { arrayIndices: [1] })

    expect(target.rows).toEqual([{ value: 1 }, { value: 7 }])
  })

  it('preserves identity during replacement and rejects mixed updates', () => {
    const target = document()

    modifyDocument(target, { count: 9, tags: [] })
    expect(target).toEqual({ _id: 'one', count: 9, tags: [] })
    expect(() => modifyDocument(target, { $set: { count: 1 }, extra: true }))
      .toThrow('Update parameter cannot have both modifier and non-modifier fields.')
    expect(() => modifyDocument(target, { _id: 'two', count: 1 })).toThrow(LocalCollectionError)
  })

  it('constructs upserts from equality query fields and setOnInsert', () => {
    const result = createUpsertDocument(
      { $and: [{ owner: 'one' }, { count: { $eq: 2 } }], ignored: { $gt: 1 } },
      { $set: { active: true }, $setOnInsert: { created: 'now' } },
    )

    expect(result).toEqual({ owner: 'one', count: 2, active: true, created: 'now' })
  })

  it('rejects prototype pollution segments in setPath, deletePath, modifiers, and upserts', () => {
    const proto = Object.prototype as Record<string, unknown>

    expect(() => setPath({}, '__proto__.polluted', true)).toThrow()
    expect(() => setPath({}, 'constructor.prototype.polluted', true)).toThrow()
    expect(() => deletePath({}, '__proto__.toString')).toThrow()
    expect(() =>
      modifyDocument(document(), { $set: { '__proto__.polluted': true } }),
    ).toThrow(LocalCollectionError)
    expect(() =>
      modifyDocument(document(), { $inc: { 'constructor.prototype.polluted': 1 } }),
    ).toThrow(LocalCollectionError)
    expect(() =>
      modifyDocument(document(), { $rename: { count: '__proto__.polluted' } }),
    ).toThrow(LocalCollectionError)
    expect(() =>
      createUpsertDocument({ '__proto__.polluted': true }, { $set: { ok: 1 } }),
    ).toThrow()

    expect(proto['polluted']).toBeUndefined()
  })

  it('does not leak Object.prototype properties in readField or bypass field validation in $pushAll/$addToSet', () => {
    const doc = document()
    expect(() =>
      modifyDocument(doc, { $inc: { toString: 1 } }),
    ).not.toThrow()
    expect(doc['toString']).toBe(1)

    const renameDoc = document()
    modifyDocument(renameDoc, { $rename: { toString: 'moved' } })
    expect(renameDoc['moved']).toBeUndefined()

    expect(() =>
      modifyDocument(document(), { $pushAll: { tags: [{ $bad: 1 }] } }),
    ).toThrow(LocalCollectionError)
    expect(() =>
      modifyDocument(document(), { $pushAll: { tags: [JSON.parse('{"__proto__":{"polluted":true}}') as unknown] } }),
    ).toThrow(LocalCollectionError)
    expect(() =>
      modifyDocument(document(), { $addToSet: { tags: { $each: [{ $bad: 1 }] } } }),
    ).toThrow(LocalCollectionError)
    expect(() =>
      modifyDocument(document(), { $addToSet: { tags: JSON.parse('{"__proto__":{"polluted":true}}') as unknown } }),
    ).toThrow(LocalCollectionError)
  })
})
