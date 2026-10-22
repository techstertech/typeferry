import { TypeFerryEvents, ServerEvents } from '../utils'
import EventEmitter2 from '../utils/event-emitter'
import type { ClientNode } from './client-node'
import type { EventOptions } from './event'
import { Event } from './event'
import { getRoomName } from './methods'
import type { Server } from './server'
import { HttpTransportEvents, WebSocketTransportEvents } from './transports'

const SystemEvents: string[] = [
  ...Object.values(HttpTransportEvents),
  ...Object.values(ServerEvents),
  ...Object.values(WebSocketTransportEvents),
]

export class ServerChannel extends EventEmitter2 {
  channelName: string
  private attachedServer: Server | undefined

  constructor(channelName: string) {
    super({
      maxListeners: 1024,
    })

    this.channelName = channelName

    this.onAny((event, value) => {
      if (
        this.attachedServer &&
        !this.attachedServer.events.has(event as string) &&
        !SystemEvents.includes(event as string)
      ) {
        console.warn('Event Not Registered:', event)
      }

      if (this.attachedServer?.events.has(event as string)) {
        const eventObject = this.attachedServer.events.get(event as string)

        eventObject?.handler(this, value)
      }
    })
  }

  setServer(server: Server) {
    this.attachedServer = server
  }

  get server(): Server {
    return this.requireServer()
  }

  private requireServer(): Server {
    if (!this.attachedServer) {
      throw new Error('Server channel is not attached to a server')
    }

    return this.attachedServer
  }

  /**
   * Broadcasts a pre-encoded event payload to all subscribed clients.
   * The payload already contains the wire protocol `t` field (set by
   * Event.handler), so no re-encoding is needed.
   * @param excludeUuid - Optional client uuid to exclude from receiving the event
   */
  propagate(event: string, payload: string, excludeUuid?: string): void {
    const server = this.requireServer()
    const eventObject = server.events.get(event)

    if (!eventObject) {
      console.log('Event Not Registered:', event)
      return
    }

    const transport = server.webSocketTransport
    if (!transport) {
      console.warn('[TypeFerry] WebSocket transport not available for propagate')
      return
    }

    const roomName = getRoomName(this.channelName, event)

    if (eventObject.revalidateOnDelivery) {
      const excludeSocket = excludeUuid
        ? server.allClients.get(excludeUuid)?.socket ?? undefined
        : undefined

      transport.rooms.broadcastAuthorized(
        roomName,
        payload,
        async socket => {
          const client = server.getClientBySocket(socket)
          if (!client || (eventObject.isProtected && !client.authenticated)) {
            return false
          }

          const userId = client.userId

          if (!(await server.shouldAllowChannelSubscribe(client, this.channelName))) {
            return false
          }
          if (!(await eventObject.shouldSubscribe(client, event, this.channelName))) {
            return false
          }

          // Logout or event removal can happen while an application check awaits.
          return (
            server.events.get(event) === eventObject &&
            client.userId === userId &&
            (!eventObject.isProtected || client.authenticated)
          )
        },
        excludeSocket,
      ).catch(() => {
        console.warn('[TypeFerry] Event delivery failed', event)
      })

      return
    }

    if (excludeUuid) {
      const excludeClient = server.allClients.get(excludeUuid)
      transport.rooms.broadcast(roomName, payload, excludeClient?.socket ?? undefined)
    } else {
      transport.rooms.broadcast(roomName, payload)
    }
  }

  defer<T = any>(event: string, params?: T) {
    process.nextTick(() => {
      this.emit(event, params)
    })
  }

  /** Refreshes a method by its identifier. */
  refresh(method: string) {
    this.emit(TypeFerryEvents.METHOD_REFRESH, method)
  }

  /** Declares a new event. */
  addEvent(name: string, opts?: EventOptions) {
    const server = this.requireServer()
    if (server.events.has(name)) {
      server.events.delete(name)
    }

    const event = new Event(name, server, this, opts)

    server.events.set(name, event)
  }

  get list() {
    return Array.from(this.requireServer().events.keys())
  }

  get length() {
    return this.requireServer().events.size
  }

  get(event: string) {
    return this.requireServer().events.get(event)
  }

  has(event: string) {
    return this.requireServer().events.has(event)
  }

  delete(event: string) {
    return this.requireServer().events.delete(event)
  }

  /**
   * Checks if a client is subscribed to an event via the RoomRegistry.
   */
  isSubscribed(client: ClientNode, event: Event): boolean {
    if (!client.socket) return false

    const server = this.requireServer()
    const rooms = server.webSocketTransport?.rooms
    if (!rooms) return false

    const roomName = getRoomName(this.channelName, event.name)
    return rooms.has(client.socket, roomName)
  }
}
