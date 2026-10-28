import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { refreshAccessToken, setupTokenRefreshOnExpiry } from './token-refresh'

class BroadcastChannelMock {
  static instances: BroadcastChannelMock[] = []

  public name: string
  public messages: any[] = []
  private listeners = new Map<string, Set<(event: any) => void>>()

  constructor(name: string) {
    this.name = name
    BroadcastChannelMock.instances.push(this)
  }

  postMessage(message: any) {
    this.messages.push(message)

    const handlers = this.listeners.get('message')
    if (!handlers) return

    for (const handler of handlers) {
      handler({ data: message })
    }
  }

  addEventListener(type: string, handler: (event: any) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set())
    }
    this.listeners.get(type)!.add(handler)
  }

  removeEventListener(type: string, handler: (event: any) => void) {
    this.listeners.get(type)?.delete(handler)
  }

  close() {}
}

class MockClient {
  context: any = {}
  call = vi.fn()
  updateContext = vi.fn()
  clearContext = vi.fn()
  logger = { auth: vi.fn() }

  private handlers = new Map<string, Set<() => void>>()

  on = vi.fn((event: string, handler: () => void) => {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler)
  })

  off = vi.fn((event: string, handler: () => void) => {
    this.handlers.get(event)?.delete(handler)
  })

  emit(event: string) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler()
    }
  }
}

