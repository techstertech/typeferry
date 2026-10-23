import type { Client } from '../../client'
import { LogLevel } from '../../client/logger'
import type { TokenRefreshConfig } from '../types'
import { broadcastTokenRefresh, setupCrossTabSync } from './cross-tab-sync'

export type { TokenRefreshConfig }

const defaultConfig: TokenRefreshConfig = {
  refreshMethod: 'auth.refresh',
  refreshBeforeExpirySec: 60,
  broadcastChannelName: 'typeferry-token-sync',
}

/** Delay before retrying a failed refresh on transient (network) errors. */
const RETRY_DELAY_MS = 5_000

/**
 * Per-client refresh state to prevent SSR state leaks.
 * Uses WeakMap so state is garbage collected when client is destroyed.
 */
interface RefreshState {
  isRefreshing: boolean
  failedQueue: Array<{
    resolve: (token: string) => void
    reject: (error: Error) => void
  }>
}

const refreshStateMap = new WeakMap<Client, RefreshState>()

function getRefreshState(client: Client): RefreshState {
  let state = refreshStateMap.get(client)
  if (!state) {
    state = { isRefreshing: false, failedQueue: [] }
    refreshStateMap.set(client, state)
  }
  return state
}

function processQueue(
  state: RefreshState,
  error: Error | null,
  token: string | null,
): void {
  state.failedQueue.forEach(({ resolve, reject }) => {
    if (error) {
      reject(error)
    } else {
      resolve(token!)
    }
  })
  state.failedQueue = []
}

/**
 * Check if error is a terminal auth failure vs a transient network error.
 * Terminal failures clear the context and redirect to login. Transient
 * failures schedule a retry.
 */
function isAuthFailureError(
  err: Error & { status?: number; code?: string },
): boolean {
  if (err.status === 401 || err.status === 403) return true
  if (err.code === 'AUTHENTICATION_FAILED') return true

  const msg = err.message
  if (msg === 'Token refresh failed') return true
  if (msg.includes('missingRefreshToken')) return true
  if (msg.includes('invalidOrExpiredRefreshToken')) return true

  return false
}

/**
 * Refresh the access token using the configured refresh method.
 * Handles concurrent refresh requests by queueing them per-client.
 *
 * @param client - TypeFerry client instance
 * @param config - Optional configuration overrides
 * @returns New access token, or null if refresh failed
 */
export async function refreshAccessToken(
  client: Client,
  config: Partial<TokenRefreshConfig> = {},
): Promise<string | null> {
  const opts = { ...defaultConfig, ...config }
  const state = getRefreshState(client)

  // Queue concurrent requests for the same client
  if (state.isRefreshing) {
    return new Promise((resolve, reject) => {
      state.failedQueue.push({ resolve, reject })
    })
  }

  state.isRefreshing = true
  const context = client.context

  try {
    /**
     * Refresh token is sent exclusively via the HttpOnly cookie
     * (credentials: 'include' on fetch). No body param needed — the
     * server reads from the cookie header directly.
     */
    client.logger.auth(LogLevel.INFO, 'Attempting token refresh', {
      method: opts.refreshMethod,
      hasToken: !!client.context.token,
      exp: client.context.exp,
    })

    const result = await client.call<
      Record<string, never>,
      { accessToken: string; exp: number; iat: number }
    >(
      opts.refreshMethod,
      {},
      {
        ignoreInit: true,
        http: true,
      },
    )

    if (client.context !== context) {
      throw new Error('TypeFerry: Session changed during token refresh')
    }

    if (!result) {
      throw new Error('Token refresh failed')
    }

    client.logger.auth(LogLevel.INFO, 'Token refresh succeeded', {
      newExp: result.exp,
    })

    client.updateContext({
      token: result.accessToken,
      exp: result.exp,
      iat: result.iat,
      _tokenReceivedAt: Date.now(),
    })

    if (opts.broadcastChannelName) {
      broadcastTokenRefresh(
        opts.broadcastChannelName,
        result.accessToken,
        result.exp,
        result.iat,
      )
    }

    processQueue(state, null, result.accessToken)
    return result.accessToken
  } catch (error) {
    const err = error as Error & { status?: number; code?: string }
    const isAuthFailure = isAuthFailureError(err)

    client.logger.auth(
      isAuthFailure ? LogLevel.WARN : LogLevel.ERROR,
      'Token refresh failed',
      {
        isAuthFailure,
        status: err.status,
        code: err.code,
        hasToken: !!client.context.token,
      },
      err,
    )

    if (isAuthFailure && client.context === context) client.clearContext()

    processQueue(state, err, null)
    throw error
  } finally {
    state.isRefreshing = false
  }
}

