import { EJSON } from '../ejson'
import { throwIfAborted } from '../utils/abort'
import {
  CLIENT_ID_HEADER_KEY,
  ClientEvents,
  PayloadType,
  Presentation,
  TOKEN_HEADER_KEY,
} from '../utils'
import type { Client } from './client'
import { LogLevel } from './logger'
import { resolveBackendOrigins } from './backend-origin'

type Resolve<T> = (value: T | PromiseLike<T>) => void
type Reject = (reason?: unknown) => void

/**
 * Preserves an unsuccessful HTTP response status across the RPC boundary.
 */
export class ClientHttpResponseError extends Error {
  readonly status: number

  /**
   * Creates a transport error without discarding the response status.
   */
  constructor(status: number, statusText: string, responseBody: string) {
    super(`${status} ${statusText}: ${JSON.stringify(responseBody)}`)
    this.name = 'ClientHttpResponseError'
    this.status = status
  }
}

/**
 * Owns cookie-bearing HTTP RPC requests for one TypeFerry client.
 */
export class ClientHttp {
  client: Client
  protocol: string
  host: string
  uri: string

  constructor(client: Client) {
    this.client = client
    this.protocol = this.client.options.secure ? `https://` : `http://`

    /**
     * HTTP port for cookie-bearing requests (login, refresh).
     *
     * When `httpPort` is explicitly present in options (even if undefined),
     * use the page's own origin so cookies stay same-origin. In dev this
         * routes through Vite's proxy which forwards to the TypeFerry server.
     */
    const hasHttpPort = 'httpPort' in this.client.options
    if (this.client.options.backend) {
      this.host = resolveBackendOrigins(this.client.options.backend).httpOrigin
      this.protocol = new URL(this.host).protocol + '//'
    } else if (hasHttpPort && !this.client.options.httpPort) {
      // Use page origin (same-origin cookies via Vite proxy in dev)
      this.host =
        typeof window !== 'undefined'
          ? window.location.origin
          : `${this.protocol}${this.client.options.host}`
    } else {
      const port = this.client.options.httpPort ?? this.client.options.port
      this.host = port
        ? `${this.protocol}${this.client.options.host}:${port}`
        : `${this.protocol}${this.client.options.host}`
    }

    this.uri = `${this.host}/__h`
  }

  /** Strip sensitive keys (refresh tokens) from context before sending over the wire. */
  private stripSensitiveKeys(
    context: Record<string, unknown>,
  ): Record<string, unknown> {
    const { refreshToken: _, ...safe } = context
    return safe
  }

  async request<TResult = unknown>(
    payload: Record<string, unknown>,
    resolve: Resolve<TResult> | null,
    reject: Reject,
    signal?: AbortSignal,
  ) {
    try {
      throwIfAborted(signal)
      const httpFetch = this.client.options.httpFetch ?? fetch
      const data = await httpFetch(this.uri, {
        method: 'POST',
        ...(signal ? { signal } : {}),
        headers: {
          [CLIENT_ID_HEADER_KEY]: this.client.uuid,
          Accept: 'text/plain, */*',
          'Content-Type': 'text/plain',
          ...(this.client.context.token
            ? { [TOKEN_HEADER_KEY]: this.client.context.token }
            : {}),
        },
        credentials: 'include',
        body: EJSON.stringify({
          context: this.stripSensitiveKeys(this.client.context),
          payload,
        }),
      })

      throwIfAborted(signal)

      if (data.status !== 200) {
        const errorText = await data.text()
        const error = new ClientHttpResponseError(
          data.status,
          data.statusText,
          errorText,
        )

        this.client.logger.method(
          LogLevel.ERROR,
          'HTTP request failed',
          {
            status: data.status,
            statusText: data.statusText,
            method: payload.method,
            uri: this.uri,
          },
          error,
        )

        return reject(error)
      }

      if (payload.void) {
        resolve?.(undefined as TResult)
        return
      }
      if (!resolve) return

      const response = await data.text()
      throwIfAborted(signal)

      const decoded = Presentation.decode<
        Presentation.Payload & { result: TResult }
      >(response)

      this.client.emit(ClientEvents.INBOUND_MESSAGE, decoded)

      if (decoded.type === PayloadType.ERROR) return reject(decoded)

      resolve(decoded.result)
    } catch (error) {
      this.client.logger.method(
        LogLevel.ERROR,
        'HTTP request error',
        {
          method: payload.method,
          uri: this.uri,
        },
        error as Error,
      )

      return reject(error)
    }
  }
}
