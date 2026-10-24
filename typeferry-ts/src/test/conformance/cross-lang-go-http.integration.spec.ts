import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Client } from '../../client'
import { ClientHttp } from '../../client/client-http'
import { type GoConformanceServer, startGoConformanceServer } from './go-server'
import { goMethodContract } from './go-contract'

describe('TypeScript HTTP client ↔ Go server', () => {
  let fixture: GoConformanceServer
  let port: number

  beforeAll(async () => {
    fixture = await startGoConformanceServer()
    port = fixture.port
  }, 35_000)

  afterAll(async () => { await fixture?.close() })

  function clientHttp(token?: string): ClientHttp {
    const client = {
      options: { host: '127.0.0.1', port, secure: false },
      context: token ? { token } : {},
      uuid: 'go-http-client',
      logger: { method: () => undefined },
      emit: () => undefined,
    } as unknown as Client

    return new ClientHttp(client)
  }

  async function call(http: ClientHttp, method: string, params?: unknown): Promise<unknown> {
    return await new Promise((resolve, reject) => {
      void http.request({ method, params }, resolve, reject)
    })
  }

  goMethodContract(async token => {
    const http = clientHttp(token)
    return { call: (method, params) => call(http, method, params), close: async () => undefined }
  })

  it('calls methods through the real TypeScript HTTP client', async () => {
    expect(await call(clientHttp(), 'add', { a: 2, b: 3 })).toBe(5)
    expect(await call(clientHttp(), 'echo', { nested: { value: 7 } })).toEqual({ nested: { value: 7 } })
  })

  it('enforces protected methods and accepts the configured token', async () => {
    await expect(call(clientHttp(), 'whoami')).rejects.toMatchObject({ message: 'Method Forbidden' })
    expect(await call(clientHttp('good-token'), 'whoami')).toBe('u1')
  })
})
