import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  Errors,
  Presentation,
  PublicError,
  SchemaValidationError,
  ServerEvents,
} from '../../utils'
import { SocketState } from '../types'
import {
  AUTH_TIMEOUT_MS,
  MAX_META_SIZE,
  MAX_UUID_LENGTH,
  authenticateNode,
  handleRpc,
  handleRpcVoid,
  parseMeta,
  sendResponse,
  validateMeta,
  validateUuid,
} from './ws-shared'

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockSocket(readyState: number = SocketState.OPEN) {
  return { readyState, send: vi.fn() }
}

function createMockNode(overrides: Record<string, any> = {}) {
  return {
    socket: createMockSocket(),
    authenticated: false,
    userId: null,
    context: null,
    remoteAddress: '127.0.0.1',
    userAgent: 'test',
    limiter: null,
    setContext: vi.fn(),
    emitAuthResult: vi.fn(),
    ...overrides,
  }
}

function createMockMethod(overrides: Record<string, any> = {}) {
  return {
    isProtected: false,
    isSensitive: false,
    exec: vi.fn().mockResolvedValue('result'),
    ...overrides,
  }
}

function createMockServer(overrides: Record<string, any> = {}) {
  const method = createMockMethod()
  return {
    methods: new Map([['testMethod', method]]),
    events: new Map(),
    isAuthEnabled: false,
    auth: { call: vi.fn() },
    emit: vi.fn(),
    _method: method,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// validateUuid
// ---------------------------------------------------------------------------

describe('validateUuid', () => {
  it('returns a random UUID for non-string input', () => {
    const result = validateUuid(undefined)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('returns a random UUID for null input', () => {
    const result = validateUuid(null)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('returns a random UUID for numeric input', () => {
    const result = validateUuid(42)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('returns a random UUID for empty string', () => {
    const result = validateUuid('')
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('returns a random UUID when string exceeds MAX_UUID_LENGTH', () => {
    const longUuid = 'a'.repeat(MAX_UUID_LENGTH + 1)
    const result = validateUuid(longUuid)

    // Should NOT be the original since it's too long
    expect(result).not.toBe(longUuid)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('returns a sanitized UUID for a valid input', () => {
    const result = validateUuid('abc-123-def')
    expect(result).toBe('abc-123-def')
  })

  it('assigns a fresh UUID instead of changing an invalid identity', () => {
    const result = validateUuid('abc!@#$%^&*()_+def')
    expect(result).not.toBe('abcdef')
    expect(result).toMatch(/^[a-zA-Z0-9-]{1,64}$/)
    expect(validateUuid('!!!')).toMatch(/^[a-zA-Z0-9-]{1,64}$/)
  })

  it('preserves dashes in the UUID', () => {
    const result = validateUuid('550e8400-e29b-41d4-a716-446655440000')
    expect(result).toBe('550e8400-e29b-41d4-a716-446655440000')
  })

  it('truncates sanitized UUID to MAX_UUID_LENGTH', () => {
    // Create a valid string that is exactly MAX_UUID_LENGTH
    const validLengthUuid = 'a'.repeat(MAX_UUID_LENGTH)
    const result = validateUuid(validLengthUuid)
    expect(result.length).toBeLessThanOrEqual(MAX_UUID_LENGTH)
  })

  it('returns different random UUIDs for each invalid call', () => {
    const a = validateUuid(undefined)
    const b = validateUuid(undefined)
    // crypto.randomUUID should produce different values
    // (extremely unlikely to collide)
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// validateMeta
// ---------------------------------------------------------------------------

describe('validateMeta', () => {
  it('bounds UTF-8 bytes rather than JavaScript character count', () => {
    expect(validateMeta({ value: '😀'.repeat(MAX_META_SIZE / 4) })).toEqual({})
  })
  it('returns {} for null', () => {
    expect(validateMeta(null)).toEqual({})
  })

  it('returns {} for undefined', () => {
    expect(validateMeta(undefined)).toEqual({})
  })

  it('returns {} for an array', () => {
    expect(validateMeta([1, 2, 3])).toEqual({})
  })

  it('returns {} for a primitive string', () => {
    expect(validateMeta('not-an-object')).toEqual({})
  })

  it('returns {} for a number', () => {
    expect(validateMeta(42)).toEqual({})
  })

  it('returns {} for a boolean', () => {
    expect(validateMeta(true)).toEqual({})
  })

  it('passes through a valid object', () => {
    const meta = { foo: 'bar', count: 5 }
    expect(validateMeta(meta)).toBe(meta)
  })

  it('returns {} when JSON representation exceeds MAX_META_SIZE', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bigMeta = { data: 'x'.repeat(MAX_META_SIZE) }

    expect(validateMeta(bigMeta)).toEqual({})
    expect(warnSpy).toHaveBeenCalledWith(
      '[TypeFerry] Meta object too large, ignoring'
    )

    warnSpy.mockRestore()
  })

  it('returns {} for circular objects (JSON.stringify throws)', () => {
    const circular: any = { a: 1 }
    circular.self = circular

    expect(validateMeta(circular)).toEqual({})
  })

  it('passes an object with size exactly at the limit', () => {
    // Build an object whose JSON is exactly MAX_META_SIZE
    // JSON.stringify({"d":""}) is 8 chars overhead, so value = MAX_META_SIZE - 8
    const padding = MAX_META_SIZE - 8
    const meta = { d: 'x'.repeat(padding) }
    expect(JSON.stringify(meta).length).toBe(MAX_META_SIZE)
    expect(validateMeta(meta)).toBe(meta)
  })
})

// ---------------------------------------------------------------------------
// parseMeta
// ---------------------------------------------------------------------------

describe('parseMeta', () => {
  it('accepts raw JSON within the limit even when number spelling expands', () => {
    const raw = `{"values":[${Array.from({ length: 1000 }, () => '1e20').join(',')}]}`

    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(MAX_META_SIZE)
    expect(parseMeta(raw)).toHaveProperty('values.0', 1e20)
  })

  it('bounds the original UTF-8 input before parsing', () => {
    const raw = `${' '.repeat(MAX_META_SIZE)}{"key":1}`

    expect(parseMeta(raw)).toEqual({})
    expect(parseMeta('{"$date":0,"nested":{"$binary":"AA=="}}')).toEqual({
      $date: 0,
      nested: { $binary: 'AA==' },
    })
  })

  it('returns {} for null input', () => {
    expect(parseMeta(null)).toEqual({})
  })

  it('returns {} for empty string', () => {
    expect(parseMeta('')).toEqual({})
  })

  it('returns {} for invalid JSON', () => {
    expect(parseMeta('not-json')).toEqual({})
  })

  it('returns {} for JSON that is not an object (array)', () => {
    expect(parseMeta('[1,2,3]')).toEqual({})
  })

  it('returns {} for JSON that is not an object (string)', () => {
    expect(parseMeta('"just a string"')).toEqual({})
  })

  it('returns {} for JSON that is not an object (number)', () => {
    expect(parseMeta('42')).toEqual({})
  })

  it('returns the parsed object for valid JSON object', () => {
    const result = parseMeta('{"key":"value","n":42}')
    expect(result).toEqual({ key: 'value', n: 42 })
  })

  it('applies validateMeta constraints (oversized JSON)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const large = JSON.stringify({ data: 'x'.repeat(MAX_META_SIZE) })

    expect(parseMeta(large)).toEqual({})
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// sendResponse
// ---------------------------------------------------------------------------

describe('sendResponse', () => {
  it('does nothing when node.socket is null', () => {
    const node = createMockNode({ socket: null })
    sendResponse(node as any, 'req-1', 'ok')
    // No error thrown, nothing to assert on send
  })

  it('does nothing when socket is not OPEN', () => {
    const node = createMockNode()
    node.socket.readyState = SocketState.CLOSED
    sendResponse(node as any, 'req-1', 'ok')
    expect(node.socket.send).not.toHaveBeenCalled()
  })

  it('does nothing when socket is CONNECTING', () => {
    const node = createMockNode()
    node.socket.readyState = SocketState.CONNECTING
    sendResponse(node as any, 'req-1', 'ok')
    expect(node.socket.send).not.toHaveBeenCalled()
  })

  it('sends encoded result payload when no error', () => {
    const node = createMockNode()
    sendResponse(node as any, 'req-1', { data: 'hello' })

    expect(node.socket.send).toHaveBeenCalledOnce()

    const sent = node.socket.send.mock.calls[0]![0]
    const decoded = Presentation.decode(sent) as any

    expect(decoded.t).toBe('rpc:res')
    expect(decoded.id).toBe('req-1')
    expect(decoded.result).toEqual({ data: 'hello' })
    expect(decoded.error).toBeUndefined()
  })

  it('sends encoded error payload', () => {
    const node = createMockNode()
    sendResponse(node as any, 'req-2', undefined, 'Something went wrong')

    const sent = node.socket.send.mock.calls[0]![0]
    const decoded = Presentation.decode(sent) as any

    expect(decoded.t).toBe('rpc:res')
    expect(decoded.id).toBe('req-2')
    expect(decoded.error).toBe('Something went wrong')
    expect(decoded.result).toBeUndefined()
  })

  it('sends error with validation errors array', () => {
    const node = createMockNode()
    sendResponse(node as any, 'req-3', undefined, 'Validation failed', [
      'field1 is required',
      'field2 must be a number',
    ])

    const sent = node.socket.send.mock.calls[0]![0]
    const decoded = Presentation.decode(sent) as any

    expect(decoded.error).toBe('Validation failed')
    expect(decoded.errors).toEqual([
      'field1 is required',
      'field2 must be a number',
    ])
  })

  it('sends undefined result (no error, no result)', () => {
    const node = createMockNode()
    sendResponse(node as any, 'req-4', undefined)

    const sent = node.socket.send.mock.calls[0]![0]
    const decoded = Presentation.decode(sent) as any

    expect(decoded.t).toBe('rpc:res')
    expect(decoded.id).toBe('req-4')
    expect(decoded.result).toBeUndefined()
    expect(decoded.error).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// handleRpc
// ---------------------------------------------------------------------------

describe('handleRpc', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('responds with RATE_LIMIT_EXCEEDED when limiter rejects', async () => {
    const node = createMockNode({
      limiter: { tryRemoveTokens: vi.fn().mockReturnValue(false) },
    })
    const server = createMockServer()

    await handleRpc(server as any, node as any, 'id-1', 'testMethod')

    const decoded = Presentation.decode(
      node.socket.send.mock.calls[0]![0]
    ) as any
    expect(decoded.error).toBe(Errors.RATE_LIMIT_EXCEEDED)
  })

  it('does not rate limit when limiter is null', async () => {
    const node = createMockNode()
    const server = createMockServer()

    await handleRpc(server as any, node as any, 'id-1', 'testMethod')

    const decoded = Presentation.decode(
      node.socket.send.mock.calls[0]![0]
    ) as any
    expect(decoded.result).toBe('result')
  })

  it('passes when limiter allows the request', async () => {
    const node = createMockNode({
      limiter: { tryRemoveTokens: vi.fn().mockReturnValue(true) },
    })
    const server = createMockServer()

    await handleRpc(server as any, node as any, 'id-1', 'testMethod')

    const decoded = Presentation.decode(
      node.socket.send.mock.calls[0]![0]
    ) as any
    expect(decoded.result).toBe('result')
  })

  it('responds with METHOD_NOT_FOUND for unknown methods', async () => {
    const node = createMockNode()
    const server = createMockServer()

    await handleRpc(server as any, node as any, 'id-2', 'nonExistentMethod')

    const decoded = Presentation.decode(
      node.socket.send.mock.calls[0]![0]
    ) as any
    expect(decoded.error).toBe(Errors.METHOD_NOT_FOUND)
  })

  it('responds with METHOD_FORBIDDEN for protected method without auth', async () => {
    const node = createMockNode({ authenticated: false })
    const method = createMockMethod({ isProtected: true })
    const server = createMockServer({
      methods: new Map([['protectedMethod', method]]),
    })

    await handleRpc(server as any, node as any, 'id-3', 'protectedMethod')

    const decoded = Presentation.decode(
      node.socket.send.mock.calls[0]![0]
    ) as any
    expect(decoded.error).toBe(Errors.METHOD_FORBIDDEN)
  })

  it('allows protected method when node is authenticated', async () => {
    const node = createMockNode({ authenticated: true })
    const method = createMockMethod({ isProtected: true })
    const server = createMockServer({
      methods: new Map([['protectedMethod', method]]),
    })

    await handleRpc(server as any, node as any, 'id-4', 'protectedMethod', {
      arg: 1,
    })

    expect(method.exec).toHaveBeenCalledWith({ arg: 1 }, node)

    const decoded = Presentation.decode(
      node.socket.send.mock.calls[0]![0]
    ) as any
    expect(decoded.result).toBe('result')
  })

  it('calls method.exec with params and node', async () => {
    const node = createMockNode()
    const server = createMockServer()

    await handleRpc(server as any, node as any, 'id-5', 'testMethod', {
      x: 10,
    })

    expect(server._method.exec).toHaveBeenCalledWith({ x: 10 }, node)
  })

  it('sends the exec result on success', async () => {
    const node = createMockNode()
    const method = createMockMethod({
      exec: vi.fn().mockResolvedValue({ hello: 'world' }),
    })
    const server = createMockServer({
      methods: new Map([['m', method]]),
    })

    await handleRpc(server as any, node as any, 'id-6', 'm')

    const decoded = Presentation.decode(
      node.socket.send.mock.calls[0]![0]
    ) as any
    expect(decoded.result).toEqual({ hello: 'world' })
  })

  it('handles PublicError by sending its message without internal error telemetry', async () => {
    const node = createMockNode()
    const method = createMockMethod({
      exec: vi.fn().mockRejectedValue(new PublicError('User-facing error')),
    })
    const server = createMockServer({
      methods: new Map([['m', method]]),
    })

    await handleRpc(server as any, node as any, 'id-7', 'm')

    const decoded = Presentation.decode(
      node.socket.send.mock.calls[0]![0]
    ) as any
    expect(decoded.error).toBe('User-facing error')

    expect(errorSpy).not.toHaveBeenCalled()
    expect(server.emit).not.toHaveBeenCalledWith(
      ServerEvents.METHOD_ERROR,
      expect.anything()
    )
  })

  it('handles SchemaValidationError by sending message and errors', async () => {
    const validationError = new SchemaValidationError('Validation failed', [
      'name is required',
      'age must be positive',
    ])
    const node = createMockNode()
    const method = createMockMethod({
      exec: vi.fn().mockRejectedValue(validationError),
    })
    const server = createMockServer({
      methods: new Map([['m', method]]),
    })

    await handleRpc(server as any, node as any, 'id-8', 'm')

    const decoded = Presentation.decode(
      node.socket.send.mock.calls[0]![0]
    ) as any
    expect(decoded.error).toBe('Validation failed')
    expect(decoded.errors).toEqual(['name is required', 'age must be positive'])
  })

  it('handles generic errors by sending INTERNAL_ERROR', async () => {
    const node = createMockNode()
    const method = createMockMethod({
      exec: vi.fn().mockRejectedValue(new Error('unexpected crash')),
    })
    const server = createMockServer({
      methods: new Map([['m', method]]),
    })

    await handleRpc(server as any, node as any, 'id-9', 'm')

    const decoded = Presentation.decode(
      node.socket.send.mock.calls[0]![0]
    ) as any
    expect(decoded.error).toBe(Errors.INTERNAL_ERROR)
  })

  it('emits METHOD_ERROR on server for all error types', async () => {
    const node = createMockNode({
      userId: 'user-1',
      context: { user: { email: 'test@example.com' } },
    })
    const method = createMockMethod({
      exec: vi.fn().mockRejectedValue(new Error('boom')),
    })
    const server = createMockServer({
      methods: new Map([['m', method]]),
    })

    await handleRpc(server as any, node as any, 'id-10', 'm', { p: 1 })

    expect(server.emit).toHaveBeenCalledWith(ServerEvents.METHOD_ERROR, {
      error: expect.any(Error),
      method: 'm',
      params: { p: 1 },
      userId: 'user-1',
      userEmail: 'test@example.com',
      remoteAddress: '127.0.0.1',
      userAgent: 'test',
    })
  })

  it('redacts error and parameters for sensitive method telemetry', async () => {
    const node = createMockNode()
    const method = createMockMethod({
      isSensitive: true,
      exec: vi.fn().mockRejectedValue(new Error('private failure')),
    })
    const server = createMockServer({
      methods: new Map([['m', method]]),
    })

    await handleRpc(server as any, node as any, 'id-sensitive', 'm', {
      secret: 'private-value',
    })

    expect(server.emit).toHaveBeenCalledWith(
      ServerEvents.METHOD_ERROR,
      expect.objectContaining({
        error: '[REDACTED]',
        method: 'm',
        params: '[REDACTED]',
      })
    )
  })
})

// ---------------------------------------------------------------------------
// handleRpcVoid
// ---------------------------------------------------------------------------

describe('handleRpcVoid', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('warns and returns when rate limited', async () => {
    const node = createMockNode({
      limiter: { tryRemoveTokens: vi.fn().mockReturnValue(false) },
    })
    const server = createMockServer()

    await handleRpcVoid(server as any, node as any, 'testMethod')

    expect(warnSpy).toHaveBeenCalledWith(
      '[TypeFerry] Rate limit exceeded for void call:',
      'testMethod'
    )
    expect(server._method.exec).not.toHaveBeenCalled()
  })

  it('does not rate limit when limiter is null', async () => {
    const node = createMockNode()
    const server = createMockServer()

    await handleRpcVoid(server as any, node as any, 'testMethod')

    expect(server._method.exec).toHaveBeenCalled()
  })

  it('warns when method is not found', async () => {
    const node = createMockNode()
    const server = createMockServer()

    await handleRpcVoid(server as any, node as any, 'unknownMethod')

    expect(warnSpy).toHaveBeenCalledWith(
      '[TypeFerry] Method not found for void call:',
      'unknownMethod'
    )
  })

  it('warns when protected method called without auth', async () => {
    const node = createMockNode({ authenticated: false })
    const method = createMockMethod({ isProtected: true })
    const server = createMockServer({
      methods: new Map([['protectedMethod', method]]),
    })

    await handleRpcVoid(server as any, node as any, 'protectedMethod')

    expect(warnSpy).toHaveBeenCalledWith(
      '[TypeFerry] Method forbidden for void call:',
      'protectedMethod'
    )
    expect(method.exec).not.toHaveBeenCalled()
  })

  it('allows protected method when authenticated', async () => {
    const node = createMockNode({ authenticated: true })
    const method = createMockMethod({ isProtected: true })
    const server = createMockServer({
      methods: new Map([['protectedMethod', method]]),
    })

    await handleRpcVoid(server as any, node as any, 'protectedMethod', {
      arg: 1,
    })

    expect(method.exec).toHaveBeenCalledWith({ arg: 1 }, node)
  })

  it('executes method successfully without sending any response', async () => {
    const node = createMockNode()
    const server = createMockServer()

    await handleRpcVoid(server as any, node as any, 'testMethod', {
      data: 'test',
    })

    expect(server._method.exec).toHaveBeenCalledWith({ data: 'test' }, node)
    // Void calls do NOT send a response
    expect(node.socket.send).not.toHaveBeenCalled()
  })

  it('logs error and emits METHOD_ERROR on execution failure', async () => {
    const error = new Error('exec failed')
    const node = createMockNode({
      userId: 'u1',
      context: { user: { email: 'a@b.com' } },
    })
    const method = createMockMethod({
      exec: vi.fn().mockRejectedValue(error),
    })
    const server = createMockServer({
      methods: new Map([['failMethod', method]]),
    })

    await handleRpcVoid(server as any, node as any, 'failMethod', { p: 1 })

    expect(errorSpy).toHaveBeenCalledWith(
      '[TypeFerry] Void method execution error:',
      error
    )

    expect(server.emit).toHaveBeenCalledWith(ServerEvents.METHOD_ERROR, {
      error,
      method: 'failMethod',
      params: { p: 1 },
      userId: 'u1',
      userEmail: 'a@b.com',
      remoteAddress: '127.0.0.1',
      userAgent: 'test',
    })

    // Still no response sent
    expect(node.socket.send).not.toHaveBeenCalled()
  })

  it('redacts sensitive void method error telemetry', async () => {
    const node = createMockNode()
    const method = createMockMethod({
      isSensitive: true,
      exec: vi.fn().mockRejectedValue(new Error('private failure')),
    })
    const server = createMockServer({
      methods: new Map([['failMethod', method]]),
    })

    await handleRpcVoid(server as any, node as any, 'failMethod', {
      secret: 'private-value',
    })

    expect(server.emit).toHaveBeenCalledWith(
      ServerEvents.METHOD_ERROR,
      expect.objectContaining({
        error: '[REDACTED]',
        params: '[REDACTED]',
      })
    )
  })

  it('handles error when context is null (no userEmail)', async () => {
    const node = createMockNode({ context: null })
    const method = createMockMethod({
      exec: vi.fn().mockRejectedValue(new Error('err')),
    })
    const server = createMockServer({
      methods: new Map([['m', method]]),
    })

    await handleRpcVoid(server as any, node as any, 'm')

    expect(server.emit).toHaveBeenCalledWith(
      ServerEvents.METHOD_ERROR,
      expect.objectContaining({ userEmail: undefined })
    )
  })
})

// ---------------------------------------------------------------------------
// authenticateNode
// ---------------------------------------------------------------------------

describe('authenticateNode', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('emits false when auth is disabled', async () => {
    const node = createMockNode()
    const server = createMockServer({ isAuthEnabled: false })

    await authenticateNode(server as any, node as any, 'some-token')

    expect(node.emitAuthResult).toHaveBeenCalledWith(false)
    expect(server.auth.call).not.toHaveBeenCalled()
  })

  it('emits false when token is undefined', async () => {
    const node = createMockNode()
    const server = createMockServer({ isAuthEnabled: true })

    await authenticateNode(server as any, node as any, undefined)

    expect(node.emitAuthResult).toHaveBeenCalledWith(false)
  })

  it('emits false when token is empty string (falsy)', async () => {
    const node = createMockNode()
    const server = createMockServer({ isAuthEnabled: true })

    await authenticateNode(server as any, node as any, '')

    expect(node.emitAuthResult).toHaveBeenCalledWith(false)
  })

  it('authenticates successfully with valid token', async () => {
    const authResult = { userId: 'user-1', user: { email: 'a@b.com' } }
    const node = createMockNode()
    const server = createMockServer({
      isAuthEnabled: true,
      auth: { call: vi.fn().mockResolvedValue(authResult) },
    })

    await authenticateNode(server as any, node as any, 'valid-token')

    expect(server.auth.call).toHaveBeenCalledWith(node, {
      token: 'valid-token',
    })
    expect(node.authenticated).toBe(true)
    expect(node.setContext).toHaveBeenCalledWith(authResult)
    expect(server.emit).toHaveBeenCalledWith(ServerEvents.AUTHENTICATION, node)
    expect(node.emitAuthResult).toHaveBeenCalledWith(true)
  })

  it('authenticates from application handshake metadata without a token', async () => {
    const result = { user: { _id: 'administrator' } }
    const node = createMockNode()
    const server = createMockServer({ isAuthEnabled: false })
    const handshake = {
      path: '/typeferry-ws',
      headers: { cookie: 'session=opaque' },
      query: {},
    }
    const authenticator = vi.fn().mockResolvedValue(result)

    await authenticateNode(
      server as any,
      node as any,
      undefined,
      authenticator,
      handshake,
    )

    expect(authenticator).toHaveBeenCalledWith(node, handshake)
    expect(server.auth.call).not.toHaveBeenCalled()
    expect(node.authenticated).toBe(true)
    expect(node.setContext).toHaveBeenCalledWith(result)
    expect(node.emitAuthResult).toHaveBeenCalledWith(true)
  })

  it('does not fall back to token auth after handshake rejection', async () => {
    const node = createMockNode()
    const server = createMockServer({ isAuthEnabled: true })

    await authenticateNode(
      server as any,
      node as any,
      'valid-token',
      vi.fn().mockResolvedValue(false),
      { path: '/typeferry-ws', headers: {}, query: { token: 'valid-token' } },
    )

    expect(server.auth.call).not.toHaveBeenCalled()
    expect(node.authenticated).toBe(false)
    expect(node.emitAuthResult).toHaveBeenCalledWith(false)
  })

  it('emits false when auth returns a falsy result', async () => {
    const node = createMockNode()
    const server = createMockServer({
      isAuthEnabled: true,
      auth: { call: vi.fn().mockResolvedValue(null) },
    })

    await authenticateNode(server as any, node as any, 'bad-token')

    expect(node.authenticated).toBe(false)
    expect(node.setContext).not.toHaveBeenCalled()
    expect(node.emitAuthResult).toHaveBeenCalledWith(false)
  })

  it('emits false when auth returns undefined', async () => {
    const node = createMockNode()
    const server = createMockServer({
      isAuthEnabled: true,
      auth: { call: vi.fn().mockResolvedValue(undefined) },
    })

    await authenticateNode(server as any, node as any, 'token')

    expect(node.authenticated).toBe(false)
    expect(node.emitAuthResult).toHaveBeenCalledWith(false)
  })

  it('does not emit auth result when socket disconnected during auth', async () => {
    const node = createMockNode()
    const server = createMockServer({
      isAuthEnabled: true,
      auth: {
        call: vi.fn().mockImplementation(async () => {
          // Simulate socket closing during auth
          node.socket.readyState = SocketState.CLOSED
          return { userId: 'u1' }
        }),
      },
    })

    await authenticateNode(server as any, node as any, 'token')

    // Should silently return without emitting
    expect(node.emitAuthResult).not.toHaveBeenCalled()
  })

  it('does not emit auth result when socket becomes null during auth', async () => {
    const node = createMockNode()
    const server = createMockServer({
      isAuthEnabled: true,
      auth: {
        call: vi.fn().mockImplementation(async () => {
          Reflect.set(node, 'socket', null)
          return { userId: 'u1' }
        }),
      },
    })

    await authenticateNode(server as any, node as any, 'token')

    expect(node.emitAuthResult).not.toHaveBeenCalled()
  })

  it('handles auth timeout by emitting false', async () => {
    vi.useFakeTimers()

    const node = createMockNode()
    const server = createMockServer({
      isAuthEnabled: true,
      auth: {
        call: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              // Never resolves
              setTimeout(resolve, AUTH_TIMEOUT_MS + 1000)
            })
        ),
      },
    })

    const authPromise = authenticateNode(
      server as any,
      node as any,
      'slow-token'
    )

    // Advance time past the timeout
    await vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS + 1)

    await authPromise

    expect(errorSpy).toHaveBeenCalledWith(
      '[TypeFerry] Auth error:',
      expect.any(Error)
    )
    expect(node.emitAuthResult).toHaveBeenCalledWith(false)

    vi.useRealTimers()
  })

  it('handles auth errors by emitting false when socket is still open', async () => {
    const node = createMockNode()
    const server = createMockServer({
      isAuthEnabled: true,
      auth: {
        call: vi.fn().mockRejectedValue(new Error('auth crash')),
      },
    })

    await authenticateNode(server as any, node as any, 'token')

    expect(errorSpy).toHaveBeenCalledWith(
      '[TypeFerry] Auth error:',
      expect.any(Error)
    )
    expect(node.emitAuthResult).toHaveBeenCalledWith(false)
  })

  it('does not emit auth result on error when socket is closed', async () => {
    const node = createMockNode()
    const server = createMockServer({
      isAuthEnabled: true,
      auth: {
        call: vi.fn().mockImplementation(async () => {
          node.socket.readyState = SocketState.CLOSED
          throw new Error('auth crash')
        }),
      },
    })

    await authenticateNode(server as any, node as any, 'token')

    expect(errorSpy).toHaveBeenCalled()
    expect(node.emitAuthResult).not.toHaveBeenCalled()
  })
})
