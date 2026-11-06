import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

import { rateLimiter } from './hono-rate-limit'

const LOCAL_PEER = '127.0.0.1'

async function requestFrom(
  app: Hono,
  address: string = LOCAL_PEER,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(
    '/',
    { headers },
    {
      incoming: { socket: { remoteAddress: address } },
    },
  )
}

describe('rateLimiter', () => {
  it('rounds reset seconds up and starts a new window at expiry', async () => {
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const limiter = rateLimiter({ windowMs: 1501, max: 2 })
    const app = new Hono()

    app.use('*', limiter)
    app.get('/', context => context.text('ok'))

    try {
      const first = await requestFrom(app)

      expect(first.headers.get('ratelimit-remaining')).toBe('1')
      expect(first.headers.get('ratelimit-reset')).toBe('2')

      now = 1000
      const second = await requestFrom(app)

      expect(second.headers.get('ratelimit-remaining')).toBe('0')
      expect(second.headers.get('ratelimit-reset')).toBe('1')

      now = 1501
      const renewed = await requestFrom(app)

      expect(renewed.status).toBe(200)
      expect(renewed.headers.get('ratelimit-remaining')).toBe('1')
      expect(renewed.headers.get('ratelimit-reset')).toBe('2')
    } finally {
      limiter.close()
      clock.mockRestore()
    }
  })

  it('allows requests under the limit', async () => {
    const app = new Hono()
    app.use('*', rateLimiter({ windowMs: 60_000, max: 5 }))
    app.get('/', c => c.text('ok'))

    for (let i = 0; i < 5; i++) {
      const res = await requestFrom(app)
      expect(res.status).toBe(200)
    }
  })

  it('rejects requests over the limit', async () => {
    const app = new Hono()
    app.use('*', rateLimiter({ windowMs: 60_000, max: 2 }))
    app.get('/', c => c.text('ok'))

    await requestFrom(app)
    await requestFrom(app)
    const res = await requestFrom(app)

    expect(res.status).toBe(429)
    expect(await res.text()).toBe('Too Many Requests')
  })

  it('tracks distinct connection peers separately without forwarding headers', async () => {
    const app = new Hono()
    app.use('*', rateLimiter({ windowMs: 60_000, max: 1 }))
    app.get('/', c => c.text('ok'))

    const res1 = await requestFrom(app, '192.0.2.1')
    const res2 = await requestFrom(app, '192.0.2.2')

    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
  })

  it('does not grant a fresh quota when one peer changes forwarding headers', async () => {
    const limiter = rateLimiter({ windowMs: 60_000, max: 1 })
    const app = new Hono()

    app.use('*', limiter)
    app.get('/', c => c.text('ok'))

    try {
      expect((await requestFrom(app)).status).toBe(200)

      for (const forwardedAddress of ['203.0.113.1', '203.0.113.2']) {
        const response = await requestFrom(app, LOCAL_PEER, {
          'x-forwarded-for': forwardedAddress,
        })

        expect(response.status).toBe(429)
        expect(response.headers.get('ratelimit-remaining')).toBe('0')
      }
    } finally {
      limiter.close()
    }
  })
})
