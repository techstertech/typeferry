import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { PublicError } from '../utils'
import { ClientNode } from './client-node'
import { Method } from './method'
import { Server } from './server'

const RESOURCE_ID = 'audit-resource'
const resourceSchema = z.object({ resourceId: z.string() })

describe('method authorization audit reproductions', () => {
  let server: Server

  beforeEach(async () => {
    server = new Server({ host: '127.0.0.1', port: 0, globalInstance: false })

    await server.isReady()
  })

  afterEach(async () => {
    await server.close()
  })

  function authenticatedNode(): ClientNode {
    const node = new ClientNode(server)

    node.authenticated = true
    node.setContext({ user: { _id: crypto.randomUUID() } })

    return node
  }

  /**
   * These expected failures specify the missing security properties. Keep them
   * explicit until a separately approved cache contract change fixes the issue.
   */
  it.fails('isolates cached private results between authenticated users', async () => {
    const owner = authenticatedNode()
    const stranger = authenticatedNode()
    const method = new Method(
      server,
      'audit.privateResult',
      function () {
        return { ownerId: this.userId }
      },
      { schema: resourceSchema, protected: true, cache: true },
    )
    const parameters = { resourceId: RESOURCE_ID }

    expect(await method.exec(parameters, owner)).toEqual({ ownerId: owner.userId })
    expect(await method.exec(parameters, stranger)).toEqual({
      ownerId: stranger.userId,
    })
  })

  it.fails('rechecks handler authorization after resource access is revoked', async () => {
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

  it('rechecks authorization middleware before returning a cached result', async () => {
    const owner = authenticatedNode()
    let accessAllowed = true
    const method = new Method(
      server,
      'audit.middlewarePermission',
      function () {
        return RESOURCE_ID
      },
      {
        schema: resourceSchema,
        protected: true,
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
})
