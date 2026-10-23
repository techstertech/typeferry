import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CallOptions } from '../utils'
import { ClientEvents, TOKEN_HEADER_KEY } from '../utils'
import { refreshAccessToken } from '../auth/client/token-refresh'
import { Client } from './client'

vi.mock('./client-socket', () => ({
  ClientSocket: class {
    ready = true
    connecting = false
    connect = vi.fn()
    close = vi.fn().mockResolvedValue(undefined)
    send = vi.fn()
    emitWithAck = vi.fn().mockResolvedValue('ok')
  },
}))
vi.mock('./visibility-manager', () => ({
  VisibilityManager: class {
    destroy = vi.fn()
  },
}))

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred promise was not initialized')
  }
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

describe('opt-in request admission', () => {
  let client: Client

  beforeEach(async () => {
    vi.useFakeTimers()
    client = new Client()
    await client.initialize()
  })

  afterEach(async () => {
    await client.close()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('holds calls and void sends, while admitting public control requests', async () => {
    const ready = deferred<void>()
    client.options.beforeDispatch = ({ method }) => method === 'public.read' ? undefined : ready.promise
    const send = vi.spyOn(client.clientSocket, 'send')
    const ack = vi.spyOn(client.clientSocket, 'emitWithAck')
    const call = client.call('private.write')
    const notification = client.void('private.notify')

    await expect(client.call('public.read')).resolves.toBe('ok')
    expect(ack).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
    ready.resolve()
    await Promise.all([call, notification])
    expect(ack).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledOnce()
  })

  it('reads current credentials after waiting before HTTP fallback', async () => {
    const ready = deferred<void>()
    client.options.beforeDispatch = () => ready.promise
    client.context = { token: 'old' }
    const httpFetch = vi.fn().mockResolvedValue(new Response('{"result":"ok"}'))
    client.options.httpFetch = httpFetch
    const request = client.call('private.write', {}, { http: true })
    client.context = { token: 'current' }
    ready.resolve()
    await expect(request).resolves.toBe('ok')
    expect(httpFetch).toHaveBeenCalledOnce()
    expect(httpFetch.mock.calls[0]?.[1]?.headers[TOKEN_HEADER_KEY]).toBe('current')
  })

  it.each(['abort', 'timeout', 'close'] as const)('cancels admission on %s and never sends later', async reason => {
    const ready = deferred<void>()
    const controller = new AbortController()
    client.options.beforeDispatch = () => ready.promise
    const ack = vi.spyOn(client.clientSocket, 'emitWithAck')
    const request = client.call('private.write', {}, { signal: controller.signal, timeout: 100 })
    const rejected = expect(request).rejects.toBeDefined()
    if (reason === 'abort') controller.abort()
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(100)
    if (reason === 'close') await client.close()
    await rejected
    ready.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(ack).not.toHaveBeenCalled()
  })

  it('checks a session invalidated immediately after admission resolves', async () => {
    const session = new AbortController()
    client.options.beforeDispatch = () => {
      queueMicrotask(() => session.abort())
      return { signal: session.signal }
    }
    const ack = vi.spyOn(client.clientSocket, 'emitWithAck')
    await expect(client.call('private.write')).rejects.toBeDefined()
    expect(ack).not.toHaveBeenCalled()
  })

  it('cancels initialization waiters on session end without later dispatch', async () => {
    const session = new AbortController()
    client.options.beforeDispatch = () => ({ signal: session.signal })
    client.initialized = false
    const ack = vi.spyOn(client.clientSocket, 'emitWithAck')
    const request = client.call('private.write')
    const rejected = expect(request).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(0)
    session.abort()
    await rejected
    expect(client.listenerCount(ClientEvents.INITIALIZED)).toBe(0)
    await client.initialize()
    expect(ack).not.toHaveBeenCalled()
  })

  it('deducts admission and initialization from the existing timeout', async () => {
    const ready = deferred<void>()
    client.options.beforeDispatch = () => ready.promise
    client.initialized = false
    const ack = vi.spyOn(client.clientSocket, 'emitWithAck')
    const request = client.call('private.write', {}, { timeout: 2000 })
    await vi.advanceTimersByTimeAsync(400)
    ready.resolve()
    await vi.advanceTimersByTimeAsync(500)
    await client.initialize()
    await request
    expect(ack).toHaveBeenCalledWith('rpc', { method: 'private.write', params: {} }, 1100)
  })

  it('bounds HTTP response waiting and ignores its late completion', async () => {
    const response = deferred<Response>()
    client.options.beforeDispatch = () => undefined
    client.options.httpFetch = vi.fn(() => response.promise)
    const inbound = vi.fn()
    client.on(ClientEvents.INBOUND_MESSAGE, inbound)
    const request = client.call('private.write', {}, { http: true, timeout: 100 })
    const rejected = expect(request).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    const init = vi.mocked(client.options.httpFetch).mock.calls[0]?.[1]
    expect(init?.signal?.aborted).toBe(true)
    response.resolve(new Response('{"result":"late"}'))
    await vi.advanceTimersByTimeAsync(0)
    expect(inbound).not.toHaveBeenCalled()
  })

  it('rejects obsolete socket results without replaying a sent write', async () => {
    const session = new AbortController()
    const response = deferred<string>()
    client.options.beforeDispatch = () => ({ signal: session.signal })
    const ack = vi.spyOn(client.clientSocket, 'emitWithAck').mockReturnValue(response.promise)
    const request = client.call('private.write')
    const rejected = expect(request).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(0)
    session.abort()
    await rejected
    response.resolve('late')
    await vi.advanceTimersByTimeAsync(0)
    expect(ack).toHaveBeenCalledOnce()
  })

  it('does not replay a sent write when the connection loses its acknowledgement', async () => {
    client.options.beforeDispatch = () => undefined
    const ack = vi.spyOn(client.clientSocket, 'emitWithAck').mockRejectedValue(new Error('Connection lost'))

    await expect(client.call('private.write')).rejects.toThrow('Connection lost')
    expect(ack).toHaveBeenCalledOnce()
  })

  it('does not retry rejected admission even when transport retries were requested', async () => {
    const hook = vi.fn(() => { throw new Error('session ended') })
    client.options.beforeDispatch = hook
    const ack = vi.spyOn(client.clientSocket, 'emitWithAck')
    await expect(client.call('private.write', {}, { maxRetries: 3 })).rejects.toThrow('session ended')
    expect(hook).toHaveBeenCalledOnce()
    expect(ack).not.toHaveBeenCalled()
  })

  it.each(['logout', 'account-change'] as const)('does not republish a refresh token when %s follows RPC delivery', async transition => {
    const session = new AbortController()
    client.context = { token: 'old-session' }
    client.options.beforeDispatch = () => ({ signal: session.signal })
    client.options.httpFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      result: { accessToken: 'late-token', exp: 9999999999, iat: 1 },
    })))
    const originalCall = client.call.bind(client)
    vi.spyOn(client, 'call').mockImplementation(async <P = Record<string, unknown>, R = unknown>(
      method: string, params?: P, options?: CallOptions,
    ): Promise<R> => {
      const result = await originalCall<P, R>(method, params, options)
      // The admitted RPC completed, then the application logged out before
      // refreshAccessToken's own continuation could publish its credentials.
      client.clearContext()
      if (transition === 'account-change') client.setContext({ token: 'new-account' })
      session.abort()
      return result
    })

    await expect(refreshAccessToken(client, { broadcastChannelName: '' })).rejects.toBeDefined()
    expect(client.context.token).toBe(transition === 'logout' ? undefined : 'new-account')
  })

  it('rechecks admission when credentials rotate before dispatch', async () => {
    const ready = deferred<void>()
    const session = new AbortController()
    client.context = { token: 'old' }
    client.authenticated = true
    const hook = vi.fn(() => {
      if (!client.authenticated) return ready.promise.then(() => ({ signal: session.signal }))
      queueMicrotask(() => {
        client.context = { token: 'rotated' }
        client.authenticated = false
      })
      return { signal: session.signal }
    })
    client.options.beforeDispatch = hook
    const ack = vi.spyOn(client.clientSocket, 'emitWithAck')
    const request = client.call('private.write')
    await vi.advanceTimersByTimeAsync(0)
    expect(ack).not.toHaveBeenCalled()
    expect(hook).toHaveBeenCalledTimes(2)
    client.authenticated = true
    ready.resolve()
    await request
    expect(ack).toHaveBeenCalledOnce()
  })

  it('does not clear a newer account after an obsolete terminal refresh failure', async () => {
    client.context = { token: 'old-session' }
    client.options.beforeDispatch = () => undefined
    client.options.httpFetch = vi.fn(async () => {
      client.setContext({ token: 'new-account' })
      return new Response('expired', { status: 401 })
    })

    await expect(refreshAccessToken(client, { broadcastChannelName: '' })).rejects.toBeDefined()
    expect(client.context.token).toBe('new-account')
  })

  it('settles admitted HTTP void sends without expecting an RPC result', async () => {
    client.options.beforeDispatch = () => undefined
    client.options.httpFetch = vi.fn().mockResolvedValue(new Response(''))
    await expect(client.void('private.notify', {}, { http: true })).resolves.toBeUndefined()
  })
})
