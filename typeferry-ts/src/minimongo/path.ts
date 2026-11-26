export interface ValueBranch {
  readonly value: unknown
  readonly dontIterate?: boolean
  readonly arrayIndices?: readonly (number | 'x')[]
}

export const FORBIDDEN_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function assertSafePathSegment(segment: string): void {
  if (FORBIDDEN_PATH_KEYS.has(segment)) {
    throw new Error(`Forbidden path segment: ${segment}`)
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value === Object.prototype
  ) {
    return false
  }
  const prototype = Object.getPrototypeOf(value) as object | null

  return prototype === Object.prototype || prototype === null
}

export function isNumericKey(value: string): boolean {
  return /^[0-9]+$/.test(value)
}

export function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false

  let operatorState: boolean | undefined
  for (const key of Object.keys(value)) {
    const isOperator = key.startsWith('$') || key === 'diff'
    if (operatorState !== undefined && operatorState !== isOperator) {
      throw new Error(`Inconsistent operator: ${JSON.stringify(value)}`)
    }
    operatorState = isOperator
  }

  return operatorState ?? false
}

function branchAt(
  current: unknown,
  parts: readonly string[],
  arrayIndices?: readonly (number | 'x')[],
  forSort = false,
): ValueBranch[] {
  const [part, ...rest] = parts
  const branch = (value: unknown): ValueBranch => ({
    value,
    ...(arrayIndices ? { arrayIndices } : {}),
  })

  if (part === undefined) return [branch(current)]
  if (FORBIDDEN_PATH_KEYS.has(part)) return [branch(undefined)]
  if (!isPlainObject(current) && !Array.isArray(current)) return [branch(undefined)]

  if (Array.isArray(current)) {
    if (!isNumericKey(part) || Number(part) >= current.length) return []
    const index = Number(part)
    const nextIndices = [...(arrayIndices ?? []), index, 'x' as const]
    const value = current[index]
    if (rest.length === 0) {
      return [{ value, arrayIndices: nextIndices, dontIterate: Array.isArray(value) }]
    }

    return branchAt(value, rest, nextIndices, forSort)
  }

  const value = Object.hasOwn(current, part) ? current[part] : undefined
  if (rest.length === 0) return [branch(value)]
  if (!isPlainObject(value) && !Array.isArray(value)) return [branch(undefined)]

  const results = branchAt(value, rest, arrayIndices, forSort)
  if (Array.isArray(value) && !(forSort && isNumericKey(rest[0] ?? ''))) {
    value.forEach((element, index) => {
      if (isPlainObject(element)) {
        results.push(...branchAt(element, rest, [...(arrayIndices ?? []), index], forSort))
      }
    })
  }

  return results
}

export function lookupBranches(
  document: unknown,
  path: string,
  options: { readonly forSort?: boolean } = {},
): ValueBranch[] {
  return branchAt(document, path.split('.'), undefined, options.forSort)
}

export function expandArrays(
  branches: readonly ValueBranch[],
  options: { readonly skipArrays?: boolean } = {},
): ValueBranch[] {
  const result: ValueBranch[] = []
  for (const branch of branches) {
    const isArray = Array.isArray(branch.value)
    if (!(options.skipArrays && isArray && !branch.dontIterate)) result.push(branch)
    if (isArray && !branch.dontIterate) {
      branch.value.forEach((value, index) => {
        result.push({
          value,
          arrayIndices: [...(branch.arrayIndices ?? []), index],
        })
      })
    }
  }

  return result
}

export function getPath(document: unknown, path: string): unknown {
  let current = document
  for (const part of path.split('.')) {
    if (FORBIDDEN_PATH_KEYS.has(part)) return undefined
    if (!isPlainObject(current) && !Array.isArray(current)) return undefined
    current = Object.hasOwn(current, part) ? (Reflect.get(current, part) as unknown) : undefined
  }

  return current
}

export function setPath(document: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  for (const part of parts) assertSafePathSegment(part)
  const finalPart = parts.pop()
  if (!finalPart) return

  let current: Record<string, unknown> = document
  for (const part of parts) {
    const existing = Object.hasOwn(current, part) ? current[part] : undefined
    if (isPlainObject(existing)) {
      current = existing
    } else {
      const child: Record<string, unknown> = {}
      current[part] = child
      current = child
    }
  }
  current[finalPart] = value
}

export function deletePath(document: Record<string, unknown>, path: string): void {
  const parts = path.split('.')
  for (const part of parts) assertSafePathSegment(part)
  const finalPart = parts.pop()
  if (!finalPart) return

  let current: unknown = document
  for (const part of parts) {
    if (!isPlainObject(current) && !Array.isArray(current)) return
    current = Object.hasOwn(current, part) ? (Reflect.get(current, part) as unknown) : undefined
  }
  if (Array.isArray(current) && isNumericKey(finalPart)) {
    if (Number(finalPart) in current) current[Number(finalPart)] = null
  } else if (isPlainObject(current)) {
    delete current[finalPart]
  }
}
