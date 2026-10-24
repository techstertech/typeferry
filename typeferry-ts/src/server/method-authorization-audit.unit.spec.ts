import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { PublicError } from '../utils'
import { ClientNode } from './client-node'
import { Method } from './method'
import { Server } from './server'

const RESOURCE_ID = 'audit-resource'
const resourceSchema = z.object({ resourceId: z.string() })

describe('method cache authorization', () => {
  let server: Server

  beforeEach(async () => {
    server = new Server({ host: '127.0.0.1', port: 0, globalInstance: false })

    await server.isReady()
  })

  afterEach(async () => {
    vi.restoreAllMocks()

    await server.close()
  })

  function authenticatedNode(): ClientNode {
    const node = new ClientNode(server)

    node.authenticated = true
    node.setContext({ user: { _id: crypto.randomUUID() } })

    return node
  }

  it.each([false, true])(
    'isolates authenticated results with protected=%s',
    async isProtected => {
      const owner = authenticatedNode()
      const stranger = authenticatedNode()
      const method = new Method(
        server,
        'audit.privateResult',
        function () {
          return { ownerId: this.userId }
        },
        { schema: resourceSchema, protected: isProtected, cache: true },
      )
      const parameters = { resourceId: RESOURCE_ID }

      expect(await method.exec(parameters, owner)).toEqual({ ownerId: owner.userId })
      expect(await method.exec(parameters, stranger)).toEqual({
        ownerId: stranger.userId,
      })
    },
  )

  it('rechecks handler authorization after resource access is revoked', async () => {
    const owner = authenticatedNode()
    let accessAllowed = true
    const method = new Method(
      server,
      'audit.inlinePermission',
      function () {
        if (!accessAllowed) throw new PublicError('Access denied')

        return RESOURCE_ID
      },
      { schema: resourceSchema, protected: true, cache: true },
    )
    const parameters = { resourceId: RESOURCE_ID }

    expect(await method.exec(parameters, owner)).toBe(RESOURCE_ID)

    accessAllowed = false

    await expect(method.exec(parameters, owner)).rejects.toThrow('Access denied')
  })

  it('isolates user-specific results when handler caching is disabled', async () => {
    const owner = authenticatedNode()
    const stranger = authenticatedNode()
    const method = new Method(
      server,
      'audit.uncachedResult',
      function () {
        return { ownerId: this.userId }
      },
      { schema: resourceSchema, protected: true },
    )
    const parameters = { resourceId: RESOURCE_ID }

    expect(await method.exec(parameters, owner)).toEqual({ ownerId: owner.userId })
    expect(await method.exec(parameters, stranger)).toEqual({
      ownerId: stranger.userId,
    })
  })

  it('rechecks authorization middleware before returning an anonymous cached result', async () => {
    const owner = new ClientNode(server)
    let accessAllowed = true
    const method = new Method(
      server,
      'audit.middlewarePermission',
      function () {
        return RESOURCE_ID
      },
      {
        schema: resourceSchema,
        cache: true,
        middleware: [
          () => {
            if (!accessAllowed) throw new PublicError('Access denied')
          },
        ],
      },
    )
    const parameters = { resourceId: RESOURCE_ID }

    expect(await method.exec(parameters, owner)).toBe(RESOURCE_ID)

    accessAllowed = false

    await expect(method.exec(parameters, owner)).rejects.toThrow('Access denied')
  })

  it('never reads or populates anonymous cache across authentication transitions', async () => {
    const node = new ClientNode(server)
    let calls = 0
    const method = new Method(server, 'audit.transitions', () => ++calls, {
      cache: true,
    })
    const parameters = { resourceId: RESOURCE_ID }

    expect(await method.exec(parameters, node)).toBe(1)
    expect(await method.exec(parameters, node)).toBe(1)

    node.authenticated = true
    node.setContext({ user: { _id: crypto.randomUUID() } })

    expect(await method.exec(parameters, node)).toBe(2)
    expect(await method.exec(parameters, node)).toBe(3)

    node.authenticated = false
    node.setContext({})

    expect(await method.exec(parameters, node)).toBe(1)

    const privateFirstParameters = { resourceId: crypto.randomUUID() }

    node.authenticated = true
    node.setContext({ user: { _id: crypto.randomUUID() } })

    expect(await method.exec(privateFirstParameters, node)).toBe(4)

    node.authenticated = false
    node.setContext({})

    expect(await method.exec(privateFirstParameters, node)).toBe(5)
    expect(await method.exec(privateFirstParameters, node)).toBe(5)
  })

  it('preserves anonymous cache sharing and expiry', async () => {
    const first = new ClientNode(server)
    const second = new ClientNode(server)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    let calls = 0
    const method = new Method(server, 'audit.anonymous', () => ++calls, {
      cache: true,
      maxAge: 100,
    })

    expect(await method.exec({}, first)).toBe(1)
    expect(await method.exec({}, second)).toBe(1)

    now.mockReturnValue(1_100)

    expect(await method.exec({}, second)).toBe(2)
  })
})