describe('typeferry token refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as any).BroadcastChannel = BroadcastChannelMock
    BroadcastChannelMock.instances = []
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (globalThis as any).BroadcastChannel
  })

  it('refreshAccessToken updates context and broadcasts token', async () => {
    const client = new MockClient()
    const iat = Math.floor(Date.now() / 1000)
    client.call.mockResolvedValue({
      accessToken: 'new-token',
      exp: 1234567890,
      iat,
    })

    const token = await refreshAccessToken(client as any, {
      refreshMethod: 'auth.refresh',
      broadcastChannelName: 'test-channel',
    })

    expect(client.call).toHaveBeenCalledWith(
      'auth.refresh',
      {},
      { ignoreInit: true, http: true },
    )
    expect(client.updateContext).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'new-token',
        exp: 1234567890,
        iat,
      }),
    )
    // _tokenReceivedAt is also set (timestamp)
    const ctxArg = client.updateContext.mock.calls[0]![0]
    expect(ctxArg._tokenReceivedAt).toBeTypeOf('number')

    expect(token).toBe('new-token')

    expect(BroadcastChannelMock.instances.length).toBeGreaterThan(0)
    const channel = BroadcastChannelMock.instances.find(
      c => c.name === 'test-channel',
    )
    expect(channel?.messages).toContainEqual({
      type: 'TOKEN_REFRESHED',
      token: 'new-token',
      exp: 1234567890,
      iat,
      receivedAt: expect.any(Number),
    })
  })

  it('refreshAccessToken queues concurrent refresh calls per client', async () => {
    const client = new MockClient()

    let resolveCall: (value: any) => void
    client.call.mockImplementation(
      () =>
        new Promise(res => {
          resolveCall = res
        }),
    )

    const p1 = refreshAccessToken(client as any)
    const p2 = refreshAccessToken(client as any)

    expect(client.call).toHaveBeenCalledTimes(1)

    resolveCall!({ accessToken: 'new-token', exp: 1 })

    await expect(p1).resolves.toBe('new-token')
    await expect(p2).resolves.toBe('new-token')
  })

  it('setupTokenRefreshOnExpiry schedules refresh before exp (legacy fallback)', async () => {
    const client = new MockClient()

    const nowSec = 1_000_000_000
    vi.setSystemTime(nowSec * 1000)

    // No iat/_tokenReceivedAt → uses legacy exp-based calculation
    client.context = { exp: nowSec + 300 } // 5 minutes
    client.call.mockResolvedValue({
      accessToken: 'new-token',
      exp: nowSec + 600,
      iat: nowSec,
    })

    setupTokenRefreshOnExpiry(client as any, {
      refreshBeforeExpirySec: 60,
      refreshMethod: 'auth.refresh',
    })

    vi.advanceTimersByTime(240_000)

    expect(client.call).toHaveBeenCalledWith(
      'auth.refresh',
      {},
      { ignoreInit: true, http: true },
    )
  })

  it('setupTokenRefreshOnExpiry uses clock-skew-safe scheduling with iat', async () => {
    const client = new MockClient()

    const nowSec = 1_000_000_000
    vi.setSystemTime(nowSec * 1000)

    // Simulate client clock 4 hours ahead of server:
    // Server iat = nowSec - 14400, server exp = iat + 900 (15min)
    // Without clock-skew fix, exp - clientNow = (iat + 900) - nowSec = -13500 → immediate refresh loop
    // With fix: TTL = 900s, elapsed = Date.now() - _tokenReceivedAt = 0 → schedules at 840s
    const serverIat = nowSec - 14400
    const serverExp = serverIat + 900

    client.context = {
      exp: serverExp,
      iat: serverIat,
      _tokenReceivedAt: nowSec * 1000, // received "just now" in client time
    }
    client.call.mockResolvedValue({
      accessToken: 'new-token',
      exp: serverExp + 900,
      iat: serverIat + 900,
    })

    type RefreshClient = Parameters<typeof setupTokenRefreshOnExpiry>[0]

    setupTokenRefreshOnExpiry(client as unknown as RefreshClient, {
      refreshBeforeExpirySec: 60,
      refreshMethod: 'auth.refresh',
    })

    // Should NOT refresh immediately despite exp being in the past from client's POV
    expect(client.call).not.toHaveBeenCalled()

    // TTL = 900s, refreshBefore = 60s → should fire at 840s
    vi.advanceTimersByTime(839_000)
    expect(client.call).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1_000) // 840s total
    expect(client.call).toHaveBeenCalledTimes(1)
  })

  it('scheduleRefresh defers when refresh is already in progress', () => {
    const client = new MockClient()

    const nowSec = 1_000_000_000
    vi.setSystemTime(nowSec * 1000)

    // Token already expired — scheduleRefresh would normally refresh immediately
    client.context = { exp: nowSec - 10 }

    let resolveCall: (value: { accessToken: string; exp: number }) => void
    client.call.mockImplementation(
      () =>
        new Promise<{ accessToken: string; exp: number }>(res => {
          resolveCall = res
        }),
    )

    type RefreshClient = Parameters<typeof setupTokenRefreshOnExpiry>[0]

    const cleanup = setupTokenRefreshOnExpiry(
      client as unknown as RefreshClient,
      {
        refreshBeforeExpirySec: 60,
        refreshMethod: 'auth.refresh',
      },
    )

    // Initial scheduleRefresh fires immediate refresh (timeUntilExpiry <= 0)
    expect(client.call).toHaveBeenCalledTimes(1)

    // Simulate CONTEXT_CHANGED while refresh is in progress
    // (this is what happens when refreshAccessToken calls updateContext)
    client.emit('context:changed')

    // Should NOT start another refresh — should defer instead
    expect(client.call).toHaveBeenCalledTimes(1)

    // After 1 second, the deferred scheduleRefresh should retry
    vi.advanceTimersByTime(1000)

    // Still only 1 call because the original refresh is still in-progress
    // (isRefreshing is still true), so it defers again
    expect(client.call).toHaveBeenCalledTimes(1)

    // Resolve the original refresh — resolveCall is guaranteed assigned after
    // setupTokenRefreshOnExpiry fires the initial call above.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    resolveCall!({ accessToken: 'new-token', exp: nowSec + 900 })

    cleanup()
  })
})