/**
 * Set up automatic token refresh before expiry.
 * Returns a cleanup function to stop the refresh timer.
 *
 * @param client - TypeFerry client instance
 * @param config - Optional configuration overrides
 * @returns Cleanup function
 */
export function setupTokenRefreshOnExpiry(
  client: Client,
  config: Partial<TokenRefreshConfig> = {},
): () => void {
  const opts = { ...defaultConfig, ...config }
  let refreshTimeout: ReturnType<typeof setTimeout> | null = null

  const cleanupCrossTab = opts.broadcastChannelName
    ? setupCrossTabSync(client, { channelName: opts.broadcastChannelName })
    : () => {}

  const scheduleRefresh = (): void => {
    if (refreshTimeout) {
      clearTimeout(refreshTimeout)
      refreshTimeout = null
    }

    const { exp, iat, _tokenReceivedAt } = client.context
    if (!exp) return

    /**
     * Clock-skew-safe scheduling: when server-issued `iat` and local
     * `_tokenReceivedAt` are available, compute remaining lifetime using
     * only server-side TTL and client-side elapsed time — both immune
     * to absolute clock differences between client and server.
     *
     * Falls back to the classic `exp - now` calculation for tokens
     * issued before the iat migration.
     */
    let timeUntilRefresh: number

    if (iat && _tokenReceivedAt) {
      const tokenTtlMs = (exp - iat) * 1000
      const elapsedMs = Date.now() - _tokenReceivedAt
      timeUntilRefresh =
        tokenTtlMs - elapsedMs - opts.refreshBeforeExpirySec * 1000
    } else {
      const now = Math.floor(Date.now() / 1000)
      timeUntilRefresh = (exp - now - opts.refreshBeforeExpirySec) * 1000
    }

    /**
     * Attempt a refresh and retry once on transient (non-auth) failures.
     *
     * Auth failures (401/403) are terminal — the session is invalid and
     * clearContext already ran inside refreshAccessToken. Network errors
     * are transient, so we schedule a single retry after a short delay
     * to avoid the token expiring silently.
     */
    const attemptRefresh = (meta: Record<string, unknown>): void => {
      refreshAccessToken(client, opts).catch(error => {
        const err = error as Error & { status?: number; code?: string }
        client.logger.auth(
          LogLevel.ERROR,
          'Scheduled token refresh failed',
          meta,
          err,
        )

        if (!isAuthFailureError(err)) {
          refreshTimeout = setTimeout(scheduleRefresh, RETRY_DELAY_MS)
        }
      })
    }

    // If already expired or about to expire, refresh immediately
    if (timeUntilRefresh <= 0) {
      /**
       * If a refresh is already in progress (e.g. this handler was called
       * from the CONTEXT_CHANGED event emitted inside refreshAccessToken),
       * defer rescheduling instead of queueing a redundant refresh call.
       * The queued path would resolve but never reschedule, leaving the
       * next automatic refresh unscheduled.
       */
      const state = getRefreshState(client)
      if (state.isRefreshing) {
        refreshTimeout = setTimeout(scheduleRefresh, 1000)
        return
      }

      attemptRefresh({ immediate: true })
      return
    }

    refreshTimeout = setTimeout(() => {
      attemptRefresh({ scheduledDelayMs: timeUntilRefresh })
    }, timeUntilRefresh)
  }

  // Schedule initial refresh
  scheduleRefresh()

  // Reschedule when context changes (e.g., after refresh)
  const handleContextChange = () => scheduleRefresh()
  client.on('context:changed', handleContextChange)

  // Cleanup function
  return () => {
    if (refreshTimeout) {
      clearTimeout(refreshTimeout)
    }
    client.off('context:changed', handleContextChange)
    cleanupCrossTab()
  }
}
