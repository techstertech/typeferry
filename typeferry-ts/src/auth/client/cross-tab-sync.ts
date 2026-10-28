import type { Client } from '../../client'
import type { TypeFerryContext } from '../../client/context-manager'
import type { CrossTabSyncConfig } from '../types'

const TOKEN_REFRESHED = 'TOKEN_REFRESHED'

interface RefreshedToken {
  readonly token: string
  readonly exp: number
  readonly iat?: number
  readonly receivedAt?: number
}

function readRefreshedToken(data: unknown): RefreshedToken | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  if (!('type' in data) || data.type !== TOKEN_REFRESHED) return undefined
  if (!('token' in data) || typeof data.token !== 'string' || !data.token)
    return undefined
  if (!('exp' in data) || typeof data.exp !== 'number' || !Number.isFinite(data.exp))
    return undefined

  const iat =
    'iat' in data && typeof data.iat === 'number' && Number.isFinite(data.iat)
      ? data.iat
      : undefined
  const receivedAt =
    'receivedAt' in data && typeof data.receivedAt === 'number' && Number.isFinite(data.receivedAt)
      ? data.receivedAt
      : undefined

  return {
    token: data.token,
    exp: data.exp,
    ...(iat === undefined ? {} : { iat }),
    ...(receivedAt === undefined ? {} : { receivedAt }),
  }
}

/**
 * The tabs share a local clock. A queued message must retain the sender's age.
 * Legacy senders reuse the established server/local offset when available;
 * without that evidence, issuance time is safer than granting a new lifetime.
 */
function getReceiptTime(
  token: RefreshedToken,
  context: TypeFerryContext,
): number | undefined {
  if (token.iat === undefined) return undefined
  if (token.receivedAt !== undefined) return token.receivedAt
  if (context.iat !== undefined && context._tokenReceivedAt !== undefined) {
    return context._tokenReceivedAt + (token.iat - context.iat) * 1000
  }

  return token.iat * 1000
}

function isNewerToken(
  token: RefreshedToken,
  receivedAt: number | undefined,
  context: TypeFerryContext,
): boolean {
  if (!context.token || token.token === context.token) return false

  if (token.iat !== undefined && context.iat !== undefined) {
    if (token.iat !== context.iat) return token.iat > context.iat
    return receivedAt !== undefined &&
      context._tokenReceivedAt !== undefined &&
      receivedAt > context._tokenReceivedAt
  }

  return context.exp === undefined || token.exp > context.exp
}

/**
 * Set up cross-tab token synchronization using BroadcastChannel.
 * When one tab refreshes the token, all other tabs receive the update.
 *
 * @param client - TypeFerry client instance
 * @param config - Sync configuration
 * @returns Cleanup function
 */
export function setupCrossTabSync(
  client: Client,
  config: CrossTabSyncConfig,
): () => void {
  // BroadcastChannel not available in SSR or older browsers
  if (typeof BroadcastChannel === 'undefined') {
    return () => {}
  }

  const channel = new BroadcastChannel(config.channelName)

  const handleMessage = (event: MessageEvent<unknown>): void => {
    const token = readRefreshedToken(event.data)
    if (!token) return

    const receivedAt = getReceiptTime(token, client.context)
    if (!isNewerToken(token, receivedAt, client.context)) return

    if (token.iat !== undefined && receivedAt !== undefined) {
      client.updateContext({
        token: token.token,
        exp: token.exp,
        iat: token.iat,
        _tokenReceivedAt: receivedAt,
      })
    } else {
      const context = { ...client.context, token: token.token, exp: token.exp }

      delete context.iat
      delete context._tokenReceivedAt

      client.setContext(context)
    }

    if (config.tokenRefreshedEvent) {
      client.emit(config.tokenRefreshedEvent, {
        token: token.token,
        exp: token.exp,
      })
    }
  }

  channel.addEventListener('message', handleMessage)

  return () => {
    channel.removeEventListener('message', handleMessage)
    channel.close()
  }
}

/**
 * Broadcast a token refresh to all other tabs.
 * Call this after successfully refreshing the token.
 *
 * @param channelName - BroadcastChannel name
 * @param token - New access token
 * @param exp - Token expiration (Unix timestamp in seconds)
 * @param iat - Token issued-at time (Unix timestamp in seconds) for clock-skew compensation
 */
export function broadcastTokenRefresh(
  channelName: string,
  token: string,
  exp: number,
  iat?: number,
): void {
  if (typeof BroadcastChannel === 'undefined') {
    return
  }

  const channel = new BroadcastChannel(channelName)
  channel.postMessage({
    type: TOKEN_REFRESHED,
    token,
    exp,
    iat,
    receivedAt: Date.now(),
  })
  channel.close()
}
