/**
 * Shared WebSocket transport logic used by both the ws-based and
 * Shared WebSocket protocol helpers, kept separate from listener lifecycle.
 */
import {
  Errors,
  MessageType,
  Presentation,
  PublicError,
  SchemaValidationError,
  ServerEvents,
} from '../../utils'
import type { ClientNode } from '../client-node'
import type { ClientNodeContext } from '../client-node'
import { redactMethodTelemetry, type Method } from '../method'
import type { Server } from '../server'
import { SocketState } from '../types'

export const AUTH_TIMEOUT_MS = 5000
export const MAX_UUID_LENGTH = 64
export const MAX_META_SIZE = 10000
export const PING_INTERVAL_MS = 25000

/** Pre-encoded ping payload — avoids EJSON.stringify on every tick. */
export const PING_PAYLOAD = Presentation.encode({ t: MessageType.PING })

/**
 * Framework-neutral metadata exposed to an application handshake authenticator.
 */
export interface WebSocketHandshake {
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string>>
}

/**
 * Optional application-owned authentication for an admitted WebSocket.
 */
export type WebSocketHandshakeAuthenticator = (
  node: ClientNode,
  handshake: WebSocketHandshake,
) => ClientNodeContext | false | Promise<ClientNodeContext | false>

// ---------------------------------------------------------------------------
// RPC handling
// ---------------------------------------------------------------------------

/** Handles an RPC call and sends the response correlated by `id`. */
export async function handleRpc(
  server: Server,
  node: ClientNode,
  id: string,
  method: string,
  params?: unknown
): Promise<void> {
  if (node.limiter && !node.limiter.tryRemoveTokens(1)) {
    return sendResponse(node, id, undefined, Errors.RATE_LIMIT_EXCEEDED)
  }

  const methodInstance = server.methods.get(method)

  if (!methodInstance) {
    return sendResponse(node, id, undefined, Errors.METHOD_NOT_FOUND)
  }

  if (methodInstance.isProtected && !node.authenticated) {
    return sendResponse(node, id, undefined, Errors.METHOD_FORBIDDEN)
  }

  try {
    const result = await methodInstance.exec(params, node)
    sendResponse(node, id, result)
  } catch (error) {
    handleRpcError(server, node, methodInstance, error, id, method, params)
  }
}

/** Handles fire-and-forget RPC calls (no response sent). */
export async function handleRpcVoid(
  server: Server,
  node: ClientNode,
  method: string,
  params?: unknown
): Promise<void> {
  if (node.limiter && !node.limiter.tryRemoveTokens(1)) {
    console.warn('[TypeFerry] Rate limit exceeded for void call:', method)
    return
  }

  const methodInstance = server.methods.get(method)

  if (!methodInstance) {
    console.warn('[TypeFerry] Method not found for void call:', method)
    return
  }

  if (methodInstance.isProtected && !node.authenticated) {
    console.warn('[TypeFerry] Method forbidden for void call:', method)
    return
  }

  try {
    await methodInstance.exec(params, node)
  } catch (error) {
    if (methodInstance.isSensitive) {
      console.error(`[TypeFerry] Sensitive void method "${method}" failed`)
    } else {
      console.error('[TypeFerry] Void method execution error:', error)
    }

    server.emit(ServerEvents.METHOD_ERROR, {
      error: redactMethodTelemetry(methodInstance, error),
      method,
      params: redactMethodTelemetry(methodInstance, params),
      userId: node.userId,
      userEmail: node.context?.user?.email,
      remoteAddress: node.remoteAddress,
      userAgent: node.userAgent,
    })
  }
}

/** Sends a correlated RPC response to the client. */
export function sendResponse(
  node: ClientNode,
  id: string,
  result?: unknown,
  error?: string,
  errors?: unknown
): void {
  if (!node.socket || node.socket.readyState !== SocketState.OPEN) return

  const payload: Record<string, unknown> = {
    t: MessageType.RPC_RESPONSE,
    id,
  }

  if (error) {
    payload.error = error
    if (errors) payload.errors = errors
  } else {
    payload.result = result
  }

  node.socket.send(Presentation.encode(payload))
}

