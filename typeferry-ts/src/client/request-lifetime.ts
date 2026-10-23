import { getAbortReason, throwIfAborted } from '../utils/abort'

/**
 * Owns one opt-in request's deadline and cancellation through its completion.
 * Admission policy remains with the application; late waits cannot revive work.
 */
export class RequestLifetime {
  readonly deadline: number
  private readonly controller = new AbortController()
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly followed = new Set<AbortSignal>()
  private readonly cleanups: Array<() => void> = []

  constructor(timeout: number, signal?: AbortSignal) {
    this.deadline = Date.now() + timeout
    this.timer = setTimeout(() => this.cancel(new Error('TypeFerry: Request timed out')), Math.max(0, timeout))
    if (signal) this.follow(signal)
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  cancel(reason: unknown = new Error('TypeFerry: Client closed')): void {
    this.controller.abort(reason)
  }

  follow(signal: AbortSignal): void {
    if (this.followed.has(signal)) return
    this.followed.add(signal)
    if (signal.aborted) {
      this.cancel(getAbortReason(signal))
      return
    }
    const abort = (): void => this.cancel(getAbortReason(signal))
    signal.addEventListener('abort', abort, { once: true })
    this.cleanups.push(() => signal.removeEventListener('abort', abort))
  }

  remaining(): number {
    if (Date.now() >= this.deadline) this.cancel(new Error('TypeFerry: Request timed out'))
    throwIfAborted(this.signal)
    return this.deadline - Date.now()
  }

  async wait<T>(operation: PromiseLike<T> | T): Promise<T> {
    let abort: (() => void) | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = (): void => reject(getAbortReason(this.signal))
      if (this.signal.aborted) abort()
      else this.signal.addEventListener('abort', abort, { once: true })
    })
    try {
      const result = await Promise.race([operation, cancelled])
      this.remaining()
      return result
    } finally {
      if (abort) this.signal.removeEventListener('abort', abort)
    }
  }

  dispose(): void {
    clearTimeout(this.timer)
    for (const cleanup of this.cleanups) cleanup()
  }
}
