import { describe, expect, it, vi } from 'vitest'

vi.mock('redis', () => ({
  createClient: () => ({
    connect: vi.fn().mockResolvedValue(undefined),
    duplicate: () => ({
      connect: vi.fn().mockResolvedValue(undefined),
      pSubscribe: vi.fn().mockResolvedValue(undefined),
      isOpen: false,
      quit: vi.fn().mockResolvedValue(undefined),
    }),
    publish: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
    sRem: vi.fn().mockResolvedValue(1),
    isOpen: false,
    quit: vi.fn().mockResolvedValue(undefined),
  }),
}))

import { NO_CHANNEL, Presentation } from '../../utils'
import { Server } from '../server'
import { ServerChannel } from '../server-channel'
import {
  RedisTransport,
  buildRedisEnvelope,
  formatRedisSigningInput,
  parseRedisEnvelope,
} from './redis-transport'

export const CROSS_LANGUAGE_REDIS_HMAC_VECTOR =
  '2fe864725cc91a1de99652933920ffbd5bd716753b3b4a155584e49ea0d4fed0'

describe('RedisTransport envelope validation & HMAC signing', () => {
  it('omits sig when signingSecret is unset for fixture compatibility', () => {
    const encoded = buildRedisEnvelope(
      'ping.tick',
      'room-a',
      '{"t":"event"}',
      'orig-1',
    )
    const decoded = Presentation.decode<Record<string, unknown>>(encoded)
    expect(decoded).toEqual({
      event: 'ping.tick',
      channel: 'room-a',
      message: '{"t":"event"}',
      excludeUuid: 'orig-1',
    })
    expect('sig' in decoded).toBe(false)
    expect(parseRedisEnvelope(encoded)).toEqual({
      event: 'ping.tick',
      channel: 'room-a',
      message: '{"t":"event"}',
      excludeUuid: 'orig-1',
    })
  })

  it('produces the cross-language HMAC-SHA256 digest and verifies it', () => {
    const secret = 'test-secret'
    expect(
      formatRedisSigningInput(
        'chat.message',
        'room-a',
        '{"t":"event"}',
        'orig-1',
      ),
    ).toBe('12:chat.message|6:room-a|13:{"t":"event"}|6:orig-1')

    const encoded = buildRedisEnvelope(
      'chat.message',
      'room-a',
      '{"t":"event"}',
      'orig-1',
      secret,
    )
    const decoded = Presentation.decode<Record<string, unknown>>(encoded)
    expect(decoded.sig).toBe(CROSS_LANGUAGE_REDIS_HMAC_VECTOR)

    expect(parseRedisEnvelope(encoded, secret)).toEqual({
      event: 'chat.message',
      channel: 'room-a',
      message: '{"t":"event"}',
      excludeUuid: 'orig-1',
    })
  })

  it('rejects missing, wrong-type, or tampered HMAC signatures', () => {
    const secret = 'cluster-secret'
    const unsigned = buildRedisEnvelope('chat.message', 'room-a', '{}')
    expect(parseRedisEnvelope(unsigned, secret)).toBeNull()

    const wrongTypeSig = Presentation.encode({
      event: 'chat.message',
      channel: 'room-a',
      message: '{}',
      sig: 12345,
    })
    expect(parseRedisEnvelope(wrongTypeSig, secret)).toBeNull()

    const signed = buildRedisEnvelope('chat.message', 'room-a', '{}', undefined, secret)
    const tampered = signed.replace('chat.message', 'chat.tampered')
    expect(parseRedisEnvelope(tampered, secret)).toBeNull()
  })

  it('rejects malformed frames and non-string channel or excludeUuid', () => {
    expect(parseRedisEnvelope('not-json')).toBeNull()
    expect(parseRedisEnvelope('[]')).toBeNull()
    expect(parseRedisEnvelope('{"event":"","message":"{}"}')).toBeNull()
    expect(parseRedisEnvelope('{"event":"e","message":"{}","channel":123}')).toBeNull()
    expect(
      parseRedisEnvelope('{"event":"e","message":"{}","excludeUuid":{"id":1}}'),
    ).toBeNull()
    expect(parseRedisEnvelope('{"event":"e","message":"{}"}')).toEqual({
      event: 'e',
      channel: NO_CHANNEL,
      message: '{}',
    })
  })

  it('handles bad inbound messages safely and avoids growing server.channels on unknown channels', async () => {
    const server = new Server({
      globalInstance: false,
      host: '127.0.0.1',
      port: 0,
    })
    await server.isReady()
    const propagateSpy = vi
      .spyOn(ServerChannel.prototype, 'propagate')
      .mockImplementation(() => {})
    try {
      const transport = new RedisTransport(server, {
        signingSecret: 'secret-key',
      })

      expect(() => transport.handleIncomingMessage('{{{bad')).not.toThrow()
      expect(() =>
        transport.handleIncomingMessage(
          buildRedisEnvelope('ping', 'unregistered-room', '{"t":"event"}'),
        ),
      ).not.toThrow()
      expect(propagateSpy).not.toHaveBeenCalled()

      transport.handleIncomingMessage(
        buildRedisEnvelope(
          'ping',
          'unregistered-room',
          '{"t":"event"}',
          undefined,
          'secret-key',
        ),
      )

      expect(server.channels.has('unregistered-room')).toBe(false)
      expect(propagateSpy).toHaveBeenCalledWith('ping', '{"t":"event"}', undefined)
      await transport.close()
    } finally {
      propagateSpy.mockRestore()
      await server.close()
    }
  })
})
