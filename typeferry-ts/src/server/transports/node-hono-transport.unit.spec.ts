import { request as createHttpRequest, type IncomingMessage, type RequestListener } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'

import { EJSON } from '../../ejson'
import { parseDeviceInfo } from '../../auth/server/device-info'
import type { TypeFerryResponse } from '../request-types'
import { Server, type RateLimit, type RequestBodySizeLimit } from '../server'
import { PublicError, ServerEvents } from '../../utils'

const LOCAL_HOST = '127.0.0.1'
const LARGE_REQUEST_PADDING_BYTES = 900 * 1024
const SHUTDOWN_BOUND_MS = 1_000

/** Creates a real Node listener and resolves only after its port is assigned. */
async function createServer(
  options: {
    maxRequestBodySize?: number
    requestBodySizeLimits?: readonly RequestBodySizeLimit[]
    origins?: string[]
    requestListener?: RequestListener
    rateLimit?: RateLimit
  } = {},
): Promise<Server> {
  const server = new Server({
    ...options,
    globalInstance: false,
    host: LOCAL_HOST,
    port: 0,
  })
  await server.isReady()
  return server
}

/** Encodes an RPC request large enough to overflow a dormant stream buffer. */
function largeRpcBody(method: string): string {
  return EJSON.stringify({
    context: {},
    payload: {
      method,
      params: 'x'.repeat(LARGE_REQUEST_PADDING_BYTES),
      uuid: 'large-transport-test',
    },
  })
}

interface RejectedUpgrade {
  readonly response: string
  readonly socket: Socket
}

/** Keeps its write side open after an unsupported raw HTTP upgrade. */
function requestUnsupportedUpgrade(port: number): Promise<RejectedUpgrade> {
  return new Promise<RejectedUpgrade>((resolve, reject) => {
    let response = ''
    let settled = false
    const socket = createConnection({
      allowHalfOpen: true,
      host: LOCAL_HOST,
      port,
    })
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve({ response, socket })
    }

    socket.setEncoding('utf8')
    socket.once('connect', () => {
      socket.write(
        'GET /unsupported-websocket HTTP/1.1\r\n' +
          `Host: ${LOCAL_HOST}:${port}\r\n` +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
      )
    })
    socket.on('data', (chunk: string) => {
      response += chunk
    })
    socket.once('end', finish)
    socket.once('close', finish)
    socket.once('error', error => {
      if (response.length > 0) finish()
      else reject(error)
    })
  })
}

/** Encodes a raw TypeFerry HTTP request for transport-level assertions. */
function rpcBody(method: string, uuid: string = 'transport-test'): string {
  return EJSON.stringify({
    context: {},
    payload: { method, params: null, uuid },
  })
}

