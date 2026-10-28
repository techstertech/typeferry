import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Client } from '../../client'
import {
  ContextManager,
  isTokenExpired,
  type TypeFerryContext,
} from '../../client/context-manager'
import { broadcastTokenRefresh, setupCrossTabSync } from './cross-tab-sync'

// ---------------------------------------------------------------------------
// BroadcastChannel mock
// ---------------------------------------------------------------------------

type MessageHandler = (event: { data: any }) => void

class BroadcastChannelMock {
  static instances: BroadcastChannelMock[] = []
  static reset() {
    BroadcastChannelMock.instances = []
  }

  public name: string
  public addEventListener = vi.fn(
    (_type: string, handler: MessageHandler) => {
      this._handler = handler
    },
  )
  public removeEventListener = vi.fn()
  public postMessage = vi.fn()
  public close = vi.fn()

  /** The most recently registered "message" handler for easy simulation. */
  private _handler: MessageHandler | null = null

  constructor(name: string) {
    this.name = name
    BroadcastChannelMock.instances.push(this)
  }

  /** Helper: simulate an incoming message on this channel. */
  simulateMessage(data: any) {
    if (this._handler) {
      this._handler({ data })
    }
  }
}

function latestChannel(): BroadcastChannelMock {
  const channel = BroadcastChannelMock.instances.at(-1)
  if (!channel) throw new Error('Expected BroadcastChannel to be created')

  return channel
}

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