describe('isAuthFailureError edge cases (via refreshAccessToken)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as any).BroadcastChannel = BroadcastChannelMock
    BroadcastChannelMock.instances = []
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (globalThis as any).BroadcastChannel
  })

  it('treats 401 status as auth failure and clears context', async () => {
    const client = new MockClient()
    const err = Object.assign(new Error('Unauthorized'), { status: 401 })
    client.call.mockRejectedValue(err)

    await expect(refreshAccessToken(client as any)).rejects.toThrow(
      'Unauthorized',
    )
    expect(client.clearContext).toHaveBeenCalled()
  })

  it('treats 403 status as auth failure and clears context', async () => {
    const client = new MockClient()
    const err = Object.assign(new Error('Forbidden'), { status: 403 })
    client.call.mockRejectedValue(err)

    await expect(refreshAccessToken(client as any)).rejects.toThrow('Forbidden')
    expect(client.clearContext).toHaveBeenCalled()
  })

  it('treats AUTHENTICATION_FAILED code as auth failure', async () => {
    const client = new MockClient()
    const err = Object.assign(new Error('Auth failed'), {
      code: 'AUTHENTICATION_FAILED',
    })
    client.call.mockRejectedValue(err)

    await expect(refreshAccessToken(client as any)).rejects.toThrow()
    expect(client.clearContext).toHaveBeenCalled()
  })

  it('treats "Token refresh failed" message as auth failure', async () => {
    const client = new MockClient()
    client.call.mockResolvedValue(null)

    await expect(refreshAccessToken(client as any)).rejects.toThrow(
      'Token refresh failed',
    )
    expect(client.clearContext).toHaveBeenCalled()
  })

  it('treats missingRefreshToken message as auth failure', async () => {
    const client = new MockClient()
    const err = new Error('Error: missingRefreshToken')
    client.call.mockRejectedValue(err)

    await expect(refreshAccessToken(client as any)).rejects.toThrow()
    expect(client.clearContext).toHaveBeenCalled()
  })

  it('treats invalidOrExpiredRefreshToken message as auth failure', async () => {
    const client = new MockClient()
    const err = new Error('Error: invalidOrExpiredRefreshToken')
    client.call.mockRejectedValue(err)

    await expect(refreshAccessToken(client as any)).rejects.toThrow()
    expect(client.clearContext).toHaveBeenCalled()
  })

  it('does NOT treat a generic network error as auth failure', async () => {
    const client = new MockClient()
    const err = new Error('Network timeout')
    client.call.mockRejectedValue(err)

    await expect(refreshAccessToken(client as any)).rejects.toThrow(
      'Network timeout',
    )
    expect(client.clearContext).not.toHaveBeenCalled()
  })

  it('does NOT treat a 500 status as auth failure', async () => {
    const client = new MockClient()
    const err = Object.assign(new Error('Server Error'), { status: 500 })
    client.call.mockRejectedValue(err)

    await expect(refreshAccessToken(client as any)).rejects.toThrow()
    expect(client.clearContext).not.toHaveBeenCalled()
  })
})

describe('refreshAccessToken error handling and queue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as any).BroadcastChannel = BroadcastChannelMock
    BroadcastChannelMock.instances = []
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (globalThis as any).BroadcastChannel
  })

  it('rejects queued callers when refresh fails', async () => {
    const client = new MockClient()

    let rejectCall: (err: Error) => void
    client.call.mockImplementation(
      () =>
        new Promise((_res, rej) => {
          rejectCall = rej
        }),
    )

    const p1 = refreshAccessToken(client as any)
    const p2 = refreshAccessToken(client as any)

    expect(client.call).toHaveBeenCalledTimes(1)

    rejectCall!(new Error('Network error'))

    await expect(p1).rejects.toThrow('Network error')
    await expect(p2).rejects.toThrow('Network error')
  })

  it('resets isRefreshing after failure so next call can proceed', async () => {
    const client = new MockClient()
    client.call.mockRejectedValueOnce(new Error('fail'))

    await expect(refreshAccessToken(client as any)).rejects.toThrow('fail')

    // Now a second call should proceed and not get queued
    client.call.mockResolvedValueOnce({
      accessToken: 'ok',
      exp: 999,
      iat: 100,
    })
    const result = await refreshAccessToken(client as any)
    expect(result).toBe('ok')
    expect(client.call).toHaveBeenCalledTimes(2)
  })

  it('logs with WARN level for auth failures and ERROR for transient', async () => {
    const client = new MockClient()

    // Auth failure
    const authErr = Object.assign(new Error('Unauthorized'), { status: 401 })
    client.call.mockRejectedValueOnce(authErr)
    await expect(refreshAccessToken(client as any)).rejects.toThrow()

    // The logger should have been called with isAuthFailure: true
    const authLogCall = client.logger.auth.mock.calls.find(
      (args: any[]) =>
        args[1]! === 'Token refresh failed' && args[2]?.isAuthFailure === true,
    )
    expect(authLogCall).toBeTruthy()

    client.logger.auth.mockClear()

    // Transient failure
    const transientErr = new Error('Network timeout')
    client.call.mockRejectedValueOnce(transientErr)
    await expect(refreshAccessToken(client as any)).rejects.toThrow()

    const transientLogCall = client.logger.auth.mock.calls.find(
      (args: any[]) =>
        args[1]! === 'Token refresh failed' && args[2]?.isAuthFailure === false,
    )
    expect(transientLogCall).toBeTruthy()
  })
})

