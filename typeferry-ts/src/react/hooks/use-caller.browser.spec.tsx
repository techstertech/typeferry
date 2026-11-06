import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { Client } from '../../client'
import { getPromise } from '../../utils/promise'
import { useCaller } from './use-caller'

afterEach(cleanup)

it('retries failures, shares pending calls, and expires results with browser timers', async () => {
  const client: Pick<Client, 'call'> = {
    call() { throw new Error('The test must configure this call') },
  }
  const failure = new Error('request failed')
  const pending = getPromise()
  const call = vi.spyOn(client, 'call')
    .mockResolvedValue('after-expiry')
    .mockRejectedValueOnce(failure)
    .mockReturnValueOnce(pending.promise)

  const { result } = renderHook(() =>
    useCaller({ client, cache: true, maxAge: 10 }),
  )
  const caller = result.current

  if (!caller) throw new Error('Expected memoized caller')

  await expect(caller('method')).rejects.toBe(failure)
  await new Promise<void>(resolve => queueMicrotask(resolve))

  const first = caller('method')

  expect(first).toBe(pending.promise)
  expect(caller('method')).toBe(first)
  expect(call).toHaveBeenCalledTimes(2)

  pending.resolve('cached-result')

  await expect(first).resolves.toBe('cached-result')
  expect(caller('method')).toBe(first)

  await expect.poll(() => {
    void caller('method')

    return call.mock.calls.length
  }).toBe(3)
})
