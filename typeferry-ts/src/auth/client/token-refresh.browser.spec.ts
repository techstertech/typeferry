import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Client } from '../../client'
import { ContextManager } from '../../client/context-manager'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../../client/request-lifetime'
import { ClientEvents, type CallOptions } from '../../utils'
import { setupCrossTabSync } from './cross-tab-sync'
import { refreshAccessToken } from './token-refresh'

interface TokenResponse {
  readonly accessToken: string
  readonly exp: number
  readonly iat: number
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => { throw new Error('Deferred promise not initialized') }
  const promise = new Promise<T>(complete => { resolve = complete })

  return { promise, resolve }
}

class RefreshClient extends ContextManager {
  readonly call = vi.fn<(
    method: string,
    params: Record<string, never>,
    options: CallOptions,
  ) => Promise<TokenResponse>>()
  readonly logger = { auth: vi.fn() }

  constructor() {
    super()

    const iat = Math.floor(Date.now() / 1000) - 600

    this.setContext({
      token: 'original-token',
      iat,
      exp: iat + 900,
      _tokenReceivedAt: iat * 1000,
    })
  }
}

function refresh(client: RefreshClient, channel: string): Promise<string | null> {
  return refreshAccessToken(client as unknown as Client, { broadcastChannelName: channel })
}

function response(token: string): TokenResponse {
  const iat = Math.floor(Date.now() / 1000)

  return { accessToken: token, iat, exp: iat + 900 }
}

async function holdPeerLock(channel: string): Promise<{
  readonly name: string
  readonly release: () => Promise<void>
}> {
  const name = `typeferry:refresh:${JSON.stringify([channel, 'auth.refresh'])}`
  const frame = document.createElement('iframe')
  document.body.append(frame)

  const peer = frame.contentWindow
  if (!peer) {
    frame.remove()
    throw new Error('Expected a same-origin document')
  }

  const entered = deferred<void>()
  const released = deferred<void>()
  const blocker = peer.navigator.locks.request(name, () => {
    entered.resolve()
    return released.promise
  })

  await entered.promise

  return {
    name,
    release: async (): Promise<void> => {
      released.resolve()
      await blocker
      frame.remove()
    },
  }
}

