import type { z } from 'zod'

export type AnyFunction = (...args: any[]) => any | Promise<any>

export type ServerMethodDefinition<
  Schema extends z.ZodTypeAny | z.ZodUndefined = z.ZodUndefined,
  Result = any,
> = (
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- void union allows parameter omission
  params: Schema extends z.ZodUndefined ? CallOptions | void : z.input<Schema>,
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- void union allows parameter omission
  options: Schema extends z.ZodUndefined ? void : CallOptions | void,
) => Promise<Result>

/** Allows flat method definitions, nested namespace objects, or deeply nested. */
export type ServerMethods = {
  [key: string]: AnyMethodLike | ServerMethodNode
}

/** Any callable that returns a promise — loose constraint for method shapes. */
type AnyMethodLike = (...args: never[]) => Promise<unknown>

/** Recursive namespace node: methods or further nested namespaces. */
type ServerMethodNode = {
  [key: string]: AnyMethodLike | ServerMethodNode
}

export type MethodParams<T = any> = T

export type CallOptions = {
  /**
   * Cancels local waiting and delivery; a sent operation may still run remotely.
   */
  signal?: AbortSignal
  http?: boolean
  timeout?: number
  httpFallback?: boolean
  ignoreInit?: boolean
  maxRetries?: number
  delayBetweenRetriesMs?: number
}
