import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { objectId } from './schema'
import { toMongoJsonSchema } from './validator'

describe('MongoDB Zod validator compiler', () => {
  it('compiles strict BSON structure and permits a generated ObjectId', () => {
    const schema = z.strictObject({
      accountId: objectId(),
      createdAt: z.date(),
      name: z.string().min(1).max(80),
      status: z.enum(['active', 'archived']),
      revision: z.number().int().min(0),
      note: z.string().nullable().optional(),
      tags: z.array(z.string()),
      address: z.strictObject({ city: z.string() }),
    })

    expect(toMongoJsonSchema(schema)).toEqual({
      bsonType: 'object',
      additionalProperties: false,
      required: [
        'accountId',
        'createdAt',
        'name',
        'status',
        'revision',
        'tags',
        'address',
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        accountId: { bsonType: 'objectId' },
        createdAt: { bsonType: 'date' },
        name: { bsonType: 'string', minLength: 1, maxLength: 80 },
        status: { bsonType: 'string', enum: ['active', 'archived'] },
        revision: {
          bsonType: ['int', 'long', 'double', 'decimal'],
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        note: { bsonType: ['string', 'null'] },
        tags: { bsonType: 'array', items: { bsonType: 'string' } },
        address: {
          bsonType: 'object',
          additionalProperties: false,
          required: ['city'],
          properties: { city: { bsonType: 'string' } },
        },
      },
    })
  })

  it('preserves an explicit identifier schema', () => {
    expect(
      toMongoJsonSchema(z.strictObject({ _id: z.string(), name: z.string() })),
    ).toMatchObject({
      required: ['_id', 'name'],
      properties: { _id: { bsonType: 'string' } },
    })
  })

  it('maps literals and booleans to MongoDB-compatible constraints', () => {
    expect(
      toMongoJsonSchema(
        z.strictObject({
          kind: z.literal('board'),
          enabled: z.boolean(),
        }),
      ),
    ).toMatchObject({
      properties: {
        kind: { bsonType: 'string', enum: ['board'] },
        enabled: { bsonType: 'bool' },
      },
    })
  })

  it('rejects custom schemas with their path', () => {
    expect(() =>
      toMongoJsonSchema(z.strictObject({ value: z.custom<string>() })),
    ).toThrow(/properties\.value/)
  })

  it('rejects transforms with their path', () => {
    expect(() =>
      toMongoJsonSchema(
        z.strictObject({ value: z.string().transform(String) }),
      ),
    ).toThrow(/properties\.value/)
  })

  it('rejects maps with their path', () => {
    expect(() =>
      toMongoJsonSchema(
        z.strictObject({ value: z.map(z.string(), z.string()) }),
      ),
    ).toThrow(/properties\.value/)
  })

  it('rejects unsupported schemas nested in optional fields and unions', () => {
    expect(() =>
      toMongoJsonSchema(
        z.strictObject({
          value: z.custom<string>().optional(),
        }),
      ),
    ).toThrow(/properties\.value/)

    expect(() =>
      toMongoJsonSchema(
        z.strictObject({
          value: z.union([z.string(), z.custom<string>()]),
        }),
      ),
    ).toThrow(/properties\.value/)
  })

  it('rejects unconstrained root schemas', () => {
    expect(() => Reflect.apply(toMongoJsonSchema, undefined, [z.unknown()])).toThrow(
      /<root>/,
    )
  })

  it('rejects string formats without an enforceable MongoDB pattern', () => {
    expect(() =>
      toMongoJsonSchema(z.strictObject({ website: z.url() })),
    ).toThrow(/properties\.website\.format/)
  })

  it('maps readonly booleans to MongoDB BSON bool validation', () => {
    expect(
      toMongoJsonSchema(
        z.strictObject({ enabled: z.boolean().readonly() }).readonly(),
      ),
    ).toMatchObject({
      bsonType: 'object',
      properties: { enabled: { bsonType: 'bool' } },
    })
  })

  it('compiles homogeneous variadic tuples as bounded homogeneous arrays', () => {
    expect(
      toMongoJsonSchema(
        z.strictObject({
          changes: z.tuple([z.string()], z.string()),
        }),
      ),
    ).toMatchObject({
      properties: {
        changes: {
          bsonType: 'array',
          items: { bsonType: 'string' },
          minItems: 1,
        },
      },
    })
  })

  it('rejects fixed and heterogeneous tuple schemas', () => {
    expect(() =>
      toMongoJsonSchema(
        z.strictObject({ values: z.tuple([z.string(), z.number()]) }),
      ),
    ).toThrow(/Tuple schemas are not supported.*properties\.values/)

    expect(() =>
      toMongoJsonSchema(
        z.strictObject({
          values: z.tuple([z.string()], z.number()),
        }),
      ),
    ).toThrow(/Tuple schemas are not supported.*properties\.values/)
  })

  it('permits generated ObjectIds in strict root union alternatives only', () => {
    const compiled = toMongoJsonSchema(
      z.union([
        z.strictObject({
          kind: z.literal('custom'),
          details: z.strictObject({ label: z.string() }),
        }),
        z.strictObject({ kind: z.literal('system'), key: z.string() }),
      ]),
    )

    expect(compiled).toMatchObject({
      anyOf: [
        {
          properties: {
            _id: { bsonType: 'objectId' },
            details: {
              additionalProperties: false,
              properties: { label: { bsonType: 'string' } },
            },
          },
        },
        { properties: { _id: { bsonType: 'objectId' } } },
      ],
    })
    expect(
      (
        compiled.anyOf as readonly {
          readonly properties: { readonly details?: { properties: object } }
        }[]
      )[0]?.properties.details?.properties,
    ).not.toHaveProperty('_id')
  })

  it('preserves explicit identifiers in strict root union alternatives', () => {
    const compiled = toMongoJsonSchema(
      z.union([
        z.strictObject({ _id: z.string(), kind: z.literal('external') }),
        z.strictObject({ kind: z.literal('internal') }),
      ]),
    )

    expect(compiled).toMatchObject({
      anyOf: [
        { properties: { _id: { bsonType: 'string' } } },
        { properties: { _id: { bsonType: 'objectId' } } },
      ],
    })
  })
})
