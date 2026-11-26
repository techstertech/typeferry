import type { z } from 'zod'

import { isEmpty } from '../utils/lodash'

import { NO_CHANNEL, ServerEvents } from '../utils'
import type { ClientNode } from './client-node'
import { Method } from './method'
import { Server } from './server'

export const MAX_EVENTS_PER_SUBSCRIPTION_BATCH = 256
export const MAX_CHANNEL_NAME_LENGTH = 256
export const MAX_ROOMS_PER_SOCKET = 1024

/**
 * Generates a collision-free room name for a channel/event subscription.
 * Format: `typeferry:${utf8ByteLength(channel)}:${channel}:${event}`
 */
export function getRoomName(channel: string, eventName: string): string {
  return `typeferry:${Buffer.byteLength(channel, 'utf8')}:${channel}:${eventName}`
}

function normalizeSubscriptionInput(rawParams: unknown): {
  events: string[]
  channel: string
} | null {
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    return null
  }
  const params = rawParams as Record<string, unknown>
  const rawChannel = params['channel']
  if (
    rawChannel !== undefined &&
    (typeof rawChannel !== 'string' ||
      rawChannel.length > MAX_CHANNEL_NAME_LENGTH)
  ) {
    return null
  }
  const channel =
    typeof rawChannel === 'string' && rawChannel.length > 0
      ? rawChannel
      : NO_CHANNEL

  const rawEvents = params['events']
  if (!Array.isArray(rawEvents)) {
    return { events: [], channel }
  }
  const events = rawEvents
    .filter((item): item is string => typeof item === 'string')
    .slice(0, MAX_EVENTS_PER_SUBSCRIPTION_BATCH)

  return { events, channel }
}

export const rpcOff = (
  server: Server,
  method: string,
): Method<z.ZodType, unknown> =>
  new Method(
    server,
    method,
    function (rawParams) {
      if (!this.socket) return {}
      const socket = this.socket

      const rooms = server.webSocketTransport?.rooms
      if (!rooms) return {}

      const input = normalizeSubscriptionInput(rawParams)
      if (!input) return {}

      const acc: Record<string, boolean> = {}
      for (const eventName of input.events) {
        const event = server.events.get(eventName)

        if (!event) {
          console.log('[TypeFerry] Event Not Found:', eventName)
          acc[eventName] = false
          continue
        }

        const roomName = getRoomName(input.channel, eventName)
        rooms.leave(socket, roomName)
        acc[eventName] = true
      }

      return acc
    },
    { protected: false },
  )

/**
 * Checks if a client can subscribe to an event and joins the room.
 */
async function canSubscribeToEvent(
  server: Server,
  client: ClientNode,
  eventName: string,
  channel: string,
): Promise<boolean> {
  const event = server.events.get(eventName)

  if (!event) {
    console.log('[TypeFerry] Event Not Found:', eventName)
    return false
  }

  const eventAllowed = !event.isProtected || client.authenticated
  if (!eventAllowed) return false

  const subscribeAllowed = await event.shouldSubscribe(
    client,
    eventName,
    channel,
  )
  if (!subscribeAllowed) return false

  if (!client.socket) return false

  const rooms = server.webSocketTransport?.rooms
  if (!rooms) return false

  const roomName = getRoomName(channel, eventName)
  if (
    !rooms.has(client.socket, roomName) &&
    rooms.getSocketRoomCount(client.socket) >= MAX_ROOMS_PER_SOCKET
  ) {
    return false
  }

  rooms.join(client.socket, roomName)

  return true
}

export const rpcOn = (
  server: Server,
  method: string,
): Method<z.ZodType, unknown> =>
  new Method(
    server,
    method,
    async function (rawParams) {
      const input = normalizeSubscriptionInput(rawParams)
      if (!input || isEmpty(input.events)) return {}

      const channelAllowed = await server.shouldAllowChannelSubscribe(
        this,
        input.channel,
      )

      const acc: Record<string, boolean> = {}

      for (const eventName of input.events) {
        if (!channelAllowed) {
          acc[eventName] = false
          continue
        }

        acc[eventName] = await canSubscribeToEvent(
          server,
          this,
          eventName,
          input.channel,
        )
      }

      return acc
    },
    { protected: false },
  )

export const rpcLogout = (
  server: Server,
  method: string,
): Method<z.ZodType, unknown> =>
  new Method(
    server,
    method,
    async function () {
      if (this.socket) {
        server.webSocketTransport?.rooms?.leaveAll(this.socket)
      }
      this.context = null
      this.authenticated = false
      this.userId = null
      server.emit(ServerEvents.LOGOUT, this)
      return true
    },
    { protected: true },
  )
