import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Client, ClientChannel } from '../../client'
import { getRoomName } from '../../server'
import type { ClientNode, EventOptions } from '../../server'
import { TestUtility } from '../test-utility'

const EVENT = 'resource:changed'
const CHANNEL = 'resource'

function channel(client: Client): ClientChannel {
  const result = client.channel(CHANNEL)
  if (!result) throw new Error('Expected a resource channel')

  return result
}

describe('Event delivery authorization', () => {
  const test = new TestUtility()

  it('rechecks live access and evicts only the revoked event subscription', async () => {
    const peer = await test.createClient()
    const allowed = new Set([test.client.uuid, peer.uuid])

    test.server.addEvent(EVENT, {
      revalidateOnDelivery: true,
      shouldSubscribe: async (client) => allowed.has(client.uuid),
    })
    test.server.addEvent('unrelated')

    await Promise.all([
      channel(test.client).subscribe([EVENT, 'unrelated']),
      channel(peer).subscribe(EVENT),
    ])

    const received = vi.fn()
    channel(test.client).on(EVENT, received)
    allowed.delete(test.client.uuid)

    const delivery = channel(peer).wait(EVENT)

    test.server.channel(CHANNEL).emit(EVENT, { revision: 1 })

    expect(await delivery).toEqual({ revision: 1 })

    const socket = test.server.allClients.get(test.client.uuid)?.socket
    if (!socket) throw new Error('Expected a live socket')

    await vi.waitFor(() => {
      expect(
        test.server.webSocketTransport?.rooms.has(
          socket,
          getRoomName(CHANNEL, EVENT),
        ),
      ).toBe(false)
    })
    expect(received).not.toHaveBeenCalled()
    expect(
      test.server.webSocketTransport?.rooms.has(
        socket,
        getRoomName(CHANNEL, 'unrelated'),
      ),
    ).toBe(true)

    const unrelated = channel(test.client).wait('unrelated')

    test.server.channel(CHANNEL).emit('unrelated', { retained: true })

    expect(await unrelated).toEqual({ retained: true })
  })

  it.each(['channel-denied', 'channel-error', 'event-error'] as const)(
    'fails closed for %s',
    async (failure) => {
      let revoked = false

      test.server.setChannelAuthorization(async () => {
        if (revoked && failure === 'channel-error')
          throw new Error('sensitive internal context')
        return !(revoked && failure === 'channel-denied')
      })
      test.server.addEvent(EVENT, {
        revalidateOnDelivery: true,
        shouldSubscribe: async () => {
          if (revoked && failure === 'event-error')
            throw new Error('sensitive internal context')
          return true
        },
      })

      await channel(test.client).subscribe(EVENT)

      const received = vi.fn()
      const warning = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined)
      const socket = test.server.allClients.get(test.client.uuid)?.socket
      if (!socket) throw new Error('Expected a live socket')

      try {
        channel(test.client).on(EVENT, received)
        revoked = true
        test.server.channel(CHANNEL).emit(EVENT, { private: true })

        await vi.waitFor(() => {
          expect(
            test.server.webSocketTransport?.rooms.has(
              socket,
              getRoomName(CHANNEL, EVENT),
            ),
          ).toBe(false)
        })
        expect(received).not.toHaveBeenCalled()
        expect(JSON.stringify(warning.mock.calls)).not.toContain(
          'sensitive internal context',
        )
      } finally {
        warning.mockRestore()
      }
    },
  )

  it('checks access again after a reconnect', async () => {
    let allowed = true

    test.server.addEvent(EVENT, {
      revalidateOnDelivery: true,
      shouldSubscribe: async () => allowed,
    })

    await channel(test.client).subscribe(EVENT)
    await test.client.close()

    allowed = false

    await test.client.connect()

    const socket = test.server.allClients.get(test.client.uuid)?.socket
    if (!socket) throw new Error('Expected a reconnected socket')

    expect(
      test.server.webSocketTransport?.rooms.has(
        socket,
        getRoomName(CHANNEL, EVENT),
      ),
    ).toBe(false)
  })

  it('preserves originator exclusion with revalidation', async () => {
    const peer = await test.createClient()
    const check = vi.fn(
      async (_client: ClientNode, _event: string, _channel: string) => true,
    )

    test.server.addEvent(EVENT, {
      revalidateOnDelivery: true,
      excludeOriginator: true,
      shouldSubscribe: check,
    })

    await Promise.all([
      channel(test.client).subscribe(EVENT),
      channel(peer).subscribe(EVENT),
    ])

    check.mockClear()

    const delivery = channel(peer).wait(EVENT)

    test.server.channel(CHANNEL).emit(EVENT, { uuid: test.client.uuid })

    expect(await delivery).toEqual({ uuid: test.client.uuid })
    expect(check).toHaveBeenCalledTimes(1)
    expect(check.mock.calls[0]?.[0].uuid).toBe(peer.uuid)
  })
})

