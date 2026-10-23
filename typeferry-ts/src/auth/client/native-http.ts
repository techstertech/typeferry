import type { HttpFetch } from '../../client/backend-origin'
import { throwIfAborted } from '../../utils/abort'

/**
 * Text-only native transport. Its implementation must pin the backend origin,
 * persist cookies privately, reject off-origin redirects and hide Set-Cookie.
 */
export interface NativeHttpBridge {
  request(options: { url: string; method: string; headers: Record<string, string>; body?: string }): Promise<{
    status: number
    statusText: string
    headers: Record<string, string>
    body: string
  }>
}

/**
 * Adapts native private-cookie HTTP to ClientOptions.httpFetch. This boundary is
 * for RPC and auth JSON, not binary uploads/downloads. Cancellation is checked
 * before and after the native operation; it does not undo server-side effects.
 */
export function createNativeHttpFetch(bridge: NativeHttpBridge): HttpFetch {
  return async (url, options = {}) => {
    throwIfAborted(options.signal)

    if (options.body != null && typeof options.body !== 'string') {
      throw new Error('Native HTTP adapter supports text request bodies only')
    }

    const headers = Object.fromEntries(new Headers(options.headers).entries())
    const result = await bridge.request({ url, method: options.method ?? 'GET', headers, ...(typeof options.body === 'string' ? { body: options.body } : {}) })

    throwIfAborted(options.signal)

    const body = [204, 205, 304].includes(result.status) ? null : result.body

    return new Response(body, { status: result.status, statusText: result.statusText, headers: result.headers })
  }
}
