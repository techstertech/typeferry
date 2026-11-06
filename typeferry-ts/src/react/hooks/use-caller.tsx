import { useMemo } from 'react'

import type { Client } from '../../client'
import { EJSON } from '../../ejson'
import type { CallOptions } from '../../utils'

export type MethodCaller = (
  method: string,
  params?: unknown,
  options?: CallOptions,
) => Promise<unknown>

interface UseCallerOptions {
  readonly client: Pick<Client, 'call'> | null
  readonly cache: boolean
  readonly maxAge: number
}

const MAX_TIMEOUT_MS = 2 ** 31 - 1

/**
 * Share pending requests and retain successful results for a fulfillment-based
 * lifetime. A failed request must leave the cache so the next call can retry.
 */
function createCachedCaller(call: MethodCaller, maxAge: number): MethodCaller {
  const lifetime = Math.max(0, Math.trunc(maxAge) || 0)

  if (lifetime > MAX_TIMEOUT_MS) {
    throw new TypeError(`${lifetime} exceeds maximum possible timeout`)
  }

  const entries = new Map<string, Promise<unknown>>()

  return function (this: unknown, ...parameters: Parameters<MethodCaller>) {
    // Serialize the arguments object so omitted and undefined properties share
    // a key. An array would instead encode undefined values as nulls.
    const key = EJSON.stringify(arguments)
    const cached = entries.get(key)

    if (cached) return cached

    const promise = call.apply(this, parameters)

    entries.set(key, promise)

    void promise.then(
      () => {
        if (!lifetime) return

        const timeout = setTimeout(() => entries.delete(key), lifetime)

        timeout.unref?.()
      },
      () => { entries.delete(key) },
    )

    return promise
  }
}

export function useCaller({
  client,
  cache,
  maxAge,
}: UseCallerOptions): MethodCaller | undefined {
  return useMemo(() => {
    if (!client) return undefined

    if (!cache) return client.call

    return createCachedCaller(client.call, maxAge)
  }, [cache, client, maxAge])
}
