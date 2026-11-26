import { describe, expect, it, vi } from 'vitest'

import { getRoomName, type ClientNode } from '../../server'
import { ClientEvents, NO_CHANNEL, ServerEvents, sleep } from '../../utils'
import { TestUtility } from '../test-utility'

/** Retrieves a ClientNode by uuid, failing the test if not found. */
function getNode(test: TestUtility, uuid: string): ClientNode {
  const node = test.server.allClients.get(uuid)
  expect(node).toBeDefined()
  return node as ClientNode
}

/**
 * Tests for transport hardening fixes introduced during the Socket.IO →
 * native WebSocket migration review. Covers:
 *
 * - Auth zombie guard (node disconnects during async auth)
 * - ClientNode.close() idempotency (no duplicate events)
 * - clearAllPending vs rejectAllPending (graceful vs unexpected close)
 * - Room cleanup on disconnect
 */
describe('Auth Zombie Guard', () => {
  const test = new TestUtility()

  it('should not authenticate a node that disconnects during auth', async () => {
    const authSpy = vi.fn()

    const server = await test.createRandomSrv({ globalInstance: false })

    server.setAuth({
      async auth(context) {
        // Simulate slow auth (e.g. database lookup)
        await sleep(200)
        authSpy()
        return context?.token === 'test'
          ? { ...context, user: { _id: 'user-1' } }
          : false
      },
      async logIn() {
        return { token: 'test' }
      },
    })

    // Connect with token — auth starts but takes 200ms
    const client = new (await import('../../client')).Client({
      host: test.host,
      port: server.port,
      initialContext: { token: 'test' },
    })

    // Wait for connection to establish (but auth is still in progress)
    await client.waitFor(ClientEvents.WEBSOCKET_CONNECTED, 5000)

    // Disconnect before auth completes
    await client.close()

    // Wait for the auth promise to settle
    await sleep(300)

    // Auth function ran, but the node should NOT be authenticated
    // because the socket was closed before auth completed
    expect(authSpy).toHaveBeenCalled()

    // Server should have no authenticated clients
    const authenticatedNodes = [...server.allClients.values()].filter(
      n => n.authenticated,
    )
    expect(authenticatedNodes).toHaveLength(0)

    await server.close()
  })
})

describe('ClientNode.close() Idempotency', () => {
  const test = new TestUtility()

  it('should only emit DISCONNECTION once when close is called twice', async () => {
    const disconnectSpy = vi.fn()
    test.server.on(ServerEvents.DISCONNECTION, disconnectSpy)

    const client = await test.createClient()
    const node = getNode(test, client.uuid)

    node.close()
    node.close()

    expect(disconnectSpy).toHaveBeenCalledTimes(1)
  })

  it('should only emit DISCONNECT once on the node itself', async () => {
    const disconnectSpy = vi.fn()

    const client = await test.createClient()
    const node = getNode(test, client.uuid)

    node.on(ServerEvents.DISCONNECT, disconnectSpy)

    node.close()
    node.close()

    expect(disconnectSpy).toHaveBeenCalledTimes(1)
  })
})

describe('Pending Request Lifecycle', () => {
  const test = new TestUtility()

  it('should reject in-flight RPCs on unexpected disconnect', async () => {
    test.server.addMethod('slow:method', async () => {
      await sleep(5000)
      return 'done'
    })

    // Start an RPC call that will take 5s
    const callPromise = test.client.call('slow:method', {}, { timeout: 10000 })

    // Give the RPC time to be sent
    await sleep(50)

    // Force-close the socket (simulates unexpected disconnect)
    test.client.clientSocket.socket?.close()

    // The pending RPC should be rejected with "Connection lost"
    await expect(callPromise).rejects.toThrow('Connection lost')
  })

  it('should not throw unhandled rejections on intentional close', async () => {
    test.server.addMethod('another:slow', async () => {
      await sleep(5000)
      return 'done'
    })

    // Fire-and-forget an RPC (don't await — simulates abandoned call)
    test.client.call('another:slow', {}).catch(() => {
      // Intentionally ignore — this is the test scenario
    })

    await sleep(50)

    // Intentional close should NOT reject pending requests (clearAllPending)
    // If this threw an unhandled rejection, vitest would catch it as an error
    await test.client.close()

    // If we get here without unhandled rejection, the test passes
    await sleep(100)
  })
})

describe('Room Cleanup on Disconnect', () => {
  const test = new TestUtility()

  it('should clean up room subscriptions when a client disconnects', async () => {
    const server = await test.createRandomSrv({ globalInstance: false })

    server.setAuth({
      auth(context) {
        return context?.token === 'test'
          ? { ...context, user: { _id: 'user-1' } }
          : false
      },
      async logIn() {
        return { token: 'test' }
      },
    })

    server.addEvent('room:test-event')

    const client1 = await test.createAuthenticatedClient({ port: server.port })
    const client2 = await test.createAuthenticatedClient({ port: server.port })

    // Both subscribe to the same event
    await client1.subscribe('room:test-event')
    await client2.subscribe('room:test-event')

    const rooms = server.webSocketTransport?.rooms
    expect(rooms).toBeDefined()

    const roomName = getRoomName(NO_CHANNEL, 'room:test-event')
    expect(rooms?.getRoomSize(roomName)).toBe(2)

    // Disconnect client1
    await client1.close()
    await sleep(100)

    // Room should only have client2 now
    expect(rooms?.getRoomSize(roomName)).toBe(1)

    // Disconnect client2
    await client2.close()
    await sleep(100)

    // Room should be empty and cleaned up
    expect(rooms?.getRoomSize(roomName)).toBe(0)

    await server.close()
  })
})

describe('Wire Protocol Event Format', () => {
  const test = new TestUtility()

  it('should deliver events with the wire protocol t field', async () => {
    test.server.addEvent('wire:test')
    await test.client.subscribe('wire:test')

    const received = new Promise<Record<string, unknown>>(resolve => {
      const originalHandler = test.client.clientSocket['handleMessage'].bind(
        test.client.clientSocket,
      )

      test.client.clientSocket['handleMessage'] = (raw: string) => {
        const parsed = JSON.parse(raw)
        if (parsed.t === 'event' && parsed.event === 'wire:test') {
          resolve(parsed)
        }
        originalHandler(raw)
      }
    })

    const node = getNode(test, test.client.uuid)
    node.emitTypeFerryEvent('wire:test', undefined, { data: 42 })

    const msg = await received

    expect(msg.t).toBe('event')
    expect(msg.event).toBe('wire:test')
    expect(msg.params).toEqual({ data: 42 })
    expect(msg.uuid).toBeDefined()
  })
})
