import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'

import { Server, type ServerOptions } from '../server'
import { Errors, Presentation, PublicError, ServerEvents } from '../../utils'

const HOST = '127.0.0.1'
const ALLOWED_ORIGIN = 'https://allowed.example'
const DENIED_ORIGIN = 'https://denied.example'
const RPC_METHOD = 'boundary:echo'

async function startServer(options: ServerOptions = {}): Promise<Server> {
  const server = new Server({
    ...options,
    globalInstance: false,
    host: HOST,
    port: 0,
  })

  await server.isReady()
  return server
}

function rpcRequest(
  server: Server,
  origin?: string,
  method = RPC_METHOD,
  isVoid = false,
): Promise<Response> {
  const headers = new Headers({ 'content-type': 'text/plain' })
  if (origin !== undefined) headers.set('origin', origin)

  return fetch(`http://${HOST}:${server.port}/__h`, {
    method: 'POST',
    headers,
    body: Presentation.encode({
      context: {},
      payload: { method, void: isVoid },
    }),
  })
}

function nextFrame(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('message', receive)
      socket.off('error', fail)
    }
    const receive = (raw: WebSocket.RawData): void => {
      cleanup()
      resolve(Presentation.decode<unknown>(raw.toString()))
    }
    const fail = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const timer = setTimeout(
      () => fail(new Error('Expected protocol frame')),
      1000,
    )

    socket.once('message', receive)
    socket.once('error', fail)
  })
}

interface OriginCase {
  name: string
  origins: string[] | undefined
  origin: string | undefined
  allowOriginless: boolean
  allowed: boolean
}

const ORIGIN_CASES: OriginCase[] = [
  {
    name: 'omitted allowlist',
    origins: undefined,
    origin: DENIED_ORIGIN,
    allowOriginless: false,
    allowed: true,
  },
  {
    name: 'empty allowlist',
    origins: [],
    origin: ALLOWED_ORIGIN,
    allowOriginless: false,
    allowed: false,
  },
  {
    name: 'matching origin',
    origins: [ALLOWED_ORIGIN],
    origin: ALLOWED_ORIGIN,
    allowOriginless: false,
    allowed: true,
  },
  {
    name: 'mismatching origin',
    origins: [ALLOWED_ORIGIN],
    origin: DENIED_ORIGIN,
    allowOriginless: false,
    allowed: false,
  },
  {
    name: 'missing origin',
    origins: [ALLOWED_ORIGIN],
    origin: undefined,
    allowOriginless: false,
    allowed: false,
  },
  {
    name: 'present empty origin with originless opt-in',
    origins: [ALLOWED_ORIGIN],
    origin: '',
    allowOriginless: true,
    allowed: false,
  },
  {
    name: 'originless opt-in',
    origins: [ALLOWED_ORIGIN],
    origin: undefined,
    allowOriginless: true,
    allowed: true,
  },
  {
    name: 'opt-in with mismatching origin',
    origins: [ALLOWED_ORIGIN],
    origin: DENIED_ORIGIN,
    allowOriginless: true,
    allowed: false,
  },
  {
    name: 'empty allowlist with originless opt-in',
    origins: [],
    origin: undefined,
    allowOriginless: true,
    allowed: true,
  },
]

