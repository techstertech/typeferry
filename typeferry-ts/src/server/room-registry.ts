import type { TypeFerrySocket } from './types'
import { SocketState } from './types'

export const DEFAULT_MAX_OUTBOUND_BUFFER_BYTES = 4 * 1024 * 1024

interface RoomMembership {
  pending: Promise<void>
}

/**
 * Checks outbound socket backpressure before queueing a frame. Slow peers whose
 * send buffer reaches `maxBufferedBytes` are closed instead of buffering
 * unbounded frames in memory.
 */
export function sendWithinBackpressureLimit(
  ws: TypeFerrySocket,
  data: string,
  maxBufferedBytes: number = DEFAULT_MAX_OUTBOUND_BUFFER_BYTES,
): boolean {
  if (ws.readyState !== SocketState.OPEN) return false
  if (
    typeof ws.bufferedAmount === 'number' &&
    ws.bufferedAmount >= maxBufferedBytes
  ) {
    try {
      ws.close(1008, 'Backpressure limit exceeded')
    } catch {
      // Socket may already be closing.
    }
    return false
  }
  try {
    ws.send(data)
    return true
  } catch {
    // Socket may close between readyState check and send.
    return false
  }
}

/**
 * In-memory room/subscription registry replacing Socket.IO's room system.
 *
 * Indexed join/leave is O(1); broadcasting visits only the room's recipients,
 * and disconnect cleanup visits only the socket's joined rooms.
 */
export class RoomRegistry {
  /**
   * Room name to socket memberships; identity invalidates pending deliveries.
   */
  private rooms = new Map<string, Map<TypeFerrySocket, RoomMembership>>()

  /** socket → set of rooms it has joined (reverse index for fast cleanup) */
  private socketRooms = new Map<TypeFerrySocket, Set<string>>()

  private readonly maxOutboundBufferBytes: number

  constructor(
    options: { maxOutboundBufferBytes?: number } = {},
  ) {
    const limit =
      options.maxOutboundBufferBytes ?? DEFAULT_MAX_OUTBOUND_BUFFER_BYTES
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(
        'maxOutboundBufferBytes must be a positive finite number',
      )
    }
    this.maxOutboundBufferBytes = limit
  }

  /** Adds a socket to a room. Idempotent. */
  join(ws: TypeFerrySocket, room: string): void {
    let members = this.rooms.get(room)
    if (!members) {
      members = new Map()
      this.rooms.set(room, members)
    }
    if (!members.has(ws)) members.set(ws, { pending: Promise.resolve() })

    let joined = this.socketRooms.get(ws)
    if (!joined) {
      joined = new Set()
      this.socketRooms.set(ws, joined)
    }
    joined.add(room)
  }

  /** Removes a socket from a room. Cleans up empty rooms. */
  leave(ws: TypeFerrySocket, room: string): void {
    const members = this.rooms.get(room)
    if (members) {
      members.delete(ws)
      if (members.size === 0) this.rooms.delete(room)
    }

    const joined = this.socketRooms.get(ws)
    if (joined) {
      joined.delete(room)
      if (joined.size === 0) this.socketRooms.delete(ws)
    }
  }

  /** Removes a socket from all rooms. Called on disconnect. */
  leaveAll(ws: TypeFerrySocket): void {
    const joined = this.socketRooms.get(ws)
    if (!joined) return

    for (const room of joined) {
      const members = this.rooms.get(room)
      if (members) {
        members.delete(ws)
        if (members.size === 0) this.rooms.delete(room)
      }
    }

    this.socketRooms.delete(ws)
  }

  /**
   * Sends `data` to every socket in `room`.
   * Optionally excludes a single socket (e.g. the originator).
   */
  broadcast(room: string, data: string, exclude?: TypeFerrySocket): void {
    const members = this.rooms.get(room)
    if (!members) return

    for (const ws of members.keys()) {
      if (ws === exclude) continue
      sendWithinBackpressureLimit(ws, data, this.maxOutboundBufferBytes)
    }
  }

  /**
   * Authorizes immediately before sending, in FIFO order per membership.
   * Independent recipients progress concurrently. Leaving and rejoining creates
   * a new membership so a stale check cannot send to or evict that subscription.
   * Authorization failures deny delivery and evict only the captured membership.
   */
  async broadcastAuthorized(
    room: string,
    data: string,
    authorize: (socket: TypeFerrySocket) => Promise<boolean>,
    exclude?: TypeFerrySocket,
  ): Promise<void> {
    const members = this.rooms.get(room)
    if (!members) return

    const deliveries: Promise<void>[] = []

    for (const [ws, membership] of members) {
      if (ws === exclude) continue

      const isCurrent = (): boolean =>
        this.rooms.get(room)?.get(ws) === membership &&
        ws.readyState === SocketState.OPEN

      const delivery = membership.pending.then(async () => {
        if (!isCurrent()) return

        let allowed = false

        try {
          allowed = await authorize(ws)
        } catch {
          // Predicate errors may contain private context; never log their value.
          console.warn('[TypeFerry] Event delivery authorization failed')
        }

        if (!isCurrent()) return
        if (!allowed) {
          this.leave(ws, room)
          return
        }

        sendWithinBackpressureLimit(ws, data, this.maxOutboundBufferBytes)
      })

      // A failed socket send must not poison the subscription's later work.
      membership.pending = delivery.catch(() => undefined)
      deliveries.push(delivery)
    }

    await Promise.all(deliveries)
  }

  /** Returns the number of rooms a socket has joined. */
  getSocketRoomCount(ws: TypeFerrySocket): number {
    return this.socketRooms.get(ws)?.size ?? 0
  }

  /** Returns true if `ws` is a member of `room`. */
  has(ws: TypeFerrySocket, room: string): boolean {
    return this.rooms.get(room)?.has(ws) ?? false
  }

  /** Returns the number of sockets in a room. */
  getRoomSize(room: string): number {
    return this.rooms.get(room)?.size ?? 0
  }
}
