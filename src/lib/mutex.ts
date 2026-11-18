/**
 * Per-key async mutex. Serialises money-moving operations (create order, pay order, cancel)
 * per user inside this process. It does not protect against the old backend running
 * concurrently; the guarded Mongo updates do that.
 */
const tails = new Map<string, Promise<unknown>>()

export const withLock = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const prev = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => (release = resolve))
  const tail = prev.then(() => current)
  tails.set(key, tail)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (tails.get(key) === tail) tails.delete(key)
  }
}
