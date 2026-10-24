import WS from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Client } from '../../client'
import { ClientEvents } from '../../utils'
import { type GoConformanceServer, startGoConformanceServer } from './go-server'
import { goMethodContract } from './go-contract'

describe('TypeScript WebSocket client ↔ Go server', () => {
  let fixture: GoConformanceServer
  let port: number

  beforeAll(async () => {
    ;(globalThis as unknown as { WebSocket: typeof WS }).WebSocket = WS
    fixture = await startGoConformanceServer()
    port = fixture.port
  }, 35_000)

  afterAll(async () => { await fixture?.close() })

  async function newClient(token?: string): Promise<Client> {
    return await new Promise<Client>((resolve, reject) => {
      const client = new Client({ host: '127.0.0.1', port, ...(token ? { initialContext: { token } } : {}) })
      client.once(ClientEvents.INITIALIZED, () => resolve(client))
      client.once(ClientEvents.ERROR, reject)
    })
  }

  goMethodContract(async token => {
    const client = await newClient(token)
    return {
      call: (method, params) => client.call(method, params, { httpFallback: false }),
      close: () => client.close(),
    }
  })

  it('calls methods and reports authorization errors', async () => {
    const client = await newClient()
    try {
      expect(await client.call('add', { a: 2, b: 3 })).toBe(5)
      await expect(client.call('whoami')).rejects.toBeDefined()
    } finally {
      await client.close()
    }
  })

  it('enforces protected and user event subscriptions with the current identity', async () => {
    const anonymous = await newClient()
    const authenticated = await newClient('good-token')
    const subscribe = (client: Client, channel: string) => client.call('rpc:on', {
      channel, events: ['protected.tick', 'user.tick', 'missing.tick'],
    }, { httpFallback: false })
    try {
      expect(await subscribe(anonymous, 'u1')).toEqual({ 'protected.tick': false, 'user.tick': false, 'missing.tick': false })
      expect(await subscribe(authenticated, 'u1')).toEqual({ 'protected.tick': true, 'user.tick': true, 'missing.tick': false })
      expect(await subscribe(authenticated, 'u2')).toEqual({ 'protected.tick': true, 'user.tick': false, 'missing.tick': false })
      await authenticated.call('rpc:logout')
      expect(await subscribe(authenticated, 'u1')).toEqual({ 'protected.tick': false, 'user.tick': false, 'missing.tick': false })
    } finally {
      await Promise.all([anonymous.close(), authenticated.close()])
    }
  })

  it('excludes the originator and releases subscription rooms on disconnect', async () => {
    const originator = await newClient()
    const observer = await newClient()
    const channelName = `excluded-${originator.uuid}`
    try {
      const originatingChannel = originator.channel(channelName)!
      const observingChannel = observer.channel(channelName)!
      let echoes = 0
      originatingChannel.on('excluded.tick', () => { echoes += 1 })
      await originatingChannel.subscribe('excluded.tick')
      await observingChannel.subscribe('excluded.tick')
      const received = new Promise(resolve => observingChannel.once('excluded.tick', resolve))
      const params = { uuid: originator.uuid, n: 9 }
      await originator.call('emit_event', { event: 'excluded.tick', channel: channelName, params })
      await expect(received).resolves.toEqual(params)
      expect(echoes).toBe(0)
      expect(await originator.call('room_size', { event: 'excluded.tick', channel: channelName })).toBe(2)
      await observer.close()
      await expect.poll(() => originator.call('room_size', { event: 'excluded.tick', channel: channelName })).toBe(1)
      await originatingChannel.unsubscribe('excluded.tick')
      expect(await originator.call('room_size', { event: 'excluded.tick', channel: channelName })).toBe(0)
    } finally {
      await Promise.all([originator.close(), observer.close()])
    }
  })

  it('authenticates and receives a channel event', async () => {
    const client = await newClient('good-token')
    try {
      expect(await client.call('whoami')).toBe('u1')
      const channel = client.channel('room-go')!
      const received = new Promise(resolve => channel.once('ping.tick', resolve))
      await channel.subscribe('ping.tick')
      await client.call('emit_ping', { channel: 'room-go', params: { n: 7 } })
      await expect(received).resolves.toEqual({ n: 7 })
      await channel.unsubscribe('ping.tick')
    } finally {
      await client.close()
    }
  })

  it('releases a pending call through the same WebSocket', async () => {
    const client = await newClient()
    try {
      const key = `wait-${client.uuid}`
      const pending = client.call('wait_for_release', { key }, { httpFallback: false, timeout: 2000 })
      void pending.catch(() => undefined)
      // Registration and delivery are asynchronous. Retry only until the keyed
      // latch is admitted; a serial server cannot process this release at all.
      await expect.poll(() => client.call('release_wait', { key }, { httpFallback: false, timeout: 2000 }), { timeout: 2000 }).toBe(true)
      await expect(pending).resolves.toBe('released')
    } finally {
      await client.close()
    }
  })

  it('calls the application login method and clears protected access on logout', async () => {
    const client = await newClient('good-token')
    try {
      expect(await client.call('rpc:login', {})).toBe(true)
      expect(await client.call('whoami')).toBe('u1')
      expect(await client.call('rpc:logout')).toBe(true)
      await expect(client.call('whoami')).rejects.toBeDefined()
    } finally {
      await client.close()
    }
  })

  it('reconnects after duplicate UUID replacement and restores subscriptions', async () => {
    const client = await newClient()
    try {
      const channel = client.channel('room-reconnect')!
      await channel.subscribe('ping.tick')
      const reinitialized = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Go reconnect timed out')), 5000)
        client.once(ClientEvents.INITIALIZED, () => {
          clearTimeout(timeout)
          resolve()
        })
      })
      const duplicate = new WS(`ws://127.0.0.1:${port}/typeferry-ws?uuid=${client.uuid}`)
      duplicate.on('error', () => undefined)
      await new Promise<void>((resolve, reject) => {
        duplicate.once('open', () => resolve())
        duplicate.once('error', reject)
      })
      await reinitialized
      duplicate.terminate()
      const received = new Promise(resolve => channel.once('ping.tick', resolve))
      await client.call('emit_ping', { channel: 'room-reconnect', params: { n: 8 } })
      await expect(received).resolves.toEqual({ n: 8 })
    } finally {
      await client.close()
    }
  }, 10000)
})
