import type { TypeFerrySocket } from './types'
import { SocketState } from './types'

interface RoomMembership {
  pending: Promise<void>
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
      if (ws.readyState === SocketState.OPEN) {
        ws.send(data)
      }
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

        ws.send(data)
      })

      // A failed socket send must not poison the subscription's later work.
      membership.pending = delivery.catch(() => undefined)
      deliveries.push(delivery)
    }

    await Promise.all(deliveries)
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
