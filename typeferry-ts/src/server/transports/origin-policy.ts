/**
 * Keeps HTTP admission and WebSocket upgrades on the same origin policy.
 * An omitted allowlist is unrestricted; an explicit empty list fails closed.
 */
export function createOriginChecker(
  origins: readonly string[] | undefined,
  allowOriginless = false,
): (origin: string | undefined) => boolean {
  if (origins === undefined) return () => true

  const allowedOrigins = new Set(origins)

  return (origin) =>
    origin === undefined
      ? allowOriginless
      : origin.length > 0 && allowedOrigins.has(origin)
}
