/**
 * Native replacements for lodash functions used by TypeFerry.
 *
 * These pure functions replace the lodash subset this package needs,
 * avoiding the dependency on lodash which has unpatched CVEs.
 */

/** Returns true if the value is a plain object (not an array, null, etc). */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (
    value == null ||
    typeof value !== 'object' ||
    value === Object.prototype
  ) {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Checks if a value is empty (null, undefined, empty string, empty array/object). */
export function isEmpty(value: unknown): boolean {
  if (value == null) return true
  if (typeof value === 'string' || Array.isArray(value))
    return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

/**
 * Deep-merges source into target. Mutates and returns target.
 * Skips `undefined` source values to match lodash's merge semantics.
 */
export function merge<T extends Record<string, unknown>>(
  target: T,
  ...sources: Record<string, unknown>[]
): T {
  for (const source of sources) {
    for (const [key, val] of Object.entries(source)) {
      if (
        val === undefined ||
        key === '__proto__' ||
        key === 'constructor' ||
        key === 'prototype'
      ) {
        continue
      }

      const targetVal = Object.hasOwn(target, key)
        ? (target as Record<string, unknown>)[key]
        : undefined
      if (isPlainObject(targetVal) && isPlainObject(val)) {
        ;(target as Record<string, unknown>)[key] = merge({ ...targetVal }, val)
      } else {
        ;(target as Record<string, unknown>)[key] = val
      }
    }
  }
  return target
}

/**
 * Creates a throttled version of a function.
 * @param fn - Function to throttle
 * @param wait - Milliseconds between invocations
 * @param options - leading/trailing control
 */
export function throttle<A extends unknown[], R>(
  fn: (...args: A) => R,
  wait: number,
  options: { leading?: boolean; trailing?: boolean } = {},
): ((...args: A) => void) & { cancel: () => void } {
  const { leading = true, trailing = true } = options
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastArgs: A | null = null
  let lastCallTime = 0

  const invoke = (args: A): void => {
    lastCallTime = Date.now()
    fn(...args)
  }

  const throttled = ((...args: A) => {
    const now = Date.now()
    const remaining = wait - (now - lastCallTime)

    if (remaining <= 0 || remaining > wait) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (leading) invoke(args)
      else {
        lastArgs = args
        if (trailing) {
          timer = setTimeout(() => {
            timer = null
            if (lastArgs) {
              invoke(lastArgs)
              lastArgs = null
            }
          }, wait)
        }
      }
    } else {
      lastArgs = args
      if (!timer && trailing) {
        timer = setTimeout(() => {
          timer = null
          if (lastArgs) {
            invoke(lastArgs)
            lastArgs = null
          }
        }, remaining)
      }
    }
  }) as ((...args: A) => void) & { cancel: () => void }

  throttled.cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    lastArgs = null
    lastCallTime = 0
  }

  return throttled
}

/** Generates an array of numbers from 0 to n-1 (or start to end). */
export function range(start: number, end?: number): number[] {
  if (end === undefined) {
    return Array.from({ length: start }, (_, i) => i)
  }
  return Array.from({ length: end - start }, (_, i) => start + i)
}

/** Returns a new object with the specified keys omitted. */
export function omit<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[],
): Omit<T, K> {
  const set = new Set<string>(keys as string[])
  return Object.fromEntries(
    Object.entries(obj).filter(([k]) => !set.has(k)),
  ) as Omit<T, K>
}

/** Returns a new object with only the specified keys. */
export function pick<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[],
): Pick<T, K> {
  return Object.fromEntries(
    keys.filter(k => k in obj).map(k => [k, obj[k]]),
  ) as Pick<T, K>
}
