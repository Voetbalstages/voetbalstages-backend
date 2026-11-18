/**
 * Fixed-window in-memory rate limiter. Fine for a single container; counters reset on redeploy.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private limit: number,
    private windowMs: number
  ) {}

  /** Returns true when the call is allowed. */
  take(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key)
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs })
      this.sweep(now)
      return true
    }
    if (entry.count >= this.limit) return false
    entry.count++
    return true
  }

  reset() {
    this.hits.clear()
  }

  private sweep(now: number) {
    if (this.hits.size < 10_000) return
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key)
  }
}
