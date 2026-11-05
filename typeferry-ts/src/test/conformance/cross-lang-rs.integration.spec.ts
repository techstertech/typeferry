/**
 * Cross-language integration: JS client ↔ Rust server.
 *
 * Spawns ``typeferry-rs/crates/typeferry-conformance-server`` via cargo,
 * parses the bound port from its stderr, then drives a Node-mode
 * TypeFerry Client over the wire. Validates the Rust server is a
 * drop-in replacement for the TS server from the client's perspective.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import WS from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Client } from '../../client'
import { ClientEvents } from '../../utils'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const RUST_DIR = path.join(REPO_ROOT, 'typeferry-rs')

function cargoAvailable(): boolean {
  try {
    const result = spawnSync('cargo', ['--version'], { stdio: 'ignore' })
    return result.status === 0
  } catch {
    return false
  }
}

const RUST_AVAILABLE =
  fs.existsSync(RUST_DIR) &&
  fs.existsSync(
    path.join(RUST_DIR, 'crates/typeferry-conformance-server/Cargo.toml'),
  ) &&
  cargoAvailable()
const describeIf = RUST_AVAILABLE ? describe : describe.skip

function readPortFromStderr(proc: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error('timed out waiting for Rust server to print TYPEFERRY_PORT'),
      )
    }, 90_000)
    let buffer = ''
    proc.stderr?.on('data', chunk => {
      buffer += chunk.toString('utf8')
      const match = buffer.match(/TYPEFERRY_PORT=(\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve(Number.parseInt(match[1]!, 10))
      }
    })
    proc.once('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    proc.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`Rust server exited early with code ${code}`))
    })
  })
}

describeIf('JS client ↔ Rust server (cross-language integration)', () => {
  let proc: ChildProcess
  let port: number

  beforeAll(async () => {
    ;(globalThis as any).WebSocket = WS

    // Pre-build so we don't pay compile latency inside the spawn.
    const build = spawnSync(
      'cargo',
      ['build', '--quiet', '-p', 'typeferry-conformance-server'],
      { cwd: RUST_DIR, stdio: 'inherit' },
    )
    expect(build.status).toBe(0)

    proc = spawn(
      'cargo',
      ['run', '--quiet', '-p', 'typeferry-conformance-server'],
      {
        cwd: RUST_DIR,
        env: { ...process.env, RUST_LOG: 'warn' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    port = await readPortFromStderr(proc)
  }, 120_000)

  afterAll(async () => {
    if (proc && !proc.killed) proc.kill('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 200))
  })

  async function newClient(context?: Record<string, unknown>): Promise<Client> {
    return await new Promise<Client>((resolve, reject) => {
      const client = new Client({
        host: '127.0.0.1',
        port,
        ...(context === undefined ? {} : { initialContext: context }),
      })
      client.once(ClientEvents.INITIALIZED, () => resolve(client))
      client.once(ClientEvents.ERROR, reject)
    })
  }

  it('can call an unauthenticated RPC method (add)', async () => {
    const client = await newClient()
    try {
      const result = await client.call('add', { a: 2, b: 3 })
      expect(result).toBe(5)
    } finally {
      await client.close()
    }
  })

  it('echoes a JSON payload through the Rust server', async () => {
    const client = await newClient()
    try {
      const result = (await client.call('echo', {
        nested: { a: 1, list: [1, 2, 3] },
      })) as any
      expect(result.nested.a).toBe(1)
      expect(result.nested.list).toEqual([1, 2, 3])
    } finally {
      await client.close()
    }
  })

  it('rejects protected methods without a valid token', async () => {
    const client = await newClient()
    try {
      await expect(client.call('whoami')).rejects.toBeDefined()
    } finally {
      await client.close()
    }
  })

  it('preserves dates across the full JavaScript date range', async () => {
    const client = await newClient()
    const limit = 8_640_000_000_000_000
    const dates = [-limit, limit].map(millis => new Date(millis))

    try {
      const result: unknown = await client.call('echo', { dates })

      expect(result).toEqual({ dates })
    } finally {
      await client.close()
    }
  })

  it('accepts a valid token and returns the authenticated user id', async () => {
    const client = await newClient({ token: 'good-token' })
    try {
      const result = await client.call('whoami')
      expect(result).toBe('u1')
    } finally {
      await client.close()
    }
  })

  it('subscribes via rpc:on and receives a server-emitted event', async () => {
    const client = await newClient()
    try {
      const channel = client.channel('room-rs')!
      const received: any[] = []
      const seen = new Promise<void>(resolve => {
        channel.on('ping.tick', (payload: any) => {
          received.push(payload)
          resolve()
        })
      })
      await channel.subscribe('ping.tick')

      await client.call('emit_ping', {
        channel: 'room-rs',
        params: { n: 7 },
      })

      // Wait up to 2s for the event to land.
      await Promise.race([
        seen,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('event never arrived')), 2000),
        ),
      ])
      expect(received).toEqual([{ n: 7 }])

      await channel.unsubscribe('ping.tick')
    } finally {
      await client.close()
    }
  })
})