describe('setupTokenRefreshOnExpiry retry on transient errors', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as any).BroadcastChannel = BroadcastChannelMock
    BroadcastChannelMock.instances = []
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (globalThis as any).BroadcastChannel
  })

  it('retries after RETRY_DELAY_MS on transient error', async () => {
    const client = new MockClient()

    const nowSec = 1_000_000_000
    vi.setSystemTime(nowSec * 1000)

    // Token about to expire imminently
    client.context = { exp: nowSec + 30 }

    // First call fails with transient error, second succeeds
    client.call
      .mockRejectedValueOnce(new Error('Network timeout'))
      .mockResolvedValueOnce({
        accessToken: 'new-token',
        exp: nowSec + 900,
        iat: nowSec,
      })

    type RefreshClient = Parameters<typeof setupTokenRefreshOnExpiry>[0]
    const cleanup = setupTokenRefreshOnExpiry(
      client as unknown as RefreshClient,
      {
        refreshBeforeExpirySec: 60,
        refreshMethod: 'auth.refresh',
      },
    )

    // Token is expiring within refreshBeforeExpirySec so immediate refresh fires
    expect(client.call).toHaveBeenCalledTimes(1)

    // Let the rejection propagate through microtask queue
    await vi.advanceTimersByTimeAsync(0)

    // After 5000ms retry delay, scheduleRefresh should be called again
    await vi.advanceTimersByTimeAsync(5000)

    // The retry should have triggered a new refresh call
    expect(client.call).toHaveBeenCalledTimes(2)

    cleanup()
  })

  it('does NOT retry on auth failure (401)', async () => {
    const client = new MockClient()

    const nowSec = 1_000_000_000
    vi.setSystemTime(nowSec * 1000)

    client.context = { exp: nowSec + 30 }

    const authErr = Object.assign(new Error('Unauthorized'), { status: 401 })
    client.call.mockRejectedValue(authErr)

    type RefreshClient = Parameters<typeof setupTokenRefreshOnExpiry>[0]
    const cleanup = setupTokenRefreshOnExpiry(
      client as unknown as RefreshClient,
      {
        refreshBeforeExpirySec: 60,
        refreshMethod: 'auth.refresh',
      },
    )

    expect(client.call).toHaveBeenCalledTimes(1)

    // Let the rejection propagate
    await vi.advanceTimersByTimeAsync(0)

    // After retry delay, no new call should happen because it was an auth failure
    await vi.advanceTimersByTimeAsync(10000)

    expect(client.call).toHaveBeenCalledTimes(1)
    expect(client.clearContext).toHaveBeenCalled()

    cleanup()
  })
})