describe('protocol origin admission', () => {
  it.each(ORIGIN_CASES)(
    'HTTP: $name',
    async ({ origins, origin, allowOriginless, allowed }) => {
      const server = await startServer({
        ...(origins === undefined ? {} : { origins }),
        allowOriginless,
        ws: { allowOriginless: true },
      })
      const auth = vi.fn(async () => ({ user: { _id: 'boundary-user' } }))
      const handler = vi.fn(async () => true)

      server.setAuth({ auth, logIn: async () => true })
      server.addMethod(RPC_METHOD, handler)

      try {
        const response = await rpcRequest(server, origin)

        expect(response.status).toBe(allowed ? 200 : 403)
        expect(auth).toHaveBeenCalledTimes(allowed ? 1 : 0)
        expect(handler).toHaveBeenCalledTimes(allowed ? 1 : 0)
      } finally {
        await server.close()
      }
    },
  )

  it.each(ORIGIN_CASES)(
    'WebSocket: $name',
    async ({ origins, origin, allowOriginless, allowed }) => {
      const handshakeAuthenticator = vi.fn(async () => ({
        user: { _id: 'boundary-user' },
      }))
      const server = await startServer({
        ...(origins === undefined ? {} : { origins }),
        allowOriginless: true,
        ws: { allowOriginless, handshakeAuthenticator },
      })
      const socket = new WebSocket(
        `ws://${HOST}:${server.port}/typeferry-ws`,
        origin === undefined ? {} : { headers: { Origin: origin } },
      )

      try {
        const status = await new Promise<number>((resolve, reject) => {
          let rejected = false

          socket.once('open', () => resolve(101))
          socket.once('unexpected-response', (_request, response) => {
            rejected = true
            response.resume()
            resolve(response.statusCode ?? 0)
            socket.terminate()
          })
          socket.on('error', (error) => {
            if (!rejected) reject(error)
          })
        })

        expect(status).toBe(allowed ? 101 : 403)
        expect(handshakeAuthenticator).toHaveBeenCalledTimes(allowed ? 1 : 0)
      } finally {
        socket.close()
        await server.close()
      }
    },
  )

  it('keeps HTTP and WebSocket originless opt-ins independent', async () => {
    const server = await startServer({
      origins: [ALLOWED_ORIGIN],
      ws: { allowOriginless: true },
    })

    try {
      expect((await rpcRequest(server)).status).toBe(403)
    } finally {
      await server.close()
    }
  })

  it('rejects origins before consuming quota or decoding a body', async () => {
    const server = await startServer({
      origins: [ALLOWED_ORIGIN],
      rateLimit: { max: 1, interval: 60_000 },
    })

    server.addMethod(RPC_METHOD, async () => true)

    try {
      const rejected = await fetch(`http://${HOST}:${server.port}/__h`, {
        method: 'POST',
        headers: { origin: DENIED_ORIGIN },
        body: '{',
      })

      expect(rejected.status).toBe(403)
      expect(rejected.headers.has('ratelimit-limit')).toBe(false)
      expect((await rpcRequest(server, ALLOWED_ORIGIN)).status).toBe(200)
      expect((await rpcRequest(server, ALLOWED_ORIGIN)).status).toBe(429)
    } finally {
      await server.close()
    }
  })
})

describe('protocol rate-limit headers', () => {
  it('charges oversized RPC requests before body admission', async () => {
    const server = await startServer({
      maxRequestBodySize: 256,
      rateLimit: { max: 2, interval: 60_000 },
    })

    server.addMethod(RPC_METHOD, async () => true)

    try {
      const oversized = await fetch(`http://${HOST}:${server.port}/__h`, {
        method: 'POST',
        body: 'x'.repeat(257),
      })

      expect(oversized.status).toBe(413)
      expect(oversized.headers.get('ratelimit-remaining')).toBe('1')
      expect(
        (await rpcRequest(server)).headers.get('ratelimit-remaining'),
      ).toBe('0')
      expect((await rpcRequest(server)).status).toBe(429)
    } finally {
      await server.close()
    }
  })

  it.each([
    { method: RPC_METHOD, isVoid: false },
    { method: RPC_METHOD, isVoid: true },
    { method: 'missing', isVoid: false },
    { method: 'missing', isVoid: true },
    { method: 'fail', isVoid: false },
    { method: 'fail', isVoid: true },
    { method: 'protected', isVoid: false },
    { method: 'protected', isVoid: true },
  ])(
    'attaches quota to $method with void=$isVoid',
    async ({ method, isVoid }) => {
      const server = await startServer({
        rateLimit: { max: 2, interval: 60_000 },
      })

      server.addMethod(RPC_METHOD, async () => true)
      server.addMethod('fail', async () => {
        throw new PublicError('expected failure')
      })
      server.addMethod('protected', async () => true, { protected: true })

      try {
        const response = await rpcRequest(server, undefined, method, isVoid)

        expect(response.status).toBe(200)
        expect(response.headers.get('ratelimit-limit')).toBe('2')
        expect(response.headers.get('ratelimit-remaining')).toBe('1')
        expect(response.headers.get('ratelimit-reset')).toBe('60')
        if (isVoid && method !== RPC_METHOD)
          expect(await response.text()).toBe('')
      } finally {
        await server.close()
      }
    },
  )

  it('preserves response cookies and reports exhausted quota', async () => {
    const server = await startServer({
      rateLimit: { max: 1, interval: 60_000 },
    })

    server.addMethod(RPC_METHOD, async function () {
      this.res?.setHeader('Set-Cookie', 'first=one; Path=/')
      this.res?.setHeader('Set-Cookie', 'second=two; Path=/')
      return true
    })

    try {
      const admitted = await rpcRequest(server)
      const rejected = await rpcRequest(server)

      expect(admitted.headers.getSetCookie()).toHaveLength(2)
      expect(admitted.headers.get('ratelimit-remaining')).toBe('0')
      expect(rejected.status).toBe(429)
      expect(rejected.headers.get('ratelimit-limit')).toBe('1')
      expect(rejected.headers.get('ratelimit-remaining')).toBe('0')
      expect(rejected.headers.get('ratelimit-reset')).toBe('60')
    } finally {
      await server.close()
    }
  })

  it('omits quota headers when limiting is disabled', async () => {
    const server = await startServer()

    try {
      const response = await rpcRequest(server)

      expect(
        [...response.headers.keys()].filter((key) =>
          key.startsWith('ratelimit-'),
        ),
      ).toEqual([])
    } finally {
      await server.close()
    }
  })
})

