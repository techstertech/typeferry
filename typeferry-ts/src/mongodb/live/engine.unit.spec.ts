import type { Collection, Document } from 'mongodb'
import { afterEach, describe, expect, it } from 'vitest'

import { ClientNode, Server } from '../../server'
import type { TypeFerrySocket } from '../../server'
import {
  MONGO_LIVE_EVENT,
  MONGO_LIVE_RESYNC_METHOD,
  MONGO_LIVE_SUBSCRIBE_METHOD,
  MONGO_LIVE_UNSUBSCRIBE_METHOD,
  type MongoLiveRuntimePublication,
} from './types'
import { MongoLiveEngine } from './engine'
import { ServerEvents } from '../../utils'

const publication: MongoLiveRuntimePublication = {
  name: 'boards.mine',
  collection: { Class: class Boards {} } as never,
  protected: true,
  parseArgs: (value) => value,
  authorize: async () => ({}),
  filter: () => ({}),
  project: async () => ({ name: 'Board' }),
}

describe('MongoLiveEngine registration and ownership', () => {
  const servers: Server[] = []

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()))
    servers.length = 0
  })

  it('rejects HTTP and unauthenticated subscription allocation', async () => {
    const server = createServer()
    servers.push(server)
    const engine = createEngine(server)
    const method = server.methods.get(MONGO_LIVE_SUBSCRIBE_METHOD)
    expect(method).toBeDefined()
    expect(method?.isSensitive).toBe(true)
    expect(server.methods.get(MONGO_LIVE_RESYNC_METHOD)?.isSensitive).toBe(true)
    expect(server.methods.get(MONGO_LIVE_UNSUBSCRIBE_METHOD)?.isSensitive).toBe(
      true
    )

    await expect(
      method?.exec(
        {
          subscriptionId: 'subscription-1',
          publication: 'boards.mine',
          args: {},
        },
        new ClientNode(server)
      )
    ).rejects.toThrow('active WebSocket')

    const node = new ClientNode(server, createSocket())
    await expect(
      method?.exec(
        {
          subscriptionId: 'subscription-1',
          publication: 'boards.mine',
          args: {},
        },
        node
      )
    ).rejects.toThrow('forbidden')

    const unsupportedNode = new ClientNode(server, {
      readyState: 1,
      send: () => undefined,
      close: () => undefined,
    })
    await expect(
      method?.exec(
        {
          subscriptionId: 'subscription-2',
          publication: 'boards.mine',
          args: {},
        },
        unsupportedNode
      )
    ).rejects.toThrow('pressure reporting')

    await engine.close()
  })

  it('preflights reserved collisions and unregisters only owned surface', async () => {
    const server = createServer()
    servers.push(server)
    server.addMethod(MONGO_LIVE_RESYNC_METHOD, () => true)

    expect(() => createEngine(server)).toThrow('already registered')
    server.methods.delete(MONGO_LIVE_RESYNC_METHOD)

    const engine = createEngine(server)
    expect(server.methods.has(MONGO_LIVE_SUBSCRIBE_METHOD)).toBe(true)
    expect(server.methods.has(MONGO_LIVE_UNSUBSCRIBE_METHOD)).toBe(true)
    expect(server.events.has(MONGO_LIVE_EVENT)).toBe(true)

    await engine.close()
    expect(server.methods.has(MONGO_LIVE_SUBSCRIBE_METHOD)).toBe(false)
    expect(server.methods.has(MONGO_LIVE_UNSUBSCRIBE_METHOD)).toBe(false)
    expect(server.events.has(MONGO_LIVE_EVENT)).toBe(false)
  })

  it('cancels authorization that outlives its connection', async () => {
    const server = createServer()
    servers.push(server)
    let releaseAuthorization: (() => void) | undefined
    const gatedPublication: MongoLiveRuntimePublication = {
      ...publication,
      authorize: async () => {
        await new Promise<void>(resolve => {
          releaseAuthorization = resolve
        })
        return {}
      },
    }
    const engine = createEngine(server, gatedPublication)
    const node = new ClientNode(server, createSocket())
    node.authenticated = true
    const method = server.methods.get(MONGO_LIVE_SUBSCRIBE_METHOD)

    const subscribing = method?.exec(
      {
        subscriptionId: 'subscription-1',
        publication: 'boards.mine',
        args: { secret: 'never-log-me' },
      },
      node,
    )
    for (let attempt = 0; !releaseAuthorization && attempt < 20; attempt++) {
      await Promise.resolve()
    }
    expect(releaseAuthorization).toBeDefined()
    server.emit(ServerEvents.DISCONNECTION, node)
    releaseAuthorization?.()

    await expect(subscribing).rejects.toThrow('cancelled')
    await engine.close()
  })

  it('rejects unsafe capacity configuration before registration', () => {
    const server = createServer()
    servers.push(server)

    expect(
      () =>
        new MongoLiveEngine({
          server,
          options: {
            publications: [publication],
            maxWindowSkip: Number.NaN,
          },
          resolveCollection: () => ({}) as Collection<Document>,
          collectionName: () => 'boards',
        }),
    ).toThrow('"maxWindowSkip" must be a non-negative integer')
    expect(server.methods.has(MONGO_LIVE_SUBSCRIBE_METHOD)).toBe(false)
  })

  it('rejects unauthenticated resync on a protected publication even if snapshot was cached', async () => {
    const server = createServer()
    servers.push(server)
    const engine = createEngine(server, {
      ...publication,
      protected: true,
    })
    const node = new ClientNode(server, createSocket())
    node.authenticated = true
    const subscriptions = (engine as unknown as {
      subscriptions: Map<ClientNode, Map<string, unknown>>
    }).subscriptions
    subscriptions.set(
      node,
      new Map([
        [
          'sub-1',
          {
            id: 'sub-1',
            node,
            publication: { ...publication, protected: true },
            args: {},
            authorization: new AbortController(),
            supportsOrderedWindows: false,
            supportsTypedObjectIds: false,
            observer: { stop: async () => undefined },
            generation: 'gen-1',
            stale: true,
            pressureTimer: null,
          },
        ],
      ]),
    )
    const resyncSnapshots = (engine as unknown as {
      resyncSnapshots: WeakMap<ClientNode, Map<string, unknown>>
    }).resyncSnapshots
    resyncSnapshots.set(node, new Map([['sub-1:gen-1', { documents: [] }]]))

    node.authenticated = false
    const method = server.methods.get('mongo:live:resync')

    await expect(
      method?.exec(
        { subscriptionId: 'sub-1', staleGeneration: 'gen-1' },
        node,
      ),
    ).rejects.toThrow('forbidden')
    await engine.close()
  })

  it('rejects legacy clients before delivering ordered operations', async () => {
    const server = createServer()
    servers.push(server)
    const orderedPublication: MongoLiveRuntimePublication = {
      ...publication,
      protected: false,
      window: () => ({ sort: { score: 1 }, limit: 3 }),
    }
    const engine = createEngine(server, orderedPublication)
    const node = new ClientNode(server, createSocket())
    const method = server.methods.get(MONGO_LIVE_SUBSCRIBE_METHOD)

    await expect(
      method?.exec(
        {
          subscriptionId: 'legacy-client',
          publication: 'boards.mine',
          args: {},
        },
        node,
      ),
    ).rejects.toThrow('capability negotiation')
    await expect(
      method?.exec(
        {
          subscriptionId: 'partially-capable-client',
          publication: 'boards.mine',
          args: {},
          capabilities: ['ordered-window-splice-v1'],
        },
        node,
      ),
    ).rejects.toThrow('typed ObjectId capability')
    await engine.close()
  })
})

function createServer(): Server {
  return new Server({ host: '127.0.0.1', port: 0, globalInstance: false })
}

function createEngine(
  server: Server,
  registeredPublication = publication,
): MongoLiveEngine {
  return new MongoLiveEngine({
    server,
    options: { publications: [registeredPublication] },
    resolveCollection: () => ({} as Collection<Document>),
    collectionName: () => 'boards',
  })
}

function createSocket(): TypeFerrySocket {
  return {
    readyState: 1,
    bufferedAmount: 0,
    send: () => undefined,
    close: () => undefined,
  }
}
