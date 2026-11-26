import { LocalQueryError as LocalQueryError } from './errors'
import {
  expandArrays,
  isOperatorObject,
  isPlainObject,
  lookupBranches,
  type ValueBranch,
} from './path'
import type { CollationOptions, MatchResult, MinimongoId, Selector } from './types'
import { localValueSemantics, type ValueSemantics } from './value-semantics'

type DocumentMatcher = (document: Record<string, unknown>) => MatchResult
type BranchMatcher = (branches: readonly ValueBranch[]) => MatchResult

const TYPE_ALIASES = new Map<string, number>([
  ['double', 1], ['string', 2], ['object', 3], ['array', 4], ['binData', 5],
  ['undefined', 6], ['objectId', 7], ['bool', 8], ['date', 9], ['null', 10],
  ['regex', 11], ['javascript', 13], ['int', 16], ['timestamp', 17],
  ['long', 18], ['decimal', 19], ['minKey', -1], ['maxKey', 127],
])

function minimongoType(value: unknown): number {
  if (typeof value === 'number') return 1
  if (typeof value === 'string') return 2
  if (typeof value === 'boolean') return 8
  if (Array.isArray(value)) return 4
  if (value === null) return 10
  if (value instanceof RegExp) return 11
  if (typeof value === 'function') return 13
  if (value instanceof Date) return 9
  if (value instanceof Uint8Array) return 5

  return 3
}

function createCollator(options?: CollationOptions | Intl.Collator): Intl.Collator | undefined {
  if (!options) return undefined
  if (options instanceof Intl.Collator) return options
  if (!options.locale) throw new LocalQueryError('Collation requires a locale')

  const sensitivity = options.strength === 1
    ? 'base'
    : options.strength === 2
      ? 'accent'
      : 'variant'

  return new Intl.Collator(options.locale, {
    caseFirst: options.caseFirst === 'off' ? 'false' : options.caseFirst,
    caseLevel: options.caseLevel,
    numeric: options.numericOrdering,
    sensitivity,
  } as Intl.CollatorOptions)
}

function regexMatches(regex: RegExp, value: unknown): boolean {
  if (value instanceof RegExp) return value.toString() === regex.toString()
  if (typeof value !== 'string') return false
  regex.lastIndex = 0

  return regex.test(value)
}

function bitMask(operand: unknown, operator: string): Uint8Array {
  if (Number.isInteger(operand) && Number(operand) >= 0 && Number(operand) <= 0x7fffffff) {
    return new Uint8Array(new Int32Array([Number(operand)]).buffer)
  }
  if (operand instanceof Uint8Array) return operand
  if (Array.isArray(operand) && operand.every(value => Number.isInteger(value) && value >= 0)) {
    const MAX_BIT_POSITION = 4096
    let maximum = 0
    for (const position of operand) {
      if (position > MAX_BIT_POSITION) {
        throw new LocalQueryError(`operand to ${operator} bit position must not exceed ${MAX_BIT_POSITION}`)
      }
      if (position > maximum) maximum = position
    }
    const result = new Uint8Array((maximum >> 3) + 1)
    for (const position of operand) result[position >> 3] = (result[position >> 3] ?? 0) | (1 << (position & 7))

    return result
  }

  throw new LocalQueryError(
    `operand to ${operator} must be a numeric bitmask (representable as a non-negative 32-bit signed integer), a bindata bitmask or an array with bit positions (non-negative integers)`,
  )
}

function valueMask(value: unknown, length: number): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value
  if (!Number.isSafeInteger(value)) return undefined

  const result = new Uint8Array(Math.max(length, 8))
  let remaining = BigInt(Number(value))
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }

  return result
}

function point(value: unknown): readonly [number, number] | undefined {
  if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number') {
    return [value[0], value[1]]
  }
  if (isPlainObject(value) && value.type === 'Point' && Array.isArray(value.coordinates)) {
    return point(value.coordinates)
  }
  if (isPlainObject(value) && typeof value.x === 'number' && typeof value.y === 'number') {
    return [value.x, value.y]
  }

  return undefined
}

function distance(left: readonly [number, number], right: readonly [number, number]): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1])
}

function geoJsonDistance(left: readonly [number, number], right: readonly [number, number]): number {
  const radians = (degrees: number): number => degrees * Math.PI / 180
  const latitude = radians(right[1] - left[1])
  const longitude = radians(right[0] - left[0])
  const haversine = Math.sin(latitude / 2) ** 2
    + Math.cos(radians(left[1])) * Math.cos(radians(right[1]))
    * Math.sin(longitude / 2) ** 2
  const arc = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))

  return 6_371_000 * arc
}

