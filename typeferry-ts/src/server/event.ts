import { MessageType, Presentation } from '../utils'
import type { ClientNode } from './client-node'
import type { Server } from './server'
import type { ServerChannel } from './server-channel'

export type EventOptions = {
  /**
   * Requires authentication to subscribe to this event.
   */
  protected?: boolean

  /**
   * Recheck authentication, channel authorization and shouldSubscribe before
   * each delivery, including on receiving Redis instances. Denial or a thrown
   * predicate removes only this event/channel subscription. Defaults to false.
   * Application predicates must read current access; decisions are not cached.
   */
  revalidateOnDelivery?: boolean

  /**
   * Only allow user to subscribe to this event on his own channel. Automatically makes the event protected.
   */
  user?: boolean

  /**
   * This overrides the `user` flag.
   */
  shouldSubscribe?: (
    client: ClientNode,
    eventName: string,
    channel: string,
  ) => Promise<boolean>

  /**
   * This will propagate the event to other instances when running node in a cluster.
   */
  cluster?: boolean

  /**
   * When true, excludes the originating client from receiving the event.
   * Requires `params.uuid` to identify the originator.
   */
  excludeOriginator?: boolean
}

export class Event {
  uuid: string
  name: string
  isProtected: boolean
  channel: ServerChannel
  server: Server
  cluster: boolean
  excludeOriginator: boolean
  revalidateOnDelivery: boolean

  shouldSubscribe: (
    client: ClientNode,
    eventName: string,
    channel: string,
  ) => Promise<boolean> = async () => true

  constructor(
    name: string,
    server: Server,
    channel: ServerChannel,
    opts?: EventOptions,
  ) {
    this.uuid = Presentation.uuid()
    this.name = name
    this.server = server
    this.channel = channel

    this.isProtected = opts?.protected ?? false
    this.revalidateOnDelivery = opts?.revalidateOnDelivery ?? false

    if (opts?.user) {
      this.isProtected = true

      this.shouldSubscribe = async function (client, event, channel) {
        if (!client.userId) return false

        return channel === client.userId.toString()
      }
    }

    if (opts?.shouldSubscribe) {
      this.shouldSubscribe = opts.shouldSubscribe
    }

    this.cluster = Boolean(opts?.cluster)
    this.excludeOriginator = Boolean(opts?.excludeOriginator)
  }

  /**
   * Encodes the event with the wire protocol `t` field so propagate()
   * can forward the payload directly without re-encoding.
   */
  handler(channel: ServerChannel, params: Record<string, string>): void {
    const payload = Presentation.encode({
      t: MessageType.EVENT,
      uuid: Presentation.uuid(),
      event: this.name,
      channel: channel.channelName,
      params,
    })

    const excludeUuid = this.excludeOriginator ? params.uuid : undefined

    if (this.cluster && this.server?.redisTransport?.pub) {
      this.server.redisTransport
        .publish(this.name, channel.channelName, payload, excludeUuid)
        .catch(console.error)

      return
    }

    channel.propagate(this.name, payload, excludeUuid)
  }
}
