import { describe, expect, it } from 'vitest'

import { LocalQueryError } from './errors'
import { Matcher } from './matcher'
import { compileProjection } from './projection'
import { Sorter } from './sorter'

interface TestDocument {
  _id: string
  name: string
  score: number
  nested?: { value: number }
  tags: string[]
  rows?: { value: number }[]
}

const documents: TestDocument[] = [
  { _id: 'a', name: 'Zulu', score: 3, nested: { value: 4 }, tags: ['red', 'blue'] },
  { _id: 'b', name: 'alpha', score: 1, tags: ['green'], rows: [{ value: 2 }, { value: 8 }] },
  { _id: 'c', name: 'Bravo', score: 2, tags: [] },
]

describe('Matcher', () => {
  it('matches scalar IDs, nested paths, arrays, and logical operators', () => {
    expect(new Matcher<TestDocument>('a').documentMatches(documents[0]!).result).toBe(true)
    expect(new Matcher<TestDocument>({ 'nested.value': { $gte: 4 } }).documentMatches(documents[0]!).result).toBe(true)
    expect(new Matcher<TestDocument>({ tags: 'blue' }).documentMatches(documents[0]!).result).toBe(true)
    expect(new Matcher<TestDocument>({ 'rows.value': 8 }).documentMatches(documents[1]!).result).toBe(true)
    expect(new Matcher<TestDocument>({ $or: [{ score: 9 }, { name: /^Bra/ }] }).documentMatches(documents[2]!).result).toBe(true)
  })

  it('supports inclusion, array, type, bit, and elemMatch operators', () => {
    expect(new Matcher({ tags: { $all: ['red', /^bl/] } }).documentMatches(documents[0]!).result).toBe(true)
    expect(new Matcher({ rows: { $elemMatch: { value: { $gt: 5 } } } }).documentMatches(documents[1]!).arrayIndices).toEqual([1])
    expect(new Matcher({ score: { $type: 'double', $in: [1, 2] } }).documentMatches(documents[1]!).result).toBe(true)
    expect(new Matcher({ score: { $bitsAllSet: [0] } }).documentMatches(documents[1]!).result).toBe(true)
  })

  it('preserves safe falsey selectors and query errors', () => {
    expect(new Matcher(undefined).documentMatches(documents[0]!).result).toBe(false)
    expect(new Matcher({ _id: '' }).documentMatches(documents[0]!).result).toBe(false)
    expect(() => new Matcher({ score: { $in: 1 } })).toThrow('$in needs an array')
    expect(() => new Matcher({ $unknown: true })).toThrow(LocalQueryError)
  })

  it('rejects javascript where selectors', () => {
    expect(() => new Matcher({ $where: 'obj.score === 3' })).toThrow(
      'Unrecognized logical operator: $where',
    )
    expect(() => new Matcher({ $where: () => true })).toThrow(
      'Unrecognized logical operator: $where',
    )
  })

  it('rejects oversized bitmask positions in $bits* operators', () => {
    expect(() => new Matcher({ score: { $bitsAnySet: [0x7fffffff] } })).toThrow(
      LocalQueryError,
    )
    expect(() => new Matcher({ score: { $bitsAnySet: new Uint8Array(600) } })).toThrow(
      LocalQueryError,
    )
  })
})

describe('Sorter and projection', () => {
  it('sorts by multiple fields and supports collation', () => {
    const byScore = new Sorter<TestDocument>({ score: 1 }).getComparator()
    expect([...documents].sort(byScore).map(document => document._id)).toEqual(['b', 'c', 'a'])

    const byName = new Sorter<TestDocument>({ name: 1 }, { locale: 'en', strength: 2 }).getComparator()
    expect([...documents].sort(byName).map(document => document._id)).toEqual(['b', 'c', 'a'])
  })

  it('projects included and excluded nested fields without aliasing', () => {
    const include = compileProjection<TestDocument>({ name: 1, 'nested.value': 1 })
    const exclude = compileProjection<TestDocument>({ score: 0 })
    const included = include(documents[0]!)

    expect(included).toEqual({ _id: 'a', name: 'Zulu', nested: { value: 4 } })
    expect(included.nested).not.toBe(documents[0]!.nested)
    expect(exclude(documents[0]!)).not.toHaveProperty('score')
    expect(() => compileProjection({ name: 1, score: 0 })).toThrow(
      'You cannot currently mix including and excluding fields.',
    )
  })

  it('projects through nested arrays and rejects overlapping paths', () => {
    const source = {
      _id: 'one',
      rows: [[{ kept: 1, dropped: 2 }], { kept: 3, dropped: 4 }],
    }

    expect(compileProjection({ 'rows.kept': 1, _id: 0 })(source)).toEqual({
      rows: [[{ kept: 1 }], { kept: 3 }],
    })
    expect(compileProjection({ 'rows.kept': 0, _id: 0 })(source)).toEqual({
      rows: [[{ dropped: 2 }], { dropped: 4 }],
    })
    expect(compileProjection({ _id: 1 })(source)).toEqual({ _id: 'one' })
    expect(() => compileProjection({ rows: 1, 'rows.kept': 1 }))
      .toThrow('using both of them may trigger unexpected behavior')
  })

  it('blocks prototype pollution segments and prototype property collisions in compileProjection', () => {
    expect(() => compileProjection({ '__proto__.polluted': 1 })).toThrow()
    expect(() => compileProjection({ 'constructor.prototype.polluted': 1 })).toThrow()

    const ownProtoNamedField = compileProjection({ toString: 1, _id: 0 })
    const docWithOwn = Object.assign({ name: 'a' }, { toString: 'custom' })
    expect(ownProtoNamedField(docWithOwn)).toEqual({ toString: 'custom' })
    expect(ownProtoNamedField({ name: 'a' } as Record<string, unknown>)).toEqual({})
  })
})