it.each([
  {
    name: 'context installation',
    context: {
      get user(): never {
        throw new Error('expected context failure')
      },
    },
    listenerThrows: false,
  },
  {
    name: 'authentication listener',
    context: { user: { _id: 'boundary-user' } },
    listenerThrows: true,
  },
])('fails closed when $name throws', async ({ context, listenerThrows }) => {
  const handler = vi.fn(async () => 'protected result')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const server = await startServer({
    ws: { handshakeAuthenticator: async () => context },
  })

  if (listenerThrows) {
    server.on(ServerEvents.AUTHENTICATION, () => {
      throw new Error('expected listener failure')
    })
  }
  server.addMethod('protected', handler, { protected: true })
  const socket = new WebSocket(`ws://${HOST}:${server.port}/typeferry-ws`)

  try {
    expect(await nextFrame(socket)).toEqual({ t: 'auth', authenticated: false })

    const response = nextFrame(socket)

    socket.send(
      Presentation.encode({ t: 'rpc', id: 'denied', method: 'protected' }),
    )
    expect(await response).toEqual({
      t: 'rpc:res',
      id: 'denied',
      error: Errors.METHOD_FORBIDDEN,
    })
    expect(handler).not.toHaveBeenCalled()
    expect(server.getClientsByUserId('boundary-user').size).toBe(0)
    expect(log).toHaveBeenCalled()
  } finally {
    socket.close()
    await server.close()
    log.mockRestore()
  }
})

it.each([{}, { user: {} }])(
  'accepts a truthy identity without a user ID: %j',
  async (context) => {
    const server = await startServer()

    server.setAuth({ auth: async () => context, logIn: async () => true })
    server.addMethod(
      RPC_METHOD,
      async function () {
        return { authenticated: this.authenticated, userId: this.userId }
      },
      { protected: true },
    )

    const socket = new WebSocket(
      `ws://${HOST}:${server.port}/typeferry-ws?token=identity`,
    )

    try {
      expect(await nextFrame(socket)).toEqual({
        t: 'auth',
        authenticated: true,
      })

      const response = nextFrame(socket)

      socket.send(
        Presentation.encode({ t: 'rpc', id: 'truthy', method: RPC_METHOD }),
      )
      expect(await response).toEqual({
        t: 'rpc:res',
        id: 'truthy',
        result: { authenticated: true, userId: null },
      })

      const http = await rpcRequest(server)
      const envelope: unknown = await http.json()

      expect(envelope).toMatchObject({
        type: 'result',
        result: { authenticated: true, userId: null },
      })
    } finally {
      socket.close()
      await server.close()
    }
  },
)

it('retires user delivery membership when rpc:logout deauthenticates a client', async () => {
  const server = await startServer()

  server.setAuth({
    auth: async () => ({ user: { _id: 'boundary-user' } }),
    logIn: async () => true,
  })
  const socket = new WebSocket(
    `ws://${HOST}:${server.port}/typeferry-ws?token=identity`,
  )

  try {
    expect(await nextFrame(socket)).toEqual({ t: 'auth', authenticated: true })
    expect(server.getClientsByUserId('boundary-user').size).toBe(1)

    const response = nextFrame(socket)

    socket.send(
      Presentation.encode({ t: 'rpc', id: 'logout', method: 'rpc:logout' }),
    )
    expect(await response).toEqual({ t: 'rpc:res', id: 'logout', result: true })
    expect(server.getClientsByUserId('boundary-user').size).toBe(0)
  } finally {
    socket.close()
    await server.close()
  }
})
