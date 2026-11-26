import perf_hooks from 'perf_hooks'
import type { z } from 'zod'

import { isEmpty } from '../utils/lodash'

import { EJSON } from '../ejson'
import type { AnyFunction, MethodParams as MethodParameters } from '../utils'
import {
  Errors,
  intercept,
  Presentation,
  SchemaValidationError,
  ServerEvents,
} from '../utils'
import { TypeFerryAsyncLocalStorage } from './typeferry-async-local-storage'
import type { ClientNode } from './client-node'
import type { Server } from './server'

/**
 * Function signature for TypeFerry RPC methods.
 *
 * @typeParam T - The type of the method parameters
 * @typeParam R - The return type of the method
 */
export type MethodFunction<T = unknown, R = unknown> = (
  this: ClientNode,
  parameters: MethodParameters<T>
) => Promise<R> | R

/**
 * Configuration options for TypeFerry RPC methods.
 *
 * @typeParam Schema - A Zod schema type for input validation
 *
 * @example
 * ```ts
 * TypeFerry.addMethod(
 *   'user.create',
 *   async ({ email, name }) => { ... },
 *   {
 *     protected: true,
 *     schema: z.object({
 *       email: z.string().email(),
 *       name: z.string().min(1),
 *     }),
 *   }
 * )
 * ```
 */
export interface MethodOptions<Schema extends z.ZodType = z.ZodType> {
  /**
   * Cache anonymous results only. Authenticated calls always run the handler
   * so cached data cannot cross identities or skip inline authorization.
   */
  cache?: boolean
  /** Cache TTL in milliseconds (default: 60000) */
  maxAge?: number
  /** Require authentication to call this method */
  protected?: boolean
  /** Middleware functions to run before the method handler */
  middleware?: AnyFunction[]
  /** Zod schema for input validation and type inference */
  schema?: Schema
  /**
   * Redact parameters, results, and errors from method telemetry.
   *
   * Use this for RPCs whose payloads contain credentials, authorization
   * scopes, private query arguments, or other data that must not reach
   * METHOD_EXECUTION/METHOD_ERROR observers.
   */
  sensitive?: boolean
}

/** Stable marker used when sensitive method telemetry is intentionally hidden. */
export const REDACTED_METHOD_TELEMETRY = '[REDACTED]' as const

/** Returns a method telemetry field with the configured sensitivity applied. */
export function redactMethodTelemetry(
  method: Pick<Method<z.ZodType, unknown>, 'isSensitive'>,
  value: unknown
): unknown {
  return method.isSensitive ? REDACTED_METHOD_TELEMETRY : value
}

interface MemoizeOptions {
  maxAge?: number
  maxEntries?: number
}

const DEFAULT_MAX_CACHE_ENTRIES = 1000

function isThenable<TResult>(
  value: Promise<TResult> | TResult,
): value is Promise<TResult> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as PromiseLike<TResult>).then === 'function'
  )
}

function storeMemoizedEntry<TResult>(
  cache: Map<string | undefined, { value: Promise<TResult> | TResult; timestamp: number }>,
  key: string | undefined,
  value: Promise<TResult> | TResult,
  timestamp: number,
  maxAge: number,
  maxEntries: number,
): void {
  if (cache.has(key)) cache.delete(key)

  if (cache.size >= maxEntries) {
    for (const [entryKey, entry] of cache) {
      if (timestamp - entry.timestamp >= maxAge) cache.delete(entryKey)
    }
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
  }

  cache.set(key, { value, timestamp })
}

function customMemoize<TParameters, TResult>(
  fn: MethodFunction<TParameters, TResult>,
  options: MemoizeOptions = {}
): MethodFunction<TParameters, TResult> {
  const cache = new Map<
    string | undefined,
    { value: Promise<TResult> | TResult; timestamp: number }
  >()
  const { maxAge = 60000, maxEntries = DEFAULT_MAX_CACHE_ENTRIES } = options

  return function (this: ClientNode, parameters): Promise<TResult> | TResult {
    // Inline authorization must run even when the same caller repeats a request,
    // and server-origin calls must never populate the shared anonymous cache.
    if (this.authenticated || this.isServer) return fn.call(this, parameters)

    const key = EJSON.stringify(parameters) // Normalize method params
    const now = Date.now()
    const cached = cache.get(key)

    if (cached && now - cached.timestamp < maxAge) {
      return cached.value
    }
    if (cached) cache.delete(key)

    const result = fn.call(this, parameters)

    if (!isThenable(result)) {
      if (!this.authenticated && !this.isServer) {
        storeMemoizedEntry(cache, key, result, Date.now(), maxAge, maxEntries)
      }
      return result
    }

    // Do not poison the shared anonymous cache pre-settlement or when the
    // execution elevates authentication / server privilege before resolving.
    return Promise.resolve(result).then(resolved => {
      if (!this.authenticated && !this.isServer) {
        storeMemoizedEntry(
          cache,
          key,
          Promise.resolve(resolved) as Promise<TResult>,
          Date.now(),
          maxAge,
          maxEntries,
        )
      }
      return resolved
    })
  }
}