describe('browser refresh ownership', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shares refresh ownership with another same-origin document', async () => {
    const channel = `refresh-${crypto.randomUUID()}`
    const peer = await holdPeerLock(channel)
    const client = new RefreshClient()
    client.call.mockResolvedValue(response('renewed-token'))

    try {
      const renewal = refresh(client, channel)
      await expect.poll(async () => (await navigator.locks.query()).pending?.some(lock => lock.name === peer.name)).toBe(true)

      expect(client.call).not.toHaveBeenCalled()

      await peer.release()
      await expect(renewal).resolves.toBe('renewed-token')
    } finally {
      await peer.release()
    }
  })

  it('expires a queued renewal within the existing request budget and never sends it later', async () => {
    const channel = `refresh-${crypto.randomUUID()}`
    const peer = await holdPeerLock(channel)
    const client = new RefreshClient()
    client.call.mockResolvedValue(response('late-token'))

    vi.useFakeTimers()

    let result: PromiseSettledResult<string | null> | undefined
    const renewal = refresh(client, channel).then(
      value => { result = { status: 'fulfilled', value } },
      reason => { result = { status: 'rejected', reason: reason as unknown } },
    )

    try {
      await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS)

      expect(result).toMatchObject({
        status: 'rejected',
        reason: { message: 'TypeFerry: Request timed out' },
      })

      await peer.release()
      await navigator.locks.request(peer.name, () => undefined)

      expect(client.call).not.toHaveBeenCalled()
    } finally {
      await peer.release()
      await renewal
    }
  })

  it('deducts lock acquisition time from the HTTP request budget', async () => {
    const channel = `refresh-${crypto.randomUUID()}`
    const peer = await holdPeerLock(channel)
    const client = new RefreshClient()
    const dispatched = deferred<CallOptions>()

    client.call.mockImplementation((_method, _params, options) => {
      dispatched.resolve(options)
      return Promise.resolve(response('renewed-token'))
    })

    vi.useFakeTimers()

    try {
      const renewal = refresh(client, channel)

      await vi.advanceTimersByTimeAsync(3_000)
      await peer.release()

      expect((await dispatched.promise).timeout).toBe(DEFAULT_REQUEST_TIMEOUT_MS - 3_000)
      await expect(renewal).resolves.toBe('renewed-token')
    } finally {
      await peer.release()
    }
  })

  it('serializes overlapping cookie rotations through the browser lock manager', async () => {
    const channel = `refresh-${crypto.randomUUID()}`
    const first = new RefreshClient()
    const second = new RefreshClient()
    const firstReply = deferred<TokenResponse>()
    const secondReply = deferred<TokenResponse>()

    first.call.mockReturnValue(firstReply.promise)
    second.call.mockReturnValue(secondReply.promise)

    const firstRefresh = refresh(first, channel)
    await expect.poll(() => first.call.mock.calls.length).toBe(1)

    const secondRefresh = refresh(second, channel)
    await expect.poll(async () => (await navigator.locks.query()).pending?.filter(lock => lock.name?.includes(channel)).length).toBe(1)

    expect(second.call).not.toHaveBeenCalled()

    firstReply.resolve(response('first-renewal'))
    await expect(firstRefresh).resolves.toBe('first-renewal')
    await expect.poll(() => second.call.mock.calls.length).toBe(1)

    secondReply.resolve(response('second-renewal'))
    await expect(secondRefresh).resolves.toBe('second-renewal')
  })

  it.each(['close', 'logout', 'token-removal', 'account-change'] as const)(
    'cancels a queued renewal on %s without sending it later',
    async transition => {
      const channel = `refresh-${crypto.randomUUID()}`
      const first = new RefreshClient()
      const second = new RefreshClient()
      const firstReply = deferred<TokenResponse>()

      first.call.mockReturnValue(firstReply.promise)
      second.call.mockResolvedValue(response('obsolete-renewal'))

      const firstRefresh = refresh(first, channel)
      await expect.poll(() => first.call.mock.calls.length).toBe(1)

      const secondRefresh = refresh(second, channel)
      const outcome = secondRefresh.then(
        value => ({ status: 'fulfilled' as const, value }),
        error => ({ status: 'rejected' as const, error: error as unknown }),
      )
      await expect.poll(async () => (await navigator.locks.query()).pending?.filter(lock => lock.name?.includes(channel)).length).toBe(1)

      if (transition === 'close') second.emit(ClientEvents.CLOSE)
      if (transition === 'logout') second.emit(ClientEvents.LOGOUT)
      if (transition === 'token-removal') second.clearContext()
      if (transition === 'account-change') second.setContext({ token: 'new-account' })

      expect(await outcome).toMatchObject({ status: 'rejected' })
      firstReply.resolve(response('first-renewal'))
      await firstRefresh

      expect(second.call).not.toHaveBeenCalled()
    },
  )

  it('continues to honor explicit refresh calls when the access token is valid', async () => {
    const client = new RefreshClient()
    const channel = `refresh-${crypto.randomUUID()}`

    client.call.mockResolvedValueOnce(response('first-renewal')).mockResolvedValueOnce(response('second-renewal'))

    await expect(refresh(client, channel)).resolves.toBe('first-renewal')
    await expect(refresh(client, channel)).resolves.toBe('second-renewal')

    expect(client.call).toHaveBeenCalledTimes(2)
  })

  it('converges peer credentials through the real browser broadcast channel', async () => {
    const first = new RefreshClient()
    const second = new RefreshClient()
    const channel = `refresh-${crypto.randomUUID()}`
    const cleanupFirst = setupCrossTabSync(first as unknown as Client, { channelName: channel })
    const cleanupSecond = setupCrossTabSync(second as unknown as Client, { channelName: channel })
    const broadcast = vi.spyOn(BroadcastChannel.prototype, 'postMessage')

    first.call.mockResolvedValue(response('shared-renewal'))

    try {
      await refresh(first, channel)
      await expect.poll(() => second.context.token).toBe('shared-renewal')

      const message: unknown = broadcast.mock.calls[0]?.[0]
      if (typeof message !== 'object' || message === null || !('receivedAt' in message)) {
        throw new Error('Expected a token broadcast with its receipt time')
      }

      expect(second.context).toMatchObject({
        token: first.context.token,
        iat: first.context.iat,
        exp: first.context.exp,
        _tokenReceivedAt: message.receivedAt,
      })
      expect(second.call).not.toHaveBeenCalled()
    } finally {
      cleanupFirst()
      cleanupSecond()
    }
  })

  it.each(['close', 'logout', 'token-removal'] as const)(
    'cancels an in-flight renewal on %s and releases ownership',
    async transition => {
      const client = new RefreshClient()
      const channel = `refresh-${crypto.randomUUID()}`
      const lateReply = deferred<TokenResponse>()
      const dispatched = deferred<CallOptions>()
      const context = client.context
      const broadcast = vi.spyOn(BroadcastChannel.prototype, 'postMessage')

      client.call.mockImplementation((_method, _params, options) => {
        dispatched.resolve(options)
        return lateReply.promise
      })

      let result: PromiseSettledResult<string | null> | undefined
      const renewal = refresh(client, channel).then(
        value => { result = { status: 'fulfilled', value } },
        reason => { result = { status: 'rejected', reason: reason as unknown } },
      )

      try {
        const options = await dispatched.promise

        if (transition === 'close') client.emit(ClientEvents.CLOSE)
        if (transition === 'logout') client.emit(ClientEvents.LOGOUT)
        if (transition === 'token-removal') client.clearContext()

        expect(options.signal?.aborted).toBe(true)
        await navigator.locks.query()
        expect(result).toMatchObject({ status: 'rejected' })

        lateReply.resolve(response('obsolete-token'))
        await renewal

        const next = new RefreshClient()
        next.call.mockResolvedValue(response('next-token'))
        await expect(refresh(next, channel)).resolves.toBe('next-token')

        if (transition === 'token-removal') expect(client.context).toEqual({})
        else expect(client.context).toBe(context)
        expect(broadcast.mock.calls.some(([message]) => (message as { token?: string }).token === 'obsolete-token')).toBe(false)
        expect(client.listenerCount(ClientEvents.CLOSE)).toBe(0)
        expect(client.listenerCount(ClientEvents.LOGOUT)).toBe(0)
        expect(client.listenerCount(ClientEvents.CONTEXT_CHANGED)).toBe(0)
      } finally {
        lateReply.resolve(response('obsolete-token'))
        await renewal
      }
    },
  )

  it('lets a sent cookie response settle after a peer publishes a fresh generation', async () => {
    const client = new RefreshClient()
    const lateReply = deferred<TokenResponse>()
    const dispatched = deferred<CallOptions>()
    const broadcast = vi.spyOn(BroadcastChannel.prototype, 'postMessage')

    client.call.mockImplementation((_method, _params, options) => {
      dispatched.resolve(options)
      return lateReply.promise
    })

    const renewal = refresh(client, `refresh-${crypto.randomUUID()}`)
    const outcome = renewal.then(
      value => ({ status: 'fulfilled' as const, value }),
      reason => ({ status: 'rejected' as const, reason: reason as unknown }),
    )

    try {
      const options = await dispatched.promise
      const replacement = { token: 'peer-renewal' }

      client.setContext(replacement)

      expect(options.signal?.aborted).toBe(false)

      lateReply.resolve(response('obsolete-token'))
      expect(await outcome).toMatchObject({ status: 'rejected' })
      expect(client.context).toBe(replacement)
      expect(broadcast).not.toHaveBeenCalled()
    } finally {
      lateReply.resolve(response('obsolete-token'))
      await outcome
    }
  })
})
