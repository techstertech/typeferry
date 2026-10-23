/**
 * Older supported WebViews have abort events but no reason or throwIfAborted.
 * Keep cancellation local without requiring newer AbortSignal convenience APIs.
 */
export function getAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

/**
 * Checks cancellation on both older native WebViews and current browsers.
 */
export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw getAbortReason(signal)
}
