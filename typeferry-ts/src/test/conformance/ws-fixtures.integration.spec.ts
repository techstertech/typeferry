/**
 * Replay every WebSocket sequence fixture against the TS server
 * using the Node `ws` package as a raw client.
 */

import path from 'node:path'
import WebSocket from 'ws'
import { describe, expect, it } from 'vitest'

import type { ClientNode, Server } from '../../server'
import { TYPEFERRY_WS_PATH, Presentation } from '../../utils'
import { TestUtility } from '../test-utility'

import { buildHandler, listSequences, loadSequence } from './harness'

function configureServer(server: Server, setup: any): void {
  if (!setup) return
  for (const spec of setup.methods ?? []) {
    const handler = buildHandler(spec.handler)
    server.addMethod(spec.name, handler as any, {
      protected: !!spec.protected,
      cache: !!spec.cache,
    })
  }
  for (const spec of setup.events ?? []) {
    server.addEvent(spec.name)
  }
  if (setup.auth) {
    const { accept_token: accept, user } = setup.auth
    server.setAuth({
      auth: async function (this: ClientNode, context: any) {
        if (context?.token === accept) return { user }
        return false
      },
      logIn: async () => true,
    })
  }
}

/** A buffering WS wrapper — captures every non-ping frame from open. */
class BufferingSocket {
  readonly ws: WebSocket
  private queue: any[] = []
  private waiters: ((frame: any) => void)[] = []

  constructor(address: string, query: Record<string, unknown>) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) params.set(k, String(v))
    const q = params.toString()
    this.ws = new WebSocket(
      `ws://${address}${TYPEFERRY_WS_PATH}${q ? `?${q}` : ''}`,
    )
    this.ws.on('message', raw => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8')
      const decoded = Presentation.decode(text) as any
      if (decoded?.t === 'ping') return
      const waiter = this.waiters.shift()
      if (waiter) waiter(decoded)
      else this.queue.push(decoded)
    })
  }

  async waitOpen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve())
      this.ws.once('error', reject)
    })
  }

  next(timeoutMs = 1000): Promise<any> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for server frame')),
        timeoutMs,
      )
      this.waiters.push(frame => {
        clearTimeout(timer)
        resolve(frame)
      })
    })
  }

  async expectNone(windowMs: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, windowMs))
    if (this.queue.length > 0) {
      throw new Error(
        `unexpected server frame within ${windowMs}ms: ${JSON.stringify(this.queue[0]!)}`,
      )
    }
  }

  send(frame: unknown): void {
    this.ws.send(Presentation.encode(frame))
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close()
  }

  get state(): number {
    return this.ws.readyState
  }
}

describe('WebSocket conformance fixtures', () => {
  const utility = new TestUtility({ debug: false })

  for (const seqPath of listSequences('ws')) {
    const name = path.basename(seqPath, '.seq.ndjson')
    it(`${name}`, async () => {
      const script = loadSequence(seqPath)
      const setupOp = script.shift()!
      expect(setupOp.op).toBe('setup')
      configureServer(utility.server, setupOp)

      const connectOp = script.shift()!
      expect(connectOp.op).toBe('connect')

      const socket = new BufferingSocket(
        utility.address,
        connectOp.query ?? {},
      )
      await socket.waitOpen()

      try {
        for (const op of script) {
          if (op.op === 'send') {
            socket.send(op.frame)
          } else if (op.op === 'expect_server_frame') {
            const frame = (await socket.next()) as Record<string, unknown>
            // Event frames carry a server-assigned uuid; strip before compare.
            const normalized =
              frame.t === 'event' && 'uuid' in frame && !('uuid' in op.frame)
                ? Object.fromEntries(
                    Object.entries(frame).filter(([k]) => k !== 'uuid'),
                  )
                : frame
            expect(normalized).toEqual(op.frame)
          } else if (op.op === 'expect_no_server_frame') {
            await socket.expectNone(op.within_ms ?? 100)
          } else if (op.op === 'server_emit') {
            utility.server.channel(op.channel).emit(op.event, op.params)
          } else if (op.op === 'disconnect') {
            socket.close()
            break
          } else {
            throw new Error(`unknown op in ${name}: ${op.op}`)
          }
        }
      } finally {
        socket.close()
      }
    })
  }
})