function createMockClient() {
  return {
    context: { token: 'current-token' },
    updateContext: vi.fn(),
    setContext: vi.fn(),
    emit: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cross-tab-sync', () => {
  beforeEach(() => {
    BroadcastChannelMock.reset()
    vi.stubGlobal('BroadcastChannel', BroadcastChannelMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // -----------------------------------------------------------------------
  // setupCrossTabSync
  // -----------------------------------------------------------------------

  describe('setupCrossTabSync', () => {
    it('returns a noop cleanup when BroadcastChannel is unavailable (SSR)', () => {
      vi.stubGlobal('BroadcastChannel', undefined)

      const client = createMockClient()
      const cleanup = setupCrossTabSync(client as any, {
        channelName: 'test-channel',
      })

      expect(typeof cleanup).toBe('function')
      // Should not throw
      cleanup()
      // No channel should have been created
      expect(BroadcastChannelMock.instances).toHaveLength(0)
    })

    it('creates a BroadcastChannel with the configured channelName', () => {
      const client = createMockClient()
      setupCrossTabSync(client as any, { channelName: 'my-app-tokens' })

      expect(BroadcastChannelMock.instances).toHaveLength(1)
      expect(latestChannel().name).toBe('my-app-tokens')
    })

    it('registers a message event listener on the channel', () => {
      const client = createMockClient()
      setupCrossTabSync(client as any, { channelName: 'ch' })

      const channel = latestChannel()
      expect(channel.addEventListener).toHaveBeenCalledWith(
        'message',
        expect.any(Function),
      )
    })

    it('updates client context when a valid TOKEN_REFRESHED message is received', () => {
      const client = createMockClient()
      setupCrossTabSync(client as any, { channelName: 'ch' })

      const channel = latestChannel()
      channel.simulateMessage({
        type: 'TOKEN_REFRESHED',
        token: 'new-jwt',
        exp: 1700000000,
      })

      expect(client.setContext).toHaveBeenCalledOnce()
      expect(client.setContext).toHaveBeenCalledWith({
        token: 'new-jwt',
        exp: 1700000000,
      })
    })

    it('uses issuance time when a legacy sender has no clock-skew anchor', () => {
      const client = createMockClient()
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(9999999)

      setupCrossTabSync(client as any, { channelName: 'ch' })

      const channel = latestChannel()
      channel.simulateMessage({
        type: 'TOKEN_REFRESHED',
        token: 'jwt-with-iat',
        exp: 1700000000,
        iat: 1699990000,
      })

      expect(client.updateContext).toHaveBeenCalledWith({
        token: 'jwt-with-iat',
        exp: 1700000000,
        iat: 1699990000,
        _tokenReceivedAt: 1699990000 * 1000,
      })

      nowSpy.mockRestore()
    })

    it('does not set iat or _tokenReceivedAt when iat is not a number', () => {
      const client = createMockClient()
      setupCrossTabSync(client as any, { channelName: 'ch' })

      const channel = latestChannel()
      channel.simulateMessage({
        type: 'TOKEN_REFRESHED',
        token: 'tok',
        exp: 100,
        iat: 'not-a-number',
      })

      expect(client.setContext).toHaveBeenCalledWith({
        token: 'tok',
        exp: 100,
      })
    })

    it('emits tokenRefreshedEvent on the client when configured', () => {
      const client = createMockClient()
      setupCrossTabSync(client as any, {
        channelName: 'ch',
        tokenRefreshedEvent: 'auth:token-refreshed',
      })

      const channel = latestChannel()
      channel.simulateMessage({
        type: 'TOKEN_REFRESHED',
        token: 'tok',
        exp: 200,
      })

      expect(client.emit).toHaveBeenCalledOnce()
      expect(client.emit).toHaveBeenCalledWith('auth:token-refreshed', {
        token: 'tok',
        exp: 200,
      })
    })

    it('does not emit when tokenRefreshedEvent is not configured', () => {
      const client = createMockClient()
      setupCrossTabSync(client as any, { channelName: 'ch' })

      const channel = latestChannel()
      channel.simulateMessage({
        type: 'TOKEN_REFRESHED',
        token: 'tok',
        exp: 200,
      })

      expect(client.emit).not.toHaveBeenCalled()
    })

    describe('ignores invalid messages', () => {
      it.each([
        ['wrong type', { type: 'WRONG_TYPE', token: 'tok', exp: 100 }],
        ['missing type', { token: 'tok', exp: 100 }],
        ['missing token', { type: 'TOKEN_REFRESHED', exp: 100 }],
        ['non-string token', { type: 'TOKEN_REFRESHED', token: 123, exp: 100 }],
        ['missing exp', { type: 'TOKEN_REFRESHED', token: 'tok' }],
        ['non-number exp', { type: 'TOKEN_REFRESHED', token: 'tok', exp: 'str' }],
        ['null data', null],
        ['undefined data', undefined],
        ['empty object', {}],
      ])('does not call updateContext for %s', (_label, data) => {
        const client = createMockClient()
        setupCrossTabSync(client as any, { channelName: 'ch' })

        const channel = latestChannel()
        channel.simulateMessage(data)

        expect(client.updateContext).not.toHaveBeenCalled()
        expect(client.emit).not.toHaveBeenCalled()
      })
    })

    it('cleanup removes listener and closes the channel', () => {
      const client = createMockClient()
      const cleanup = setupCrossTabSync(client as any, { channelName: 'ch' })

      const channel = latestChannel()

      cleanup()

      expect(channel.removeEventListener).toHaveBeenCalledWith(
        'message',
        expect.any(Function),
      )
      expect(channel.close).toHaveBeenCalledOnce()
    })

    it('cleanup removes the exact handler that was registered', () => {
      const client = createMockClient()
      const cleanup = setupCrossTabSync(client as any, { channelName: 'ch' })

      const channel = latestChannel()
      const registeredHandler = channel.addEventListener.mock.calls[0]![1]

      cleanup()

      expect(channel.removeEventListener).toHaveBeenCalledWith(
        'message',
        registeredHandler,
      )
    })
  })

  // -----------------------------------------------------------------------
  // broadcastTokenRefresh
  // -----------------------------------------------------------------------

  describe('broadcastTokenRefresh', () => {
    it('is a no-op when BroadcastChannel is unavailable (SSR)', () => {
      vi.stubGlobal('BroadcastChannel', undefined)

      // Should not throw
      broadcastTokenRefresh('ch', 'tok', 100)

      expect(BroadcastChannelMock.instances).toHaveLength(0)
    })

    it('creates a channel, posts a message, and closes', () => {
      broadcastTokenRefresh('sync-channel', 'my-token', 1700000000)

      expect(BroadcastChannelMock.instances).toHaveLength(1)

      const channel = latestChannel()
      expect(channel.name).toBe('sync-channel')

      expect(channel.postMessage).toHaveBeenCalledOnce()
      expect(channel.postMessage).toHaveBeenCalledWith({
        type: 'TOKEN_REFRESHED',
        token: 'my-token',
        exp: 1700000000,
        iat: undefined,
        receivedAt: expect.any(Number),
      })

      expect(channel.close).toHaveBeenCalledOnce()
    })

    it('includes iat in the message when provided', () => {
      broadcastTokenRefresh('ch', 'tok', 2000, 1000)

      const channel = latestChannel()

      expect(channel.postMessage).toHaveBeenCalledWith({
        type: 'TOKEN_REFRESHED',
        token: 'tok',
        exp: 2000,
        iat: 1000,
        receivedAt: expect.any(Number),
      })
    })

    it('closes the channel after posting the message', () => {
      broadcastTokenRefresh('ch', 'tok', 100)

      const channel = latestChannel()

      // Verify close was called
      expect(channel.close).toHaveBeenCalledOnce()

      // Verify ordering: postMessage was called before close
      const postOrder = channel.postMessage.mock.invocationCallOrder[0]!
      const closeOrder = channel.close.mock.invocationCallOrder[0]!
      if (postOrder === undefined || closeOrder === undefined) {
        throw new Error('Expected postMessage and close invocation order')
      }

      expect(postOrder).toBeLessThan(closeOrder)
    })
  })
})

describe('delayed cross-tab token delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    BroadcastChannelMock.reset()
    vi.stubGlobal('BroadcastChannel', BroadcastChannelMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function tokenContext(
    issuedAt: number,
    receivedAt = issuedAt * 1000,
  ): TypeFerryContext {
    return {
      token: `token-${issuedAt}`,
      iat: issuedAt,
      exp: issuedAt + 900,
      _tokenReceivedAt: receivedAt,
    }
  }

  function receive(context: TypeFerryContext, receivedAt?: number): void {
    latestChannel().simulateMessage({
      type: 'TOKEN_REFRESHED',
      token: context.token,
      iat: context.iat,
      exp: context.exp,
      ...(receivedAt === undefined ? {} : { receivedAt }),
    })
  }

  function syncContext(context: TypeFerryContext): ContextManager {
    const manager = new ContextManager()
    manager.setContext(context)

    const client = {
      get context(): TypeFerryContext {
        return manager.context
      },
      updateContext: manager.updateContext.bind(manager),
      setContext: manager.setContext.bind(manager),
    } as unknown as Client

    setupCrossTabSync(client, { channelName: 'session' })

    return manager
  }

  it('includes the sender timestamp in the existing broadcast', () => {
    const issuedAt = Date.now() / 1000

    broadcastTokenRefresh('session', `token-${issuedAt}`, issuedAt + 900, issuedAt)

    expect(latestChannel().postMessage).toHaveBeenCalledWith({
      type: 'TOKEN_REFRESHED',
      token: `token-${issuedAt}`,
      iat: issuedAt,
      exp: issuedAt + 900,
      receivedAt: Date.now(),
    })
  })

  it('preserves the sender receipt time after sleep', () => {
    const issuedAt = Date.now() / 1000 - 3600
    const manager = syncContext(tokenContext(issuedAt - 900))

    receive(tokenContext(issuedAt), issuedAt * 1000)

    expect(manager.context._tokenReceivedAt).toBe(issuedAt * 1000)
    expect(isTokenExpired(manager.context)).toBe(true)
  })

  it('keeps timely delivery independent of server clock skew', () => {
    const issuedAt = Date.now() / 1000 - 14_400
    const receivedAt = Date.now() - 120_000
    const manager = syncContext(tokenContext(issuedAt - 900, receivedAt - 900_000))

    receive(tokenContext(issuedAt), receivedAt)

    expect(manager.context._tokenReceivedAt).toBe(receivedAt)
    expect(isTokenExpired(manager.context)).toBe(false)

    vi.advanceTimersByTime(781_000)

    expect(isTokenExpired(manager.context)).toBe(true)
  })

  it('does not overwrite newer credentials', () => {
    const issuedAt = Date.now() / 1000
    const context = tokenContext(issuedAt)
    const manager = syncContext(context)

    receive(tokenContext(issuedAt - 60), Date.now())

    expect(manager.context).toBe(context)
  })

  it('orders rotations from the same second by receipt time', () => {
    const context = tokenContext(Date.now() / 1000)
    const manager = syncContext(context)

    receive({ ...context, token: 'older-rotation' }, Date.now() - 1)

    expect(manager.context).toBe(context)
  })

  it('does not renew the age of an identical token', () => {
    const context = tokenContext(Date.now() / 1000 - 120)
    const manager = syncContext(context)

    receive(context, Date.now())

    expect(manager.context).toBe(context)
  })

  it('does not resurrect terminal logout', () => {
    const manager = syncContext(tokenContext(Date.now() / 1000 - 600))
    manager.clearContext()

    receive(tokenContext(Date.now() / 1000), Date.now())

    expect(manager.context).toEqual({})
  })

  it('preserves legacy sender age through an existing clock-skew anchor', () => {
    const issuedAt = Date.now() / 1000 - 14_400
    const receivedAt = Date.now() - 120_000
    const manager = syncContext(tokenContext(issuedAt - 900, receivedAt - 900_000))

    receive(tokenContext(issuedAt))

    expect(manager.context._tokenReceivedAt).toBe(receivedAt)
    expect(isTokenExpired(manager.context)).toBe(false)
  })

  it('does not grant a fresh lifetime to a legacy sender without a clock anchor', () => {
    const issuedAt = Date.now() / 1000 - 3600
    const manager = syncContext({ token: 'legacy-context' })

    receive(tokenContext(issuedAt))

    expect(isTokenExpired(manager.context)).toBe(true)
  })

  it('clears obsolete timing metadata for a legacy sender without iat', () => {
    const manager = syncContext(tokenContext(Date.now() / 1000 - 600))
    const exp = Date.now() / 1000 + 600

    receive({ token: 'legacy-token', exp })

    expect(manager.context).toEqual({ token: 'legacy-token', exp })
  })
})
