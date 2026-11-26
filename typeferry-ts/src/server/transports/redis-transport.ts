import { createHmac, timingSafeEqual } from 'node:crypto'
import type { RedisClientOptions } from 'redis'
import { createClient } from 'redis'

import {
  NO_CHANNEL,
  Presentation,
  RedisListeners,
  ServerEvents,
} from '../../utils'
import type { Server } from '../server'

export type RedisMessage = {
  event: string
  channel: string
  message: string
  excludeUuid?: string
  sig?: string
}

export type RedisTransportOptions = RedisClientOptions & {
  /** Optional shared secret used to sign and verify cluster Redis envelopes. */
  signingSecret?: string
}

export const RedisKey = {
  CLIENTS: 'typeferry:clients',
}

/**
 * Formats the canonical length-prefixed UTF-8 signing input shared across all
 * TypeFerry server runtimes (`PROTOCOL.md` section 2.3).
 */
export function formatRedisSigningInput(
  event: string,
  channel: string,
  message: string,
  excludeUuid?: string,
): string {
  const normalizedChannel = channel || NO_CHANNEL
  const normalizedExclude = excludeUuid ?? ''
  return [
    `${Buffer.byteLength(event, 'utf8')}:${event}`,
    `${Buffer.byteLength(normalizedChannel, 'utf8')}:${normalizedChannel}`,
    `${Buffer.byteLength(message, 'utf8')}:${message}`,
    `${Buffer.byteLength(normalizedExclude, 'utf8')}:${normalizedExclude}`,
  ].join('|')
}

/** Computes lowercase hex HMAC-SHA256 for a normalized Redis envelope. */
export function signRedisEnvelope(
  event: string,
  channel: string,
  message: string,
  excludeUuid: string | undefined,
  signingSecret: string,
): string {
  return createHmac('sha256', signingSecret)
    .update(formatRedisSigningInput(event, channel, message, excludeUuid), 'utf8')
    .digest('hex')
}

/** Encodes a Redis publish envelope, attaching `sig` when `signingSecret` is set. */
export function buildRedisEnvelope(
  event: string,
  channel: string,
  message: string,
  excludeUuid?: string,
  signingSecret?: string,
): string {
  const normalizedChannel = channel || NO_CHANNEL
  const envelope: RedisMessage = {
    event,
    channel: normalizedChannel,
    message,
    ...(excludeUuid === undefined ? {} : { excludeUuid }),
  }
  if (signingSecret) {
    envelope.sig = signRedisEnvelope(
      event,
      normalizedChannel,
      message,
      excludeUuid,
      signingSecret,
    )
  }
  return Presentation.encode<RedisMessage>(envelope)
}

/**
 * Strictly validates an inbound Redis pub/sub payload and, when `signingSecret`
 * is set, verifies its lowercase hex HMAC-SHA256 digest in constant time.
 */
export function parseRedisEnvelope(
  raw: string,
  signingSecret?: string,
): RedisMessage | null {
  let decoded: unknown
  try {
    decoded = Presentation.decode<unknown>(raw)
  } catch {
    return null
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return null
  }
  const record = decoded as Record<string, unknown>
  const rawEvent = record.event
  const rawMessage = record.message
  const rawChannel = record.channel
  const rawExclude = record.excludeUuid

  if (
    typeof rawEvent !== 'string' ||
    rawEvent.length === 0 ||
    typeof rawMessage !== 'string' ||
    rawMessage.length === 0
  ) {
    return null
  }
  if (
    rawChannel !== undefined &&
    rawChannel !== null &&
    typeof rawChannel !== 'string'
  ) {
    return null
  }
  if (
    rawExclude !== undefined &&
    rawExclude !== null &&
    typeof rawExclude !== 'string'
  ) {
    return null
  }

  const channel =
    typeof rawChannel === 'string' && rawChannel.length > 0
      ? rawChannel
      : NO_CHANNEL
  const excludeUuid = typeof rawExclude === 'string' ? rawExclude : undefined

  if (signingSecret) {
    const rawSig = record.sig
    if (typeof rawSig !== 'string') {
      return null
    }
    const expectedSig = signRedisEnvelope(
      rawEvent,
      channel,
      rawMessage,
      excludeUuid,
      signingSecret,
    )
    const providedBuf = Buffer.from(rawSig, 'utf8')
    const expectedBuf = Buffer.from(expectedSig, 'utf8')
    if (
      providedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(providedBuf, expectedBuf)
    ) {
      return null
    }
  }

  return {
    event: rawEvent,
    channel,
    message: rawMessage,
    ...(excludeUuid === undefined ? {} : { excludeUuid }),
  }
}

