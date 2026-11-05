import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

import { rateLimiter } from './hono-rate-limit'

describe('rateLimiter', () => {
  it('rounds reset seconds up and starts a new window at expiry', async () => {
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const limiter = rateLimiter({ windowMs: 1501, max: 2 })
    const app = new Hono()

    app.use('*', limiter)
    app.get('/', context => context.text('ok'))

    try {
      const first = await app.request('/')

      expect(first.headers.get('ratelimit-remaining')).toBe('1')
      expect(first.headers.get('ratelimit-reset')).toBe('2')

      now = 1000
      const second = await app.request('/')

      expect(second.headers.get('ratelimit-remaining')).toBe('0')
      expect(second.headers.get('ratelimit-reset')).toBe('1')

      now = 1501
      const renewed = await app.request('/')

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
      const res = await app.request('/')
      expect(res.status).toBe(200)
    }
  })

  it('rejects requests over the limit', async () => {
    const app = new Hono()
    app.use('*', rateLimiter({ windowMs: 60_000, max: 2 }))
    app.get('/', c => c.text('ok'))

    await app.request('/')
    await app.request('/')
    const res = await app.request('/')

    expect(res.status).toBe(429)
    expect(await res.text()).toBe('Too Many Requests')
  })

  it('tracks different IPs separately', async () => {
    const app = new Hono()
    app.use('*', rateLimiter({ windowMs: 60_000, max: 1 }))
    app.get('/', c => c.text('ok'))

    const res1 = await app.request('/', {
      headers: { 'x-forwarded-for': '1.1.1.1' },
    })
    const res2 = await app.request('/', {
      headers: { 'x-forwarded-for': '2.2.2.2' },
    })

    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
  })
})