describe('Protected delivery authentication', () => {
  const test = new TestUtility()

  beforeEach(() => {
    test.server.setAuth({
      auth: (context: { token?: string }) =>
        context.token === 'test' ? { user: { _id: 'test-user' } } : false,
      logIn: async () => false,
    })
  })

  it.each(['logout', 'identity-change', 'event-removal'] as const)(
    'denies a protected event when %s happens during authorization',
    async (change) => {
      const client = await test.createAuthenticatedClient()
      let checking = false
      let entered = false
      let release: () => void = () => undefined
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })

      test.server.addEvent(EVENT, {
        protected: true,
        revalidateOnDelivery: true,
        shouldSubscribe: async () => {
          if (checking) {
            entered = true
            await pending
          }
          return true
        },
      })

      await channel(client).subscribe(EVENT)

      const received = vi.fn()
      const node = test.server.allClients.get(client.uuid)
      if (!node?.socket) throw new Error('Expected an authenticated socket')

      channel(client).on(EVENT, received)
      checking = true
      test.server.channel(CHANNEL).emit(EVENT, { private: true })

      await vi.waitFor(() => expect(entered).toBe(true))

      if (change === 'logout') node.authenticated = false
      else if (change === 'identity-change') node.userId = 'other-user'
      else test.server.events.delete(EVENT)
      release()

      await vi.waitFor(() => {
        expect(
          node.socket &&
            test.server.webSocketTransport?.rooms.has(
              node.socket,
              getRoomName(CHANNEL, EVENT),
            ),
        ).toBe(false)
      })
      expect(received).not.toHaveBeenCalled()
    },
  )
})

describe('Redis delivery authorization', () => {
  const sender = new TestUtility({ redis: true })
  const receiver = new TestUtility({ redis: true })

  it('preserves originator exclusion across receiving instances', async () => {
    const options: EventOptions = {
      cluster: true,
      revalidateOnDelivery: true,
      excludeOriginator: true,
    }
    const senderCheck = vi.fn(async () => true)
    const receiverCheck = vi.fn(async () => true)

    sender.server.addEvent(EVENT, { ...options, shouldSubscribe: senderCheck })
    receiver.server.addEvent(EVENT, {
      ...options,
      shouldSubscribe: receiverCheck,
    })

    await Promise.all([
      channel(sender.client).subscribe(EVENT),
      channel(receiver.client).subscribe(EVENT),
    ])

    senderCheck.mockClear()
    receiverCheck.mockClear()

    const local = vi.fn()
    const remote = channel(receiver.client).wait(EVENT)

    channel(sender.client).on(EVENT, local)
    sender.server.channel(CHANNEL).emit(EVENT, { uuid: sender.client.uuid })

    expect(await remote).toEqual({ uuid: sender.client.uuid })
    expect(senderCheck).not.toHaveBeenCalled()
    expect(receiverCheck).toHaveBeenCalledTimes(1)
    expect(local).not.toHaveBeenCalled()
  })

  it('rechecks on each receiving instance without trusting the publisher decision', async () => {
    let receiverAllowed = true
    const options: EventOptions = { cluster: true, revalidateOnDelivery: true }

    sender.server.addEvent(EVENT, options)
    receiver.server.addEvent(EVENT, {
      ...options,
      shouldSubscribe: async () => receiverAllowed,
    })

    await Promise.all([
      channel(sender.client).subscribe(EVENT),
      channel(receiver.client).subscribe(EVENT),
    ])

    const received = vi.fn()
    const socket = receiver.server.allClients.get(receiver.client.uuid)?.socket
    if (!socket) throw new Error('Expected a receiving socket')

    channel(receiver.client).on(EVENT, received)
    receiverAllowed = false

    const local = channel(sender.client).wait(EVENT)

    sender.server.channel(CHANNEL).emit(EVENT, { revision: 2 })

    expect(await local).toEqual({ revision: 2 })

    await vi.waitFor(() => {
      expect(
        receiver.server.webSocketTransport?.rooms.has(
          socket,
          getRoomName(CHANNEL, EVENT),
        ),
      ).toBe(false)
    })
    expect(received).not.toHaveBeenCalled()
  })
})