/**
 * Represents a registered TypeFerry RPC method with validation and middleware support.
 *
 * Methods are the core RPC primitives in TypeFerry. Each method can have:
 * - Input validation via Zod schemas
 * - Middleware chain for authentication/authorization
 * - Result caching with configurable TTL
 * - Execution time tracking
 *
 * @typeParam Schema - The Zod schema type for input validation
 * @typeParam Result - The return type of the method
 */
export class Method<Schema extends z.ZodType, Result> {
  uuid: string
  fn: MethodFunction
  isProtected: boolean
  isSensitive: boolean
  middleware: AnyFunction[]
  schema: z.ZodSchema | null = null
  name: string
  server: Server

  constructor(
    server: Server,
    name: string,
    fn: MethodFunction<z.input<Schema> | any, Result>,
    opts: MethodOptions<Schema>
  ) {
    const { cache, maxAge = 60000, schema } = opts ?? {}

    this.server = server
    this.name = name
    this.uuid = Presentation.uuid()
    this.isProtected = opts.protected ?? false
    this.isSensitive = opts?.sensitive ?? false
    this.middleware = opts.middleware ?? []
    this.fn = cache ? customMemoize(fn, { maxAge }) : fn

    this.schema = schema ?? null
  }

  /**
   * Executes the middleware chain, passing params through each middleware.
   * Each middleware can transform or augment the params before passing to the next.
   */
  async runMiddleware(
    parameters: MethodParameters,
    node?: ClientNode
  ): Promise<MethodParameters> {
    if (isEmpty(this.middleware)) return parameters

    const wrapped = this.middleware.map((m) => intercept(m))

    let buffer = parameters

    for (const step of wrapped) {
      buffer = await step.call(node, buffer)
    }

    return buffer
  }

  /**
   * Executes the method with validation, middleware, and timing.
   *
   * Execution flow:
   * 1. Validate params against Zod schema (if provided)
   * 2. Run middleware chain
   * 3. Execute method handler
   * 4. Emit execution event with timing data
   *
   * @throws {SchemaValidationError} When params fail Zod validation
   */
  async exec(parameters: MethodParameters, node?: ClientNode): Promise<Result> {
    const start = perf_hooks.performance.now()

    let cleanParameters = parameters

    if (this.schema) {
      // Normalize undefined/null params to empty object for schema validation.
      // This allows methods with all-optional fields to be called without params.
      const parametersToValidate = parameters ?? {}
      const result = this.schema.safeParse(parametersToValidate)
      if (!result.success) {
        const errorMessages = result.error.issues.map(
          (issue) => `${issue.path.join('.')}: ${issue.message}`
        )
        console.error(
          `Schema validation failed for ${this.name}:`,
          errorMessages
        )
        throw new SchemaValidationError(
          `${Errors.INVALID_PARAMS}: ${errorMessages.join(', ')}`,
          errorMessages
        )
      }
      cleanParameters = result.data
    }

    if (!node) {
      throw new Error(`Method "${this.name}" requires a client execution context`)
    }

    const result: Result = await TypeFerryAsyncLocalStorage.run(
      { executionId: Presentation.uuid(), context: node.context },
      async () => {
        const middlewareResult = await this.runMiddleware(cleanParameters, node)

        return this.fn.call(node, middlewareResult) as Promise<Result> | Result
      }
    )

    const end = perf_hooks.performance.now()

    this.server.emit(ServerEvents.METHOD_EXECUTION, {
      method: this.name,
      time: end - start,
      params: redactMethodTelemetry(this, cleanParameters),
      result: redactMethodTelemetry(this, result),
    })

    return result
  }
}
