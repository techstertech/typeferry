import sinon from 'sinon'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { range } from '../../utils/lodash'

import { Client } from '../../client'
import {
  TypeFerryAsyncLocalStorage,
  ClientNode,
  REDACTED_METHOD_TELEMETRY,
} from '../../server'
import {
  Errors,
  getPromise,
  PublicError,
  ServerEvents,
  sleep,
} from '../../utils'
import { TestUtility } from '../test-utility'

describe('Methods', () => {
  const test = new TestUtility()

  it('should register a method, call it and get a response', async () => {
    test.server.addMethod('test:method', function ({ a, b }) {
      return a + b
    })

    const result = await test.client.call('test:method', { a: 1, b: 2 })

    expect(result).toEqual(3)
  })

  it('should register a method as a promise and still get a response', async () => {
    test.server.addMethod('test:promise', async ([a, b, c]) => {
      return a + b + c
    })

    const result = await test.client.call('test:promise', [1, 2, 3])

    expect(result).toEqual(6)
  })

  it('should throw an error', async () => {
    test.server.addMethod('test:error', () => {
      throw new Error('Lorem Ipsum')
    })

    // Errors now come as plain Error objects via acknowledgments
    await expect(test.client.call('test:error')).rejects.toThrow(
      Errors.INTERNAL_ERROR
    )
  })

  it('should make a void method call', async () => {
    let called = false

    test.server.addMethod('test:method', () => {
      called = true
    })

    await test.client.void('test:method')

    await test.sleep(500)

    expect(called).toBe(true)
  })

  it('should run middleware', async () => {
    let calledMiddleware = false
    let params: unknown

    const { promise, resolve } = getPromise()

    test.server.addMethod(
      'test:method:middleware',
      function (_params) {
        params = _params
        resolve(undefined)
      },
      {
        middleware: [
          function (this: ClientNode) {
            calledMiddleware = true
            expect(this).toBeInstanceOf(ClientNode)

            return { hello: true }
          },
        ],
      }
    )

    await test.client.void('test:method:middleware', { world: true })

    await promise

    expect(calledMiddleware).toBe(true)
    expect(params).to.containSubset({
      hello: true,
      world: true,
    })
  })

  it('should run middleware which return the latest in the chain primitives', async () => {
    test.server.addMethod(
      'test:method:middleware',
      function (params) {
        return params
      },
      {
        middleware: [
          function () {
            return 'tea'
          },
          function () {
            return 'world'
          },
        ],
      }
    )

    const result = await test.client.call('test:method:middleware', 'hello')

    expect(result).toEqual('world')
  })

  it('should run middleware and throw error', async () => {
    test.server.addMethod('test:method:middleware:reject', () => undefined, {
      middleware: [
        function () {
          throw new PublicError('Authentication Failed')
        },
      ],
    })

    await expect(
      test.client.call('test:method:middleware:reject')
    ).rejects.toThrow('Authentication Failed')
  })

  it('should register and call a method with zod schema validation', async () => {
    const server = await test.createRandomSrv({ globalInstance: true })
    const client = await test.createClient({ port: server.port })

    server.addMethod(
      'validated:zod:method',
      ({ knownProperty }) => Boolean(knownProperty),
      {
        schema: z.object({
          knownProperty: z.boolean(),
        }),
      }
    )

    await expect(client.call('validated:zod:method')).rejects.toThrow(
      Errors.INVALID_PARAMS
    )

    const result = await client.call('validated:zod:method', {
      knownProperty: true,
    })

    expect(result).toBe(true)

    await client.close()
    await server.close()
  })

  it('should include field path and message in schema validation errors', async () => {
    test.server.addMethod(
      'validated:detailed:error',
      ({ name, age }) => ({ name, age }),
      {
        schema: z.object({
          name: z.string().min(2),
          age: z.number().min(0).max(150),
        }),
      }
    )

    // Test wrong type - error includes field path and type mismatch
    await expect(
      test.client.call('validated:detailed:error', {
        name: 'Jo',
        age: 'not-a-number',
      })
    ).rejects.toThrow(/age:.*expected number/)

    // Test string too short - error includes field path and constraint
    await expect(
      test.client.call('validated:detailed:error', { name: 'A', age: 25 })
    ).rejects.toThrow(/name:.*Too small/)

    // Test number out of range - error includes field path and constraint
    await expect(
      test.client.call('validated:detailed:error', { name: 'John', age: 200 })
    ).rejects.toThrow(/age:.*150/)
  })

  it('should include multiple field errors in schema validation message', async () => {
    test.server.addMethod(
      'validated:multi:error',
      ({ email, count }) => ({ email, count }),
      {
        schema: z.object({
          email: z.string().email(),
          count: z.number().positive(),
        }),
      }
    )

    // Both fields invalid - error should mention both
    try {
      await test.client.call('validated:multi:error', {
        email: 'not-an-email',
        count: -5,
      })
      expect.fail('Should have thrown')
    } catch (err) {
      if (!(err instanceof Error)) throw err

      expect(err.message).toContain('email')
      expect(err.message).toContain('count')
    }
  })

  it('should have async local storage', async () => {
    test.server.addMethod('get:async:ls', function () {
      return TypeFerryAsyncLocalStorage.getStore()
    })

    const result1 = await test.client.call('get:async:ls')

    expect(result1).toHaveProperty('executionId')
    expect(result1).toMatchObject({ executionId: expect.any(String) })
    expect(result1).toHaveProperty('context')
    expect(result1).toMatchObject({ context: expect.any(Object) })
  })

  it('should have async local storage in middleware', async () => {
    test.server.addMethod(
      'get:async:ls',
      function (store) {
        return store
      },
      {
        middleware: [
          async function () {
            return TypeFerryAsyncLocalStorage.getStore()
          },
        ],
      }
    )

    const result1 = await test.client.call('get:async:ls')

    expect(result1).toHaveProperty('executionId')
    expect(result1).toMatchObject({ executionId: expect.any(String) })
    expect(result1).toHaveProperty('context')
    expect(result1).toMatchObject({ context: expect.any(Object) })
  })

  it('should call a method in the server', async () => {
    let isServer = false

    test.server.addMethod('test:method', function ({ a, b }) {
      isServer = this.isServer

      return a + b
    })

    const result = await test.server.call('test:method', { a: 1, b: 2 })

    expect(result).toEqual(3)
    expect(isServer).toBe(true)
  })

  it('should throw when exceeding rate limit', async () => {
    const server = await test.createRandomSrv({ globalInstance: false })

    const client = await test.createClient({ port: server.port })

    server.addMethod('test:method', (v) => v)

    const call = async () => {
      for (const v of range(1, 200)) {
        await client.call('test:method', v)
      }
    }

    await expect(call()).rejects.toThrow(Errors.RATE_LIMIT_EXCEEDED)
  })

  it('in case we return undefined in a method we should ', async () => {
    const client = await test.createClient({
      port: test.server.port,
    })

    test.server.addMethod('test:method', async () => undefined)

    const result = await client.call('test:method')

    expect(result).toEqual(undefined)
  })

  it('should fire an event after a method call', async () => {
    test.server.addMethod('test:method', async () => {
      await sleep(100)

      return 42
    })

    test.client.call('test:method', { a: 1, b: 2 })

    const [result] = await test.server.waitFor(ServerEvents.METHOD_EXECUTION)

    expect(result).toBeTypeOf('object')
    expect(result.method).toEqual('test:method')
    expect(result.time).toBeGreaterThanOrEqual(90)
    expect(result.time).toBeLessThanOrEqual(110)
    expect(result.params).toEqual({ a: 1, b: 2 })
    expect(result.result).toEqual(42)
  })

  it('redacts parameters and results from sensitive method telemetry', async () => {
    test.server.addMethod(
      'test:sensitive',
      async ({ secret }) => ({ token: secret }),
      { sensitive: true }
    )

    test.client.call('test:sensitive', { secret: 'private-value' })

    const [result] = await test.server.waitFor(ServerEvents.METHOD_EXECUTION)

    expect(result).toMatchObject({
      method: 'test:sensitive',
      params: REDACTED_METHOD_TELEMETRY,
      result: REDACTED_METHOD_TELEMETRY,
    })
  })

  it('should only call a method if the client has initialized', async () => {
    const calls: unknown[] = []

    test.server.addMethod('test:method', async (param) => {
      calls.push(param)
      return 42
    })

    const stub = sinon.stub(Client.prototype, 'initialize')
    stub.returns(Promise.resolve(true))

    try {
      const client = new Client({
        host: test.server.host,
        port: test.server.port,
      })

      await expect(
        client.call('test:method', 1, { timeout: 1500 })
      ).rejects.toThrow(/TypeFerry: Client not initialized/)

      expect(calls).toEqual([])

      stub.restore()

      setTimeout(() => client.initialize(), 100)

      await client.call('test:method', 1)

      expect(calls).toEqual([1])

      await client.close()
    } finally {
      stub.restore()
    }
  })

  it('should retry failed method calls according to retry options', async () => {
    const calls: unknown[] = []
    let shouldFail = true

    test.server.addMethod('test:method', async (param) => {
      calls.push(param)
      if (shouldFail) {
        shouldFail = false
        throw new Error('Temporary failure')
      }
      return 42
    })

    const result = await test.client.call('test:method', 1, {
      maxRetries: 2,
      delayBetweenRetriesMs: 100,
    })

    expect(calls).toEqual([1, 1])
    expect(result).toEqual(42)
  })

  it('should throw after exhausting all retry attempts', async () => {
    test.server.addMethod('test:method', async () => {
      throw new Error('Persistent failure')
    })

    await expect(
      test.client.call('test:method', 1, {
        maxRetries: 3,
        delayBetweenRetriesMs: 100,
      })
    ).rejects.toThrow(Errors.INTERNAL_ERROR)
  })

  it('does not cache rejected promises or server.call() invocations in anonymous cache', async () => {
    let calls = 0
    let shouldFail = true
    test.server.addMethod(
      'cache:hardened',
      async function (params: { fail?: boolean }) {
        calls++
        if (this.isServer) return 'server-secret'
        if (params?.fail && shouldFail) throw new PublicError('transient')
        return `ok-${calls}`
      },
      { cache: true },
    )

    expect(await test.server.call('cache:hardened', { fail: false })).toBe(
      'server-secret',
    )
    await expect(
      test.client.call('cache:hardened', { fail: true }),
    ).rejects.toMatchObject({ message: 'transient' })

    shouldFail = false
    const afterFailure = await test.client.call('cache:hardened', { fail: true })
    expect(afterFailure).toBe('ok-3')
    expect(await test.client.call('cache:hardened', { fail: false })).toBe(
      'ok-4',
    )
  })

  it('bounds anonymous method cache entries to prevent unbounded memory growth', async () => {
    let calls = 0
    test.server.addMethod(
      'cache:bounded',
      async (params: { i: number }) => {
        calls++
        return params.i
      },
      { cache: true },
    )

    const method = test.server.getMethod('cache:bounded')!
    const anonNode = { authenticated: false, isServer: false, context: {} } as any
    for (let i = 0; i < 1005; i++) {
      await method.exec({ i }, anonNode)
    }
    expect(calls).toBe(1005)
    // Entry i=0 was evicted after 1000 cap, so calling it again re-executes.
    await method.exec({ i: 0 }, anonNode)
    expect(calls).toBe(1006)
  })

  it('evicts undefined-parameter cache entries at capacity and never populates cache pre-settlement or on auth elevation', async () => {
    let undefinedCalls = 0
    test.server.addMethod(
      'cache:undefined-key',
      async (params?: { i: number }) => {
        if (params === undefined) undefinedCalls++
        return params?.i ?? 'undef'
      },
      { cache: true },
    )
    const undefMethod = test.server.getMethod('cache:undefined-key')!
    const anonNode = { authenticated: false, isServer: false, context: {} } as any
    expect(await undefMethod.exec(undefined, anonNode)).toBe('undef')
    for (let i = 0; i < 1000; i++) {
      await undefMethod.exec({ i }, anonNode)
    }
    expect(await undefMethod.exec(undefined, anonNode)).toBe('undef')
    expect(undefinedCalls).toBe(2)

    let concurrentCalls = 0
    let markEntered!: () => void
    const firstEntered = new Promise<void>(resolve => {
      markEntered = resolve
    })
    let rejectFirst!: (error: Error) => void
    test.server.addMethod(
      'cache:inflight',
      () => {
        concurrentCalls++
        if (concurrentCalls === 1) {
          return new Promise<string>((_, reject) => {
            rejectFirst = reject
            markEntered()
          })
        }
        return Promise.resolve('second-ok')
      },
      { cache: true },
    )
    const inflightMethod = test.server.getMethod('cache:inflight')!
    const first = inflightMethod.exec({ x: 1 }, anonNode)
    await firstEntered
    const second = inflightMethod.exec({ x: 1 }, anonNode)
    rejectFirst(new PublicError('boom'))
    await expect(first).rejects.toThrow('boom')
    expect(await second).toBe('second-ok')

    test.server.addMethod(
      'cache:elevates-sync',
      function () {
        this.authenticated = true
        return 'secret-sync'
      },
      { cache: true },
    )
    const syncElev = test.server.getMethod('cache:elevates-sync')!
    const mutatingNode = { authenticated: false, isServer: false, context: {} } as any
    expect(await syncElev.exec({ k: 1 }, mutatingNode)).toBe('secret-sync')
    let secondHandler = false
    test.server.addMethod(
      'cache:elevates-sync-check',
      function () {
        this.authenticated = true
        if (!secondHandler) {
          secondHandler = true
          return 'elevated'
        }
        return 'anon'
      },
      { cache: true },
    )
    const checkMethod = test.server.getMethod('cache:elevates-sync-check')!
    await checkMethod.exec({ k: 1 }, { authenticated: false, isServer: false, context: {} } as any)
    expect(
      await checkMethod.exec({ k: 1 }, { authenticated: false, isServer: false, context: {} } as any),
    ).toBe('anon')
  })
})
