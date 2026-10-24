/**
 * @Cached class/method decorator — enables anonymous result caching.
 * @NoCache method decorator — disables caching for a specific method.
 *
 * @module typeferry/server/decorators/cached
 */

import {
  getOrCreateMethodMeta,
  getOrCreateNamespaceMeta,
  queueMethodUpdate,
} from './metadata'

const DEFAULT_MAX_AGE = 60_000

/**
 * Enables anonymous result caching at the class or method level.
 * Authenticated calls always execute the handler, including inline authorization.
 *
 * When applied to a class, all methods inherit the cache setting.
 * When applied to a method, it overrides/complements class-level settings.
 *
 * @param maxAge - Cache TTL in milliseconds (default: 60000)
 *
 * @example
 * ```ts
 * @Namespace('analytics')
 * @Cached(30_000)
 * class AnalyticsMethods { ... }
 * ```
 */
export function Cached(maxAge?: number) {
  return function <
    T extends
      | (abstract new (...args: unknown[]) => unknown)
      | ((...args: never[]) => unknown),
  >(
    target: T,
    context: ClassDecoratorContext | ClassMethodDecoratorContext,
  ): T {
    if (context.kind === 'class') {
      const meta = getOrCreateNamespaceMeta(
        target as abstract new (...args: unknown[]) => unknown,
      )
      meta.cached = true
      meta.maxAge = maxAge ?? DEFAULT_MAX_AGE
      return target
    }

    const key = String(context.name)

    queueMethodUpdate(Class => {
      const meta = getOrCreateMethodMeta(Class, key)
      meta.cached = true
      meta.maxAge = maxAge ?? DEFAULT_MAX_AGE
    })

    return target
  }
}

/**
 * Disables caching for a specific method when the class has @Cached().
 *
 * @example
 * ```ts
 * @Namespace('analytics')
 * @Cached(30_000)
 * class AnalyticsMethods {
 *   @Method()
 *   @NoCache()
 *   async realtime(client: ClientNode, params) { ... }
 * }
 * ```
 */
export function NoCache() {
  return function <T extends (...args: never[]) => unknown>(
    target: T,
    context: ClassMethodDecoratorContext,
  ): T {
    const key = String(context.name)

    queueMethodUpdate(Class => {
      const meta = getOrCreateMethodMeta(Class, key)
      meta.cached = false
    })

    return target
  }
}
