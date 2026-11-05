/**
 * Replay every EJSON fixture against the TS encoder/decoder.
 *
 * Same fixture set the Python harness exercises (docs/conformance/
 * fixtures/ejson). Encoder output and decode-then-reencode loops must
 * both be byte-identical to the fixture.
 */

import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { EJSON } from '../../ejson'

import {
  listCases,
  loadJson,
  registerCustomTypes,
  rehydrate,
} from './harness'

describe('EJSON conformance fixtures', () => {
  const cases = listCases('ejson')
  for (const casePath of cases) {
    const name = path.basename(casePath, '.case.json')
    it(`${name} encodes to the expected wire bytes`, () => {
      const fixture = loadJson(casePath)
      registerCustomTypes(fixture.register?.custom_types ?? [])
      const value = rehydrate(fixture.value)
      expect(EJSON.stringify(value, { canonical: fixture.canonical === true })).toEqual(fixture.encoded)
    })

    it(`${name} decodes + re-encodes identically`, () => {
      const fixture = loadJson(casePath)
      registerCustomTypes(fixture.register?.custom_types ?? [])
      const decoded = EJSON.parse(fixture.encoded)
      expect(EJSON.stringify(decoded, { canonical: fixture.canonical === true })).toEqual(fixture.encoded)
    })
  }
})