describe('NodeHonoTransport', () => {
  it('serves Hono HTTP and WebSocket upgrades on the same listener', async () => {
    const server = await createServer()
    server.app.get('/health', c => c.text('ok'))

    const response = await fetch(`http://${LOCAL_HOST}:${server.port}/health`)
    expect(await response.text()).toBe('ok')
    expect(server.httpTransport.http?.listenerCount('upgrade')).toBe(1)

    const socket = new WebSocket(
      `ws://${LOCAL_HOST}:${server.port}/typeferry-ws?uuid=transport-socket`,
    )
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    expect(server.allClients.has('transport-socket')).toBe(true)

    socket.close()
    await server.close()
  })

  it('rejects unsupported upgrades without delaying listener shutdown', async () => {
    const server = await createServer()
    const rejectedUpgrade = await requestUnsupportedUpgrade(server.port)

    try {
      expect(rejectedUpgrade.response).toContain('HTTP/1.1 404 Not Found')
      const closeResult = await Promise.race([
        server.close().then(() => 'closed'),
        delay(SHUTDOWN_BOUND_MS).then(() => 'timed-out'),
      ])

      expect(closeResult).toBe('closed')
    } finally {
      rejectedUpgrade.socket.destroy()
    }
  })

  it('does not backpressure large RPCs for a header-only observer', async () => {
    let observedMethod: string | undefined
    const server = await createServer({
      maxRequestBodySize: 2 * 1024 * 1024,
      requestListener(request) {
        observedMethod = request.method
      },
    })
    server.addMethod('transport:large-header-observer', () => true)

    const response = await fetch(`http://${LOCAL_HOST}:${server.port}/__h`, {
      body: largeRpcBody('transport:large-header-observer'),
      method: 'POST',
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('true')
    expect(observedMethod).toBe('POST')
    await server.close()
  })

  it('shares large RPC chunks without buffering a paused observer', async () => {
    let observedBytes = 0
    let observerRequest: IncomingMessage | undefined
    const server = await createServer({
      maxRequestBodySize: 2 * 1024 * 1024,
      requestListener(request) {
        observerRequest = request
        request.on('data', (chunk: Buffer) => {
          observedBytes += chunk.length
          request.pause()
        })
      },
    })
    server.addMethod('transport:large-body-observer', () => true)
    const body = largeRpcBody('transport:large-body-observer')

    const response = await fetch(`http://${LOCAL_HOST}:${server.port}/__h`, {
      body,
      method: 'POST',
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('true')
    expect(observedBytes).toBe(Buffer.byteLength(body))
    expect(observerRequest?.readableLength).toBe(0)
    await server.close()
  })

  it('gates HTTP and WebSocket traffic when connections are disabled', async () => {
    const server = await createServer()
    server.acceptConnections = false

    const response = await fetch(`http://${LOCAL_HOST}:${server.port}/__h`, {
      body: rpcBody('unknown'),
      method: 'POST',
    })
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('1')

    const socket = new WebSocket(
      `ws://${LOCAL_HOST}:${server.port}/typeferry-ws?uuid=rejected-socket`,
    )
    await new Promise<void>(resolve => {
      socket.once('error', () => resolve())
      socket.once('close', () => resolve())
    })
    expect(server.allClients.has('rejected-socket')).toBe(false)

    await server.close()
  })

  it('preserves CORS allow-list behavior', async () => {
    const allowedOrigin = 'https://allowed.example'
    const server = await createServer({ origins: [allowedOrigin] })
    server.app.get('/cors', c => c.text('ok'))

    const allowed = await fetch(`http://${LOCAL_HOST}:${server.port}/cors`, {
      headers: { origin: allowedOrigin },
    })
    expect(allowed.headers.get('access-control-allow-origin')).toBe(
      allowedOrigin,
    )
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true')

    const denied = await fetch(`http://${LOCAL_HOST}:${server.port}/cors`, {
      headers: { origin: 'https://denied.example' },
    })
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()

    await server.close()
  })

  it('uses the connection peer for metadata and quotas while preserving cookies', async () => {
    const server = await createServer({
      rateLimit: { max: 1, interval: 60_000 },
    })

    try {
      server.addMethod('transport:metadata', function () {
        const response = this.res as TypeFerryResponse
        response.setHeader('Set-Cookie', 'first=one; Path=/')
        response.setHeader('Set-Cookie', 'second=two; Path=/')

        if (!this.req)
          throw new Error('HTTP methods must have request metadata')

        return {
          remoteAddress: this.remoteAddress,
          requestIp: this.req.ip,
          deviceIp: parseDeviceInfo(this.req).ip,
        }
      })

      const response = await fetch(`http://${LOCAL_HOST}:${server.port}/__h`, {
        body: rpcBody('transport:metadata'),
        headers: { 'x-forwarded-for': '203.0.113.9' },
        method: 'POST',
      })
      const payload = EJSON.parse(await response.text()) as {
        result: { remoteAddress: string; requestIp: string; deviceIp: string }
      }
      expect(payload.result.remoteAddress).toBe(LOCAL_HOST)
      expect(payload.result.requestIp).toBe(LOCAL_HOST)
      expect(payload.result.deviceIp).toBe(LOCAL_HOST)
      expect(response.headers.getSetCookie()).toEqual([
        'first=one; Path=/',
        'second=two; Path=/',
      ])

      const repeated = await fetch(`http://${LOCAL_HOST}:${server.port}/__h`, {
        body: rpcBody('transport:metadata'),
        headers: { 'x-forwarded-for': '203.0.113.10' },
        method: 'POST',
      })

      expect(repeated.status).toBe(429)
    } finally {
      await server.close()
    }
  })

  it('tracks the direct peer address when no forwarding header is present', async () => {
    const server = await createServer()
    server.addMethod('transport:direct-address', function () {
      return this.remoteAddress
    })

    const response = await fetch(`http://${LOCAL_HOST}:${server.port}/__h`, {
      body: rpcBody('transport:direct-address'),
      method: 'POST',
    })
    const payload = EJSON.parse(await response.text()) as {
      result: string
    }
    expect(payload.result).toMatch(/127\.0\.0\.1|::ffff:127\.0\.0\.1/)

    await server.close()
  })

  it('preserves cookies set by route authentication middleware', async () => {
    const server = await createServer()
    server.setAuth({
      auth: function () {
        const response = this.res as TypeFerryResponse
        response.setHeader('Set-Cookie', 'authenticated=true; Path=/')
        return { user: { _id: 'middleware-user' } }
      },
      logIn: async function () {
        return true
      },
    })
    server.app.get('/authenticated', server.httpTransport.authMiddleware, c =>
      c.text('ok'),
    )

    const response = await fetch(
      `http://${LOCAL_HOST}:${server.port}/authenticated`,
    )
    expect(response.status).toBe(200)
    expect(response.headers.getSetCookie()).toEqual([
      'authenticated=true; Path=/',
    ])

    await server.close()
  })

  it('preserves response cookies when an RPC returns a public error', async () => {
    const server = await createServer()
    server.addMethod('transport:public-error', function () {
      const response = this.res as TypeFerryResponse
      response.setHeader('Set-Cookie', 'retry=allowed; Path=/')
      throw new PublicError('Try Again')
    })

    const response = await fetch(`http://${LOCAL_HOST}:${server.port}/__h`, {
      body: rpcBody('transport:public-error'),
      method: 'POST',
    })
    expect(response.headers.getSetCookie()).toEqual(['retry=allowed; Path=/'])
    expect(await response.text()).toContain('Try Again')

    await server.close()
  })

  it('enforces the configured request-body limit', async () => {
    const server = await createServer({ maxRequestBodySize: 32 })

    const response = await fetch(`http://${LOCAL_HOST}:${server.port}/__h`, {
      body: rpcBody('unknown').repeat(4),
      method: 'POST',
    })
    expect(response.status).toBe(413)

    await server.close()
  })

  it('bounds chunked bodies before buffering the larger global allowance', async () => {
    const server = await createServer({
      maxRequestBodySize: 1024 * 1024,
      requestBodySizeLimits: [
        { pathPrefix: '/upload', maxSize: 64 },
        { pathPrefix: '/upload/private', maxSize: 32 },
      ],
    })
    const handler = vi.fn(async (body: string) => body.length)
    server.app.post('*', async c => c.json(await handler(await c.req.text())))

    try {
      for (const pathname of ['/upload', '/upload/image', '/upload/private', '/%75pload/image']) {
        const requestOptions: RequestInit & { duplex: 'half' } = {
          method: 'POST',
          body: new ReadableStream({ start(controller) {
            controller.enqueue(new Uint8Array(65))
            controller.close()
          } }),
          // Node requires duplex for a genuinely chunked request without Content-Length.
          duplex: 'half',
        }
        const response = await fetch(`http://${LOCAL_HOST}:${server.port}${pathname}`, requestOptions)
        expect(response.status).toBe(413)
      }
      expect(handler).not.toHaveBeenCalled()
      for (const [pathname, bytes] of [['/upload/private', 33], ['/upload', 65]] as const) {
        const response = await fetch(`http://${LOCAL_HOST}:${server.port}${pathname}`, {
          method: 'POST', body: 'x'.repeat(bytes),
        })
        expect(response.status).toBe(413)
      }
      const allowed = await fetch(`http://${LOCAL_HOST}:${server.port}/uploader`, {
        method: 'POST', body: 'x'.repeat(65),
      })
      expect(allowed.status).toBe(200)
      expect(await allowed.json()).toBe(65)
      const bounded = await fetch(`http://${LOCAL_HOST}:${server.port}/upload/private`, {
        method: 'POST', body: 'x'.repeat(32),
      })
      expect(bounded.status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('rejects an oversized chunked stream before the client finishes uploading', async () => {
    const server = await createServer({
      maxRequestBodySize: 1024 * 1024,
      requestBodySizeLimits: [{ pathPrefix: '/upload', maxSize: 32 }],
    })
    server.app.post('/upload', c => c.text('accepted'))
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = createHttpRequest({
          hostname: LOCAL_HOST, port: server.port, path: '/upload', method: 'POST',
        }, incoming => {
          incoming.resume()
          resolve(incoming.statusCode ?? 0)
          outgoing.destroy()
        })
        outgoing.once('error', reject)
        outgoing.setTimeout(2000, () => {
          outgoing.destroy(new Error('Body limit waited for the oversized stream to end'))
        })
        outgoing.write('x'.repeat(33))
        // Deliberately leave the chunked request open. The route cap must reject
        // now, rather than buffering under the larger global cap until end.
      })
      expect(status).toBe(413)
    } finally {
      await server.close()
    }
  })

  it('never lets a route override raise the global request-body ceiling', async () => {
    const server = await createServer({
      maxRequestBodySize: 32,
      requestBodySizeLimits: [{ pathPrefix: '/upload', maxSize: 1024 }],
    })
    server.app.post('/upload', c => c.text('accepted'))
    try {
      const response = await fetch(`http://${LOCAL_HOST}:${server.port}/upload`, {
        method: 'POST', body: 'x'.repeat(33),
      })
      expect(response.status).toBe(413)
    } finally {
      await server.close()
    }
  })

  it('closes idempotently and emits one closed lifecycle event', async () => {
    const server = await createServer()
    let closeEvents = 0
    server.on(ServerEvents.CLOSED, () => {
      closeEvents += 1
    })

    await Promise.all([server.close(), server.close()])

    expect(closeEvents).toBe(1)
  })

  it('disposes rate-limit cleanup when the listener closes', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    try {
      const server = new Server({
        globalInstance: false,
        host: LOCAL_HOST,
        port: 0,
        rateLimit: true,
      })
      await server.isReady()

      await server.close()

      expect(clearIntervalSpy).toHaveBeenCalled()
    } finally {
      clearIntervalSpy.mockRestore()
    }
  })
})
