import isEqual from 'fast-deep-equal'

import { merge } from '../utils/lodash'

import { EJSON } from '../ejson'
import EventEmitter2 from '../utils/event-emitter'
import { ClientEvents } from '../utils'

const STORAGE_KEY = 'context'

/**
 * Known client-side context fields used by the auth/refresh system.
 * The index signature allows arbitrary additional keys while giving
 * first-class types to commonly accessed properties.
 */
export interface TypeFerryContext {
  token?: string
  exp?: number
  iat?: number
  /** Local timestamp when the token was received — used for clock-skew-safe refresh scheduling. */
  _tokenReceivedAt?: number
  [key: string]: unknown
}

/**
 * Manages client context (auth tokens, user data) with localStorage persistence
 * and equality-guarded event emission. Extracted from Client to isolate context
 * concerns from connection/RPC logic.
 */
export class ContextManager extends EventEmitter2 {
  context: TypeFerryContext = {}

  constructor(private storage?: Storage) {
    super({ maxListeners: 512 })
  }

  /**
   * Restores context from localStorage. Skips the update (and the resulting
   * CONTEXT_CHANGED event) when the stored context matches what's already
   * in memory — prevents redundant refresh cascades during initialize().
   */
  loadContext(): void {
    if (!this.storage) return
    const raw = this.storage.getItem(STORAGE_KEY)
    if (!raw) return

    const stored = EJSON.parse(raw) as Record<string, unknown>
    if (isEqual(this.context, stored)) return

    this.updateContext(stored)
  }

  /**
   * Replaces context entirely, persists to storage, and emits CONTEXT_CHANGED.
   *
   * Sensitive keys like `refreshToken` are stripped before persisting to
   * localStorage — the refresh token lives exclusively in an HttpOnly
   * cookie to prevent XSS exfiltration.
   */
  setContext(context: Record<string, unknown>): void {
    this.context = context

    if (this.storage) {
      const { refreshToken: _, ...safe } = context
      this.storage.setItem(STORAGE_KEY, EJSON.stringify(safe))
    }

    this.emit(ClientEvents.CONTEXT_CHANGED)
  }

  /**
   * Merges partial context into the current context and persists the result.
   * Skips the update (and the resulting CONTEXT_CHANGED event) when the
   * merged context is identical to the current one — prevents redundant
   * event cascades that cause infinite refresh loops on unstable transports.
   */
  updateContext(context: Record<string, unknown>): void {
    const newContext = merge({}, this.context, context)

    if (isEqual(this.context, newContext)) return

    this.setContext(newContext)
  }

  /** Resets context to empty, removes from storage, and emits CONTEXT_CHANGED. */
  clearContext(): void {
    this.context = {}

    if (this.storage) {
      this.storage.removeItem(STORAGE_KEY)
    }

    this.emit(ClientEvents.CONTEXT_CHANGED)
  }
}

/**
 * Clock-skew-safe token expiry check. Uses `iat` + `_tokenReceivedAt` when
 * available to compute elapsed time relative to when the token was received
 * locally, preventing false positives when the client clock diverges from
 * the server.
 */
export function isTokenExpired(context: TypeFerryContext): boolean {
  const { exp, iat, _tokenReceivedAt } = context
  if (!exp) return false

  if (iat && _tokenReceivedAt) {
    const tokenTtlMs = (exp - iat) * 1000
    const elapsedMs = Date.now() - _tokenReceivedAt
    return elapsedMs >= tokenTtlMs
  }

  const now = Math.floor(Date.now() / 1000)
  return exp <= now
}
