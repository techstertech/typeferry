import { EJSON } from '../ejson'

export enum PayloadType {
  METHOD = 'method',
  RESULT = 'result',
  EVENT = 'event',
  ERROR = 'error',
  AUTH_RESULT = 'auth:result',
}

function randomUuidV4(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export namespace Presentation {
  export const uuid = (): string => randomUuidV4()

  export type Payload = {
    type: PayloadType
    [key: string]: unknown
  }

  export function decode<T = Payload>(payload: string | { data: string }): T {
    // The transport method's type parameter is the caller's decoded envelope
    // contract; runtime validation remains the owning transport's concern.
    return EJSON.parse(
      typeof payload === 'string'
        ? payload
        : payload.data,
    ) as T
  }

  export function encode<T = Payload>(payload: T): string {
    return EJSON.stringify(payload)
  }
}
