import { describe, expect, it, vi } from 'vitest'

import { RoomRegistry } from './room-registry'
import type { TypeFerrySocket } from './types'
import { SocketState } from './types'

function socket(): TypeFerrySocket & {
  send: ReturnType<typeof vi.fn<TypeFerrySocket['send']>>
} {
  return {
    readyState: SocketState.OPEN,
    send: vi.fn<TypeFerrySocket['send']>(),
    close: vi.fn(),
  }
}

function gate(): {
  promise: Promise<boolean>
  release: (allowed: boolean) => void
} {
  let release: (allowed: boolean) => void = () => undefined
  const promise = new Promise<boolean>((resolve) => {
    release = resolve
  })

  return { promise, release }
}

describe('Authorized room delivery', () => {
  it('keeps FIFO per recipient without blocking other recipients', async () => {
    const rooms = new RoomRegistry()
    const slow = socket()
    const fast = socket()
    const first = gate()

    rooms.join(slow, 'room')
    rooms.join(fast, 'room')

    const delivery1 = rooms.broadcastAuthorized('room', 'first', (ws) =>
      ws === slow ? first.promise : Promise.resolve(true),
    )
    const delivery2 = rooms.broadcastAuthorized(
      'room',
      'second',
      async () => true,
    )

    await vi.waitFor(() =>
      expect(fast.send.mock.calls).toEqual([['first'], ['second']]),
    )
    expect(slow.send).not.toHaveBeenCalled()

    first.release(true)

    await Promise.all([delivery1, delivery2])

    expect(slow.send.mock.calls).toEqual([['first'], ['second']])
  })

  it('evicts a denied recipient only from that room and skips its queued messages', async () => {
    const rooms = new RoomRegistry()
    const ws = socket()
    const pending = gate()
    const laterCheck = vi.fn(async () => true)

    rooms.join(ws, 'room')
    rooms.join(ws, 'other')

    const first = rooms.broadcastAuthorized(
      'room',
      'private',
      () => pending.promise,
    )
    const second = rooms.broadcastAuthorized('room', 'later', laterCheck)

    pending.release(false)

    await Promise.all([first, second])

    expect(ws.send).not.toHaveBeenCalled()
    expect(laterCheck).not.toHaveBeenCalled()
    expect(rooms.has(ws, 'room')).toBe(false)
    expect(rooms.has(ws, 'other')).toBe(true)
  })

  it.each(['leave', 'rejoin', 'disconnect', 'close'] as const)(
    'invalidates a pending send after %s',
    async (change) => {
      const rooms = new RoomRegistry()
      const ws = socket()
      const pending = gate()
      const checking = vi.fn(() => pending.promise)

      rooms.join(ws, 'room')

      const delivery = rooms.broadcastAuthorized('room', 'stale', checking)

      await vi.waitFor(() => expect(checking).toHaveBeenCalled())

      if (change === 'disconnect') rooms.leaveAll(ws)
      else if (change === 'close')
        Object.assign(ws, { readyState: SocketState.CLOSED })
      else {
        rooms.leave(ws, 'room')
        if (change === 'rejoin') rooms.join(ws, 'room')
      }

      pending.release(change !== 'rejoin')

      await delivery

      expect(ws.send).not.toHaveBeenCalled()
      if (change === 'rejoin') expect(rooms.has(ws, 'room')).toBe(true)
    },
  )
})