/** Compiles and evaluates TypeFerry's Mongo-style selectors. */
export class Matcher<TDocument extends object = object> {
  private readonly paths = new Set<string>()
  private readonly documentMatcher: DocumentMatcher
  private readonly collator: Intl.Collator | undefined
  private geoQuery = false
  private simple = true

  constructor(
    readonly selector: Selector<TDocument> | unknown,
    private readonly isUpdate = false,
    collation?: CollationOptions | Intl.Collator,
    private readonly values: ValueSemantics = localValueSemantics,
  ) {
    this.collator = createCollator(collation)
    this.documentMatcher = this.compileSelector(selector)
  }

  documentMatches(document: TDocument): MatchResult {
    if (typeof document !== 'object' || document === null) {
      throw new Error('documentMatches needs a document')
    }

    return this.documentMatcher(document as Record<string, unknown>)
  }

  hasGeoQuery(): boolean {
    return this.geoQuery
  }

  isSimple(): boolean {
    return this.simple
  }

  _getPaths(): readonly string[] {
    return [...this.paths]
  }

  private compileSelector(selector: unknown): DocumentMatcher {
    if (typeof selector === 'string') {
      this.paths.add('_id')

      return document => ({ result: this.equal(selector, document._id) })
    }
    if (!selector || (isPlainObject(selector) && Object.hasOwn(selector, '_id') && !selector._id)) {
      this.simple = false

      return () => ({ result: false })
    }
    if (Array.isArray(selector) || selector instanceof Uint8Array || typeof selector === 'boolean') {
      throw new Error(`Invalid selector: ${String(selector)}`)
    }
    if (!isPlainObject(selector)) throw new Error(`Invalid selector: ${String(selector)}`)

    return this.compileDocument(selector, true)
  }

  private compileDocument(selector: Record<string, unknown>, isRoot: boolean): DocumentMatcher {
    const matchers = Object.entries(selector).flatMap(([path, value]) => {
      if (path.startsWith('$')) return [this.compileLogical(path, value)]
      if (typeof value === 'function') return []
      this.paths.add(path)
      const valueMatcher = this.compileValue(value, isRoot)

      return [(document: Record<string, unknown>) => valueMatcher(lookupBranches(document, path))]
    })

    return document => {
      let arrayIndices: readonly (number | 'x')[] | undefined
      let nearestDistance: number | undefined
      for (const matcher of matchers) {
        const result = matcher(document)
        if (!result.result) return { result: false }
        if (result.arrayIndices) arrayIndices = result.arrayIndices
        if (result.distance !== undefined) nearestDistance = result.distance
      }

      return {
        result: true,
        ...(arrayIndices ? { arrayIndices } : {}),
        ...(nearestDistance !== undefined ? { distance: nearestDistance } : {}),
      }
    }
  }

  private compileLogical(operator: string, operand: unknown): DocumentMatcher {
    this.simple = false
    if (operator === '$comment') return () => ({ result: true })
    if (!['$and', '$or', '$nor'].includes(operator)) {
      throw new LocalQueryError(`Unrecognized logical operator: ${operator}`)
    }
    if (!Array.isArray(operand) || operand.length === 0) {
      throw new LocalQueryError('$and/$or/$nor must be nonempty array')
    }
    const entries = operand.map(value => {
      if (!isPlainObject(value)) throw new LocalQueryError('$or/$and/$nor entries need to be full objects')

      return this.compileDocument(value, false)
    })
    if (operator === '$and') {
      return document => {
        let distance: number | undefined
        let arrayIndices: readonly (number | 'x')[] | undefined
        for (const matcher of entries) {
          const result = matcher(document)
          if (!result.result) return { result: false }
          if (distance === undefined && result.distance !== undefined) distance = result.distance
          if (result.arrayIndices) arrayIndices = result.arrayIndices
        }

        return {
          result: true,
          ...(distance !== undefined ? { distance } : {}),
          ...(arrayIndices ? { arrayIndices } : {}),
        }
      }
    }
    if (operator === '$or') {
      if (entries.length === 1) return entries[0]!

      return document => ({ result: entries.some(matcher => matcher(document).result) })
    }
    if (operator === '$nor') return document => ({ result: entries.every(matcher => !matcher(document).result) })

    throw new LocalQueryError(`Unrecognized logical operator: ${operator}`)
  }

