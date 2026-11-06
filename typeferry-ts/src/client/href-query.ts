/**
 * Serializes Client.href parameters with its established query-string defaults.
 * Array entries repeat the key, null entries omit the equals sign, and spaces
 * use percent encoding rather than the form encoding used by URLSearchParams.
 */
export function stringifyHrefQuery(parameters: Record<string, unknown>): string {
  const groups: string[] = []

  for (const key of Object.keys(parameters).sort()) {
    // The previous serializer omitted this key when copying into a plain object.
    if (key === '__proto__') continue

    const value = parameters[key]
    const values: readonly unknown[] = Array.isArray(value) ? value : [value]
    const group = values
      .filter((entry) => entry !== undefined)
      .map((entry) => {
        const encodedKey = encodeQueryComponent(key)

        return entry === null
          ? encodedKey
          : `${encodedKey}=${encodeQueryComponent(entry)}`
      })
      .join('&')

    if (group.length > 0) groups.push(group)
  }

  return groups.join('&')
}

function encodeQueryComponent(value: unknown): string {
  // Implicit string conversion preserves TypeError for symbols.
  return encodeURIComponent(`${value}`).replaceAll(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}
