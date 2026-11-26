import { EJSON } from '../ejson'

export enum PayloadType {
  METHOD = 'method',
  RESULT = 'result',
  EVENT = 'event',
  ERROR = 'error',
  AUTH_RESULT = 'auth:result',
}

export namespace Presentation {
  export const uuid = (): string => globalThis.crypto.randomUUID()

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