  private compileValue(selector: unknown, isRoot: boolean): BranchMatcher {
    if (selector instanceof RegExp) return this.elementMatcher(value => regexMatches(selector, value))
    if (!isOperatorObject(selector)) return this.elementMatcher(value => this.equal(selector, value))

    const matchers = Object.entries(selector).map(([operator, operand]) =>
      this.compileOperator(operator, operand, selector, isRoot))

    return branches => {
      const results = matchers.map(matcher => matcher(branches))
      const failed = results.some(result => !result.result)
      const positional = results.find(result => result.arrayIndices)
      const geo = results.find(result => result.distance !== undefined)

      return {
        result: !failed,
        ...(positional?.arrayIndices ? { arrayIndices: positional.arrayIndices } : {}),
        ...(geo?.distance !== undefined ? { distance: geo.distance } : {}),
      }
    }
  }

  private compileOperator(
    operator: string,
    operand: unknown,
    selector: Record<string, unknown>,
    isRoot: boolean,
  ): BranchMatcher {
    const comparison = (test: (result: number) => boolean): BranchMatcher => {
      if (Array.isArray(operand)) return () => ({ result: false })
      const normalizedOperand = operand === undefined ? null : operand
      const operandType = minimongoType(normalizedOperand)

      return this.elementMatcher(value => {
        const normalizedValue = value === undefined ? null : value

        return minimongoType(normalizedValue) === operandType
          && test(this.values.compare(normalizedValue, normalizedOperand, this.collator))
      })
    }

    if (operator === '$lt') return comparison(result => result < 0)
    if (operator === '$lte') return comparison(result => result <= 0)
    if (operator === '$gt') return comparison(result => result > 0)
    if (operator === '$gte') return comparison(result => result >= 0)
    if (operator === '$eq') return this.elementMatcher(value => this.equal(operand, value))
    if (operator === '$ne') return this.invert(this.elementMatcher(value => this.equal(operand, value)))
    if (operator === '$in' || operator === '$nin') {
      if (!Array.isArray(operand)) throw new LocalQueryError('$in needs an array')
      const matcher = this.elementMatcher(value => operand.some(option => {
        if (isOperatorObject(option)) throw new LocalQueryError('cannot nest $ under $in')

        return option instanceof RegExp ? regexMatches(option, value) : this.equal(option, value)
      }))

      return operator === '$nin' ? this.invert(matcher) : matcher
    }
    if (operator === '$exists') {
      const matcher = this.elementMatcher(value => value !== undefined)

      return operand ? matcher : this.invert(matcher)
    }
    if (operator === '$not') return this.invert(this.compileValue(operand, false))
    if (operator === '$options') {
      if (!Object.hasOwn(selector, '$regex')) throw new LocalQueryError('$options needs a $regex')

      return () => ({ result: true })
    }
    if (operator === '$regex') {
      if (!(typeof operand === 'string' || operand instanceof RegExp)) {
        throw new LocalQueryError('$regex has to be a string or RegExp')
      }
      const source = operand instanceof RegExp ? operand.source : operand
      const inheritedFlags = operand instanceof RegExp ? operand.flags : ''
      const flags = selector.$options === undefined ? inheritedFlags : String(selector.$options)
      if (/[^gim]/.test(flags)) {
        throw new LocalQueryError('Only the i, m, and g regexp options are supported')
      }
      const regex = new RegExp(source, flags)

      return this.elementMatcher(value => regexMatches(regex, value))
    }
    if (operator === '$size') {
      const size = typeof operand === 'string' ? 0 : operand
      if (typeof size !== 'number') throw new LocalQueryError('$size needs a number')

      return this.elementMatcher(value => Array.isArray(value) && value.length === size, false)
    }
    if (operator === '$all') {
      if (!Array.isArray(operand)) throw new LocalQueryError('$all requires array')
      if (operand.length === 0) return () => ({ result: false })
      if (operand.some(isOperatorObject)) throw new LocalQueryError('no $ expressions in $all')

      return branches => ({
        result: operand.every(expected => this.elementMatcher(value => expected instanceof RegExp
          ? regexMatches(expected, value)
          : this.equal(expected, value))(branches).result),
      })
    }
    if (operator === '$elemMatch') {
      if (!isPlainObject(operand)) throw new LocalQueryError('$elemMatch need an object')

      return branches => {
        for (const branch of branches) {
          if (!Array.isArray(branch.value)) continue
          for (let index = 0; index < branch.value.length; index += 1) {
            const value = branch.value[index]
            const result = isPlainObject(operand) && !isOperatorObject(operand) && isPlainObject(value)
              ? this.compileDocument(operand, false)(value).result
              : this.compileValue(operand, false)([{ value }]).result
            if (result) return { result: true, arrayIndices: [...(branch.arrayIndices ?? []), index] }
          }
        }

        return { result: false }
      }
    }
    if (operator === '$mod') {
      if (!Array.isArray(operand) || operand.length !== 2
        || typeof operand[0] !== 'number' || typeof operand[1] !== 'number') {
        throw new LocalQueryError('argument to $mod must be an array of two numbers')
      }

      return this.elementMatcher(value => typeof value === 'number' && value % operand[0] === operand[1])
    }
    if (operator === '$type') {
      const expected = typeof operand === 'string' ? TYPE_ALIASES.get(operand) : operand
      if (expected === undefined) throw new LocalQueryError(`unknown string alias for $type: ${String(operand)}`)
      if (typeof expected !== 'number') throw new LocalQueryError('argument to $type is not a number or a string')
      if (expected === 0 || expected < -1 || (expected > 19 && expected !== 127)) {
        throw new LocalQueryError(`Invalid numerical $type code: ${expected}`)
      }

      return this.elementMatcher(value => value !== undefined && minimongoType(value) === expected, true, true)
    }
    if (operator.startsWith('$bits')) {
      const mask = bitMask(operand, operator)

      return this.elementMatcher(value => {
        const candidate = valueMask(value, mask.length)
        if (!candidate) return false
        if (operator === '$bitsAllSet') {
          return [...mask].every((byte, index) => ((candidate[index] ?? 0) & byte) === byte)
        }
        if (operator === '$bitsAnySet') {
          return [...mask].some((byte, index) => ((candidate[index] ?? 0) & byte) !== 0)
        }
        if (operator === '$bitsAllClear') {
          return [...mask].every((byte, index) => ((candidate[index] ?? 0) & byte) === 0)
        }

        return [...mask].some((byte, index) => ((candidate[index] ?? 0) & byte) !== byte)
      })
    }
    if (operator === '$maxDistance') {
      if (!Object.hasOwn(selector, '$near')) throw new LocalQueryError('$maxDistance needs a $near')

      return () => ({ result: true })
    }
    if (operator === '$near') {
      if (!isRoot) throw new LocalQueryError('$near can\'t be inside another $ operator')
      this.geoQuery = true
      const isGeoJson = isPlainObject(operand) && Object.hasOwn(operand, '$geometry')
      const geometry = isGeoJson
        ? operand.$geometry
        : operand
      const origin = point(geometry)
      if (!origin) throw new LocalQueryError('$near argument must be coordinate pair or GeoJSON')
      const maxDistance = isPlainObject(operand) && typeof operand.$maxDistance === 'number'
        ? operand.$maxDistance
        : typeof selector.$maxDistance === 'number'
          ? selector.$maxDistance
          : Number.POSITIVE_INFINITY

      return branches => {
        let nearest: number | undefined
        let indices: readonly (number | 'x')[] | undefined
        for (const branch of expandArrays(branches)) {
          const candidate = point(branch.value)
          if (!candidate) continue
          const current = this.isUpdate
            ? undefined
            : isGeoJson
              ? geoJsonDistance(origin, candidate)
              : distance(origin, candidate)
          if (this.isUpdate || (current !== undefined && current <= maxDistance && (nearest === undefined || current < nearest))) {
            nearest = current
            indices = branch.arrayIndices
            if (this.isUpdate) break
          }
        }

        if (nearest === undefined && !(this.isUpdate && indices !== undefined)) return { result: false }

        return {
          result: true,
          ...(nearest !== undefined ? { distance: nearest } : {}),
          ...(indices ? { arrayIndices: indices } : {}),
        }
      }
    }

    throw new LocalQueryError(`Unrecognized operator: ${operator}`)
  }

  private elementMatcher(
    predicate: (value: unknown) => boolean,
    expand = true,
    skipArrays = false,
  ): BranchMatcher {
    return branches => {
      const candidates = expand ? expandArrays(branches, { skipArrays }) : branches
      const matched = candidates.find(branch => predicate(branch.value))

      return matched
        ? { result: true, ...(matched.arrayIndices ? { arrayIndices: matched.arrayIndices } : {}) }
        : { result: false }
    }
  }

  private invert(matcher: BranchMatcher): BranchMatcher {
    return branches => ({ result: !matcher(branches).result })
  }

  private equal(expected: unknown, actual: unknown): boolean {
    if (expected == null && actual == null) return true
    if (this.collator && typeof expected === 'string' && typeof actual === 'string') {
      return this.collator.compare(expected, actual) === 0
    }

    return this.values.equals(expected, actual, { keyOrderSensitive: true })
  }
}

export function isIdSelector(selector: unknown): selector is MinimongoId {
  return typeof selector === 'string'
}