function handleRpcError(
  server: Server,
  node: ClientNode,
  methodInstance: Method<any, any>,
  error: unknown,
  id: string,
  method: string,
  params: unknown
): void {
  if (error instanceof PublicError) {
    return sendResponse(node, id, undefined, error.message)
  }

  if (methodInstance.isSensitive) {
    console.error(`[TypeFerry] Sensitive method "${method}" failed`)
  } else {
    console.error(error)
  }

  server.emit(ServerEvents.METHOD_ERROR, {
    error: redactMethodTelemetry(methodInstance, error),
    method,
    params: redactMethodTelemetry(methodInstance, params),
    userId: node.userId,
    userEmail: node.context?.user?.email,
    remoteAddress: node.remoteAddress,
    userAgent: node.userAgent,
  })

  if (error instanceof SchemaValidationError) {
    return sendResponse(node, id, undefined, error.message, error.errors)
  }

  sendResponse(node, id, undefined, Errors.INTERNAL_ERROR)
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Authenticates a node after connection. Guards against the node
 * disconnecting during the async auth call.
 */
export async function authenticateNode(
  server: Server,
  node: ClientNode,
  token: string | undefined,
  handshakeAuthenticator?: WebSocketHandshakeAuthenticator,
  handshake?: WebSocketHandshake,
): Promise<void> {
  if (!handshakeAuthenticator && (!server.isAuthEnabled || !token)) {
    node.emitAuthResult(false)
    return
  }

  let authTimeout: ReturnType<typeof setTimeout> | undefined

  try {
    const auth = server.auth
    const authPromise: Promise<ClientNodeContext | false | null | undefined> = handshakeAuthenticator
      ? Promise.resolve(
          handshakeAuthenticator(
            node,
            handshake ?? { path: '', headers: {}, query: {} },
          ),
        )
      : auth
        ? Promise.resolve(auth.call(node, token === undefined ? {} : { token }))
        : Promise.resolve<ClientNodeContext | false>(false)
    const timeoutPromise = new Promise<never>((_, reject) => {
      authTimeout = setTimeout(() => reject(new Error('Auth timeout')), AUTH_TIMEOUT_MS)
    })

    const result = await Promise.race([authPromise, timeoutPromise])

    if (!node.socket || node.socket.readyState !== SocketState.OPEN) return

    if (result) {
      node.authenticated = true
      node.setContext(result)
      server.emit(ServerEvents.AUTHENTICATION, node)
    }

    node.emitAuthResult(node.authenticated)
  } catch (error) {
    // Context installation can reject an identity after the callback succeeds.
    // Never report failure while leaving the node authorized for RPC dispatch.
    if (node.userId) server.removeClientFromUserIndex(node)
    node.userId = null
    node.user = null
    node.authenticated = false
    node.setContext(null)
    console.error('[TypeFerry] Auth error:', error)
    if (node.socket?.readyState === SocketState.OPEN) {
      node.emitAuthResult(false)
    }
  } finally {
    if (authTimeout !== undefined) clearTimeout(authTimeout)
  }
}

// ---------------------------------------------------------------------------
// Connection parameter validation
// ---------------------------------------------------------------------------

/**
 * Preserves valid client identities and replaces invalid identities atomically.
 * Removing characters could alias two distinct caller-supplied identities.
 */
export function validateUuid(uuid: unknown): string {
  if (
    typeof uuid !== 'string' ||
    uuid.length === 0 ||
    uuid.length > MAX_UUID_LENGTH ||
    !/^[a-zA-Z0-9-]+$/.test(uuid)
  ) {
    return (
      crypto.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
  }
  return uuid
}

function isMetaObject(meta: unknown): meta is Record<string, unknown> {
  return meta !== null && typeof meta === 'object' && !Array.isArray(meta)
}

/**
 * Bounds metadata supplied as an object, where no raw JSON input is available.
 */
export function validateMeta(meta: unknown): Record<string, unknown> {
  if (!isMetaObject(meta)) return {}
  try {
    if (Buffer.byteLength(JSON.stringify(meta), 'utf8') > MAX_META_SIZE) {
      console.warn('[TypeFerry] Meta object too large, ignoring')
      return {}
    }
  } catch {
    return {}
  }
  return meta
}

/** Parses meta from a query string value (JSON-encoded in the URL). */
export function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_META_SIZE) return {}
  try {
    const meta: unknown = JSON.parse(raw)

    // The protocol bounds the original bytes, not JSON.stringify's potentially
    // longer numeric spellings after decoding a valid object.
    return isMetaObject(meta) ? meta : {}
  } catch {
    return {}
  }
}