/**
 * This is mainly used to propagate events to other instances when running node in a cluster.
 */
export class RedisTransport {
  opts: RedisClientOptions
  pub: ReturnType<typeof createClient> | undefined
  sub: ReturnType<typeof createClient> | undefined
  private readonly signingSecret: string | undefined

  server: Server

  static defaultRedisOpts: RedisClientOptions = {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  }

  constructor(server: Server, opts: RedisTransportOptions | boolean) {
    this.server = server
    if (typeof opts === 'object' && opts !== null) {
      const { signingSecret, ...clientOpts } = opts
      this.signingSecret = signingSecret || undefined
      this.opts = Object.assign({}, RedisTransport.defaultRedisOpts, clientOpts)
    } else {
      this.signingSecret = undefined
      this.opts = Object.assign({}, RedisTransport.defaultRedisOpts)
    }

    this.connect().catch(console.error)
  }

  private async connect() {
    this.pub = createClient({
      ...RedisTransport.defaultRedisOpts,
      ...this.opts,
    })
    this.sub = this.pub.duplicate()

    const publisher = this.pub
    const subscriber = this.sub

    await publisher.connect()
    await subscriber.connect()

    await subscriber.pSubscribe(RedisListeners.EVENTS, (redisMessage: string) => {
      this.handleIncomingMessage(redisMessage)
    })

    this.server.emit(ServerEvents.REDIS_CONNECT)
  }

  /**
   * Validates and propagates an inbound Redis pub/sub payload without growing
   * `server.channels` on unknown channels.
   */
  handleIncomingMessage(redisMessage: string): void {
    try {
      const decoded = parseRedisEnvelope(redisMessage, this.signingSecret)
      if (!decoded) return

      // Route through existing ServerChannel or an unstored transient channel
      // so untrusted inbound frames cannot allocate unbounded map entries.
      const target = this.server.resolveTransientChannel(decoded.channel)

      // Do not add a debugger here, it will cause an infinite loop since it
      // triggers an event that also goes through the transport.
      target.propagate(decoded.event, decoded.message, decoded.excludeUuid)
    } catch {
      console.warn('[TypeFerry] Invalid Redis event frame')
    }
  }

  /**
   * Publishes an event to the Redis channel for cluster-wide propagation.
   * @param excludeUuid - Optional client uuid to exclude from receiving the event
   */
  async publish(
    event: string,
    channel: string = NO_CHANNEL,
    message: string,
    excludeUuid?: string,
  ) {
    if (!this.pub) return

    // Do not add a debugger here, it will cause an infinite loop since it
    // triggers an event this also goes through the transport.

    return this.pub.publish(
      RedisListeners.EVENTS,
      buildRedisEnvelope(
        event,
        channel,
        message,
        excludeUuid,
        this.signingSecret,
      ),
    )
  }

  async close() {
    if (this.pub) {
      await this.pub.del(`typeferry:clients:${this.server.uuid}`)
      await this.pub.sRem(`typeferry:servers`, this.server.uuid)
    }

    if (this.pub?.isOpen) await this.pub.quit()
    if (this.sub?.isOpen) await this.sub.quit()

    this.pub = undefined
    this.sub = undefined
  }

  public async getStats() {
    let clientCount = 0
    let userCount = 0
    const users = new Set<string>()

    if (!this.pub) {
      return { clientCount, userCount, users: [] }
    }

    const servers = await this.pub.sMembers(`typeferry:servers`)

    for (const server of servers) {
      clientCount += await this.pub.sCard(`typeferry:clients:${server}`)
      userCount += await this.pub.sCard(`typeferry:users:${server}`)

      const serverUsers = await this.pub.sMembers(`typeferry:users:${server}`)

      serverUsers.forEach(user => users.add(user))
    }

    return {
      clientCount,
      userCount,
      users: Array.from(users),
    }
  }
}
