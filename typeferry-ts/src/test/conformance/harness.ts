/**
 * Shared helpers for the TS side of the conformance harness.
 *
 * Loads fixtures from `docs/conformance/fixtures/` and rehydrates
 * tagged EJSON values so Vitest tests can exercise the TS server
 * against the same suite the Python harness uses.
 */

import fs from 'node:fs'
import path from 'node:path'

import { EJSON } from '../../ejson'
import { SchemaValidationError } from '../../utils'
import { PublicError } from '../../utils/errors'

export const FIXTURES_ROOT = path.resolve(
  __dirname,
  '../../../../docs/conformance/fixtures',
)

export function listCases(subdir: string, suffix = '.case.json'): string[] {
  return fs
    .readdirSync(path.join(FIXTURES_ROOT, subdir))
    .filter(f => f.endsWith(suffix))
    .sort()
    .map(f => path.join(FIXTURES_ROOT, subdir, f))
}

export function listSequences(subdir: string): string[] {
  return fs
    .readdirSync(path.join(FIXTURES_ROOT, subdir))
    .filter(f => f.endsWith('.seq.ndjson'))
    .sort()
    .map(f => path.join(FIXTURES_ROOT, subdir, f))
}

export function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function loadSequence(file: string): any[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line))
}

// ---------------------------------------------------------------------------
// EJSON tagged-value rehydration
// ---------------------------------------------------------------------------

/** Custom type factory used when fixtures register a `custom_types` hint. */
class FixtureCustom {
  private readonly _name: string
  private readonly _inner: unknown
  constructor(name: string, inner: unknown) {
    this._name = name
    this._inner = inner
  }
  typeName() {
    return this._name
  }
  toJSONValue() {
    return this._inner
  }
}

const REGISTERED_CUSTOM_TYPES = new Set<string>()

export function registerCustomTypes(names: string[]): void {
  for (const name of names) {
    if (REGISTERED_CUSTOM_TYPES.has(name)) continue
    REGISTERED_CUSTOM_TYPES.add(name)
    EJSON.addType(name, (payload: unknown) => new FixtureCustom(name, payload))
  }
}

export function rehydrate(node: any): unknown {
  switch (node.__kind) {
    case 'null':
      return null
    case 'bool':
      return node.value
    case 'int':
      return node.value
    case 'float':
      return node.value
    case 'string':
      return node.value
    case 'array':
      return node.items.map(rehydrate)
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const [key, value] of node.entries) out[key] = rehydrate(value)
      return out
    }
    case 'date':
      return new Date(node.millis)
    case 'binary': {
      const bin = EJSON.newBinary(0)
      const decoded = EJSON.parse(`{"$binary":"${node.base64}"}`)
      return decoded
    }
    case 'regex':
      // JS RegExp doesn't support every flag (no 'y' in Node stricter mode,
      // 'g' etc are fine). Constructing with the sanitized flag set matches
      // what EJSON.parse would produce for the same tag.
      return new RegExp(node.source, node.flags.replace(/[^gimuy]/g, ''))
    case 'inf_nan':
      if (node.sign === 0) return Number.NaN
      if (node.sign === 1) return Number.POSITIVE_INFINITY
      return Number.NEGATIVE_INFINITY
    case 'custom':
      return new FixtureCustom(node.type, rehydrate(node.inner))
    default:
      throw new Error(`unknown __kind: ${node.__kind}`)
  }
}

// ---------------------------------------------------------------------------
// Server setup helpers
// ---------------------------------------------------------------------------

export function buildHandler(spec: string): (params: any) => Promise<any> | any {
  if (spec === 'increment_counter') {
    let calls = 0

    return () => ++calls
  }

  if (spec === 'add_two_integers') {
    return async (params: any) => Number(params.a) + Number(params.b)
  }
  if (spec === 'echo_params') {
    return async (params: any) => params
  }
  if (spec === 'return_user_id') {
    return async function (this: { userId?: string | null }) {
      return this.userId ?? null
    }
  }
  if (spec.startsWith('return_const:')) {
    const value = spec.slice('return_const:'.length)
    return async () => value
  }
  if (spec.startsWith('raise_public:')) {
    const message = spec.slice('raise_public:'.length)
    return async () => {
      throw new PublicError(message)
    }
  }
  throw new Error(`unknown handler spec: ${spec}`)
}

/** Produce a Zod-less schema adapter that always fails with the fixture's
 * issue list — mirrors the Python FixtureSchema. */
export function buildSchema(spec: any): any {
  if (!spec) return undefined
  if (!spec.reject_all) return undefined
  const issues: Array<{ path: string[]; message: string }> = spec.issues ?? []
  return {
    safeParse(_value: any) {
      // Zod-compatible shape that Method's schema code can consume.
      const formatted = issues.map(
        (i: { path: string[]; message: string }) =>
          `${i.path.join('.')}: ${i.message}`,
      )
      const error = new SchemaValidationError(
        `Invalid Params: ${formatted.join(', ')}`,
        formatted,
      )
      return {
        success: false,
        error: {
          issues: issues.map(i => ({
            path: i.path,
            message: i.message,
          })),
        },
      }
    },
  }
}
