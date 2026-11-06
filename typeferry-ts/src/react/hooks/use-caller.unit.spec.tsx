// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Client } from '../../client'
import { getPromise } from '../../utils/promise'
import { useCaller } from './use-caller'
import type { MethodCaller } from './use-caller'

const createMockClient = () => {
  const client: Pick<Client, 'call'> = {
    call() { throw new Error('The test must configure this call') },
  }
  const call = vi.spyOn(client, 'call').mockResolvedValue('result')

  return { client, call }
}

function requireCaller(caller: MethodCaller | undefined): MethodCaller {
  if (!caller) throw new Error('Expected memoized caller')

  return caller
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useCaller', () => {
  it('returns undefined without a client', () => {
    const { result } = renderHook(() =>
      useCaller({ client: null, cache: true, maxAge: 5000 }),
    )

    expect(result.current).toBeUndefined()
  })

  it('returns client.call directly when cache is false', () => {
    const { client } = createMockClient()

    const { result } = renderHook(() =>
      useCaller({ client, cache: false, maxAge: 5000 }),
    )

    expect(result.current).toBe(client.call)
  })

  it('shares the original pending promise for equivalent EJSON arguments', async () => {
    const { client, call } = createMockClient()
    const pending = getPromise()
    const options = { timeout: 500 }

    call.mockReturnValue(pending.promise)

    const { result } = renderHook(() =>
      useCaller({ client, cache: true, maxAge: 5000 }),
    )
    const caller = requireCaller(result.current)
    const first = caller('method', { at: new Date(1000) }, options)
    const second = caller('method', { at: new Date(1000) }, { timeout: 500 })

    expect(caller).not.toBe(client.call)
    expect(first).toBe(pending.promise)
    expect(second).toBe(first)
    expect(client.call).toHaveBeenCalledExactlyOnceWith(
      'method', { at: new Date(1000) }, options,
    )

    pending.resolve('cached-result')

    await expect(first).resolves.toBe('cached-result')
    expect(caller('method', { at: new Date(1000) }, options)).toBe(first)
  })

  it('keeps methods, EJSON values, and call options in the cache key', async () => {
    const { client } = createMockClient()

    const { result } = renderHook(() =>
      useCaller({ client, cache: true, maxAge: 0 }),
    )
    const caller = requireCaller(result.current)

    await caller('method', { at: new Date(1000) }, { timeout: 500 })
    await caller('other', { at: new Date(1000) }, { timeout: 500 })
    await caller('method', { at: 1000 }, { timeout: 500 })
    await caller('method', { at: new Date(1000) }, { timeout: 1000 })

    expect(client.call).toHaveBeenCalledTimes(4)
  })

  it('treats omitted arguments and explicit undefined as the same EJSON key', async () => {
    const { client } = createMockClient()

    const { result } = renderHook(() =>
      useCaller({ client, cache: true, maxAge: 0 }),
    )
    const caller = requireCaller(result.current)

    await caller('method')
    await caller('method', undefined)
    await caller('method')

    expect(client.call).toHaveBeenCalledExactlyOnceWith('method')
  })

  it('retries after a rejected promise leaves the cache', async () => {
    vi.useFakeTimers()

    const failure = new Error('request failed')
    const { client, call } = createMockClient()

    call.mockRejectedValueOnce(failure).mockResolvedValue('retry-result')

    const { result } = renderHook(() =>
      useCaller({ client, cache: true, maxAge: 5000 }),
    )
    const caller = requireCaller(result.current)
    const first = caller('method')

    await expect(first).rejects.toBe(failure)
    await vi.advanceTimersByTimeAsync(0)
    await expect(caller('method')).resolves.toBe('retry-result')

    expect(client.call).toHaveBeenCalledTimes(2)
  })

  it('forwards the call receiver to the original client method', async () => {
    const { client, call } = createMockClient()

    call.mockImplementation(function (this: unknown) {
      return Promise.resolve(this)
    })

    const { result } = renderHook(() =>
      useCaller({ client, cache: true, maxAge: 0 }),
    )
    const caller = requireCaller(result.current)

    await expect(caller.call(client, 'method')).resolves.toBe(client)
  })

  it('does not cache a synchronous throw', async () => {
    const failure = new Error('request failed')
    const { client, call } = createMockClient()

    call.mockImplementationOnce(() => { throw failure })

    const { result } = renderHook(() =>
      useCaller({ client, cache: true, maxAge: 0 }),
    )
    const caller = requireCaller(result.current)

    expect(() => caller('method')).toThrow(failure)
    await expect(caller('method')).resolves.toBe('result')
    expect(client.call).toHaveBeenCalledTimes(2)
  })

  it('starts expiry after fulfillment and does not extend it on a cache hit', async () => {
    vi.useFakeTimers()

    const { client, call } = createMockClient()
    const pending = getPromise()

    call.mockReturnValueOnce(pending.promise)

    const { result } = renderHook(() =>
      useCaller({ client, cache: true, maxAge: 100 }),
    )
    const caller = requireCaller(result.current)
    const first = caller('method')

    await vi.advanceTimersByTimeAsync(1000)

    expect(caller('method')).toBe(first)
    expect(client.call).toHaveBeenCalledTimes(1)

    pending.resolve('result')

    await first
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(99)

    expect(caller('method')).toBe(first)

    await vi.advanceTimersByTimeAsync(1)
    await caller('method')

    expect(client.call).toHaveBeenCalledTimes(2)
  })

  it.each([0, -100, Number.NaN])('does not expire for maxAge=%s', async maxAge => {
    vi.useFakeTimers()

    const { client } = createMockClient()

    const { result } = renderHook(() => useCaller({ client, cache: true, maxAge }))
    const caller = requireCaller(result.current)
    const first = caller('method')

    await first
    await vi.advanceTimersByTimeAsync(100000)

    expect(caller('method')).toBe(first)
    expect(client.call).toHaveBeenCalledTimes(1)
  })

  it('truncates fractional expiry intervals', async () => {
    vi.useFakeTimers()

    const { client } = createMockClient()

    const { result } = renderHook(() =>
      useCaller({ client, cache: true, maxAge: 100.9 }),
    )
    const caller = requireCaller(result.current)

    await caller('method')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100)
    await caller('method')

    expect(client.call).toHaveBeenCalledTimes(2)
  })

  it.each([2 ** 31, Number.POSITIVE_INFINITY])(
    'rejects expiry intervals outside the timer range: %s', maxAge => {
      const { client } = createMockClient()

      expect(() => renderHook(() => useCaller({ client, cache: true, maxAge })))
        .toThrow(TypeError)
    },
  )

  it('retains the caller for unchanged hook dependencies and resets changed caches', async () => {
    const { client } = createMockClient()
    const { client: otherClient } = createMockClient()
    const initialProps = { client, cache: true, maxAge: 0 }

    const { result, rerender } = renderHook(props => useCaller(props), { initialProps })
    const first = requireCaller(result.current)

    await first('method')
    rerender({ ...initialProps })

    expect(result.current).toBe(first)
    expect(requireCaller(result.current)('method')).toBe(first('method'))

    rerender({ ...initialProps, maxAge: 100 })

    expect(result.current).not.toBe(first)
    await requireCaller(result.current)('method')
    expect(client.call).toHaveBeenCalledTimes(2)

    rerender({ ...initialProps, cache: false })

    expect(result.current).toBe(client.call)

    rerender({ ...initialProps })

    await requireCaller(result.current)('method')
    expect(client.call).toHaveBeenCalledTimes(3)

    rerender({ ...initialProps, client: otherClient })

    await requireCaller(result.current)('method')
    expect(otherClient.call).toHaveBeenCalledTimes(1)
  })
})