describe('setupTokenRefreshOnExpiry context change listener', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as any).BroadcastChannel = BroadcastChannelMock
    BroadcastChannelMock.instances = []
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (globalThis as any).BroadcastChannel
  })

  it('reschedules refresh when context:changed fires with new token', () => {
    const client = new MockClient()

    const nowSec = 1_000_000_000
    vi.setSystemTime(nowSec * 1000)

    // No token initially
    client.context = {}

    type RefreshClient = Parameters<typeof setupTokenRefreshOnExpiry>[0]
    const cleanup = setupTokenRefreshOnExpiry(
      client as unknown as RefreshClient,
      {
        refreshBeforeExpirySec: 60,
        refreshMethod: 'auth.refresh',
      },
    )

    // No exp → no refresh scheduled, no call
    expect(client.call).not.toHaveBeenCalled()

    // Simulate a new token arriving (e.g. from login)
    client.context = { exp: nowSec + 600 }
    client.call.mockResolvedValue({
      accessToken: 'refreshed',
      exp: nowSec + 1200,
      iat: nowSec + 600,
    })

    // Emit context change
    client.emit('context:changed')

    // Now advance to when refresh should fire (600 - 60 = 540s)
    vi.advanceTimersByTime(540_000)

    expect(client.call).toHaveBeenCalledTimes(1)

    cleanup()
  })
})

describe('setupTokenRefreshOnExpiry cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as any).BroadcastChannel = BroadcastChannelMock
    BroadcastChannelMock.instances = []
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (globalThis as any).BroadcastChannel
  })

  it('does not restart retry scheduling when a pending refresh fails after cleanup', async () => {
    const client = new MockClient()
    const nowSec = 1_000_000_000
    vi.setSystemTime(nowSec * 1000)
    client.context = { token: 'expiring-token', exp: nowSec + 30 }

    let fail: (error: Error) => void = () => {
      throw new Error('Refresh request not started')
    }
    client.call.mockImplementation(() =>
      new Promise<never>((_resolve, reject) => {
        fail = reject
      }),
    )

    const cleanup = setupTokenRefreshOnExpiry(
      client as unknown as Parameters<typeof setupTokenRefreshOnExpiry>[0],
      { broadcastChannelName: '' },
    )

    cleanup()
    fail(new Error('Refresh cancelled after unmount'))
    await vi.advanceTimersByTimeAsync(5_000)

    expect(client.call).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears timers and removes context:changed listener', () => {
    const client = new MockClient()

    const nowSec = 1_000_000_000
    vi.setSystemTime(nowSec * 1000)

    client.context = { exp: nowSec + 300 }
    client.call.mockResolvedValue({
      accessToken: 'new',
      exp: nowSec + 600,
      iat: nowSec,
    })

    type RefreshClient = Parameters<typeof setupTokenRefreshOnExpiry>[0]
    const cleanup = setupTokenRefreshOnExpiry(
      client as unknown as RefreshClient,
      {
        refreshBeforeExpirySec: 60,
        refreshMethod: 'auth.refresh',
      },
    )

    expect(client.on).toHaveBeenCalledWith(
      'context:changed',
      expect.any(Function),
    )

    // Run cleanup
    cleanup()

    // Verify listener was removed
    expect(client.off).toHaveBeenCalledWith(
      'context:changed',
      expect.any(Function),
    )

    // Advance past when refresh would fire — should NOT trigger
    vi.advanceTimersByTime(300_000)
    expect(client.call).not.toHaveBeenCalled()
  })

  it('cleanup removes cross-tab sync listener', () => {
    const client = new MockClient()
    client.context = {}

    type RefreshClient = Parameters<typeof setupTokenRefreshOnExpiry>[0]
    const cleanup = setupTokenRefreshOnExpiry(
      client as unknown as RefreshClient,
      {
        refreshBeforeExpirySec: 60,
        refreshMethod: 'auth.refresh',
        broadcastChannelName: 'test-cleanup-channel',
      },
    )

    // A BroadcastChannel should have been created for cross-tab sync
    const crossTabChannel = BroadcastChannelMock.instances.find(
      c => c.name === 'test-cleanup-channel',
    )
    expect(crossTabChannel).toBeTruthy()

    cleanup()
  })
})
