import { getConnInfo } from '@hono/node-server/conninfo'
import type { MiddlewareHandler } from 'hono'

interface RateLimitEntry {
  count: number
  resetAt: number
}

interface RateLimitOptions {
  windowMs: number
  max: number
}

const MILLISECONDS_PER_SECOND = 1000
const MAX_RATE_LIMIT_BUCKETS = 100_000

/** Hono middleware whose cleanup timer follows its owning transport lifecycle. */
export type DisposableRateLimiter = MiddlewareHandler & {
  close(): void
}

/**
 * Fixed-window rate limiter keyed by the Node connection peer.
 * Forwarded client identity remains the host's trust decision.
 */
export function rateLimiter(opts: RateLimitOptions): DisposableRateLimiter {
  const store = new Map<string | undefined, RateLimitEntry>()

  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key)
    }
  }, opts.windowMs)
  // A limiter must never keep an otherwise-closed Node process alive.
  cleanupTimer.unref()

  const middleware: DisposableRateLimiter = async (c, next) => {
    const peerAddress = getConnInfo(c).remote.address
    const now = Date.now()

    let entry = store.get(peerAddress)
    if (!entry || entry.resetAt <= now) {
      if (entry) {
        // Remove expired entry before re-inserting so Map order matches expiration order.
        store.delete(peerAddress)
      } else if (store.size >= MAX_RATE_LIMIT_BUCKETS) {
        // Evict expired head entries first, then oldest bucket in O(1) amortized time.
        while (store.size >= MAX_RATE_LIMIT_BUCKETS) {
          const head = store.entries().next()
          if (head.done) break
          store.delete(head.value[0])
          if (head.value[1].resetAt > now) break
        }
      }
      entry = { count: 0, resetAt: now + opts.windowMs }
      store.set(peerAddress, entry)
    }

    entry.count++

    c.header('RateLimit-Limit', String(opts.max))
    c.header('RateLimit-Remaining', String(Math.max(0, opts.max - entry.count)))
    c.header(
      'RateLimit-Reset',
      String(
        Math.ceil(Math.max(0, entry.resetAt - now) / MILLISECONDS_PER_SECOND),
      ),
    )

    if (entry.count > opts.max) {
      return c.text('Too Many Requests', 429)
    }

    await next()
  }

  middleware.close = (): void => {
    clearInterval(cleanupTimer)
    store.clear()
  }

  return middleware
}
