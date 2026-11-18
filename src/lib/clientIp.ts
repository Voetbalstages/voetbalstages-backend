import type { Context } from 'hono'

/**
 * Client IP behind `trustedProxies` reverse proxies. Each proxy appends the address it saw to
 * X-Forwarded-For, so the entry added by the outermost trusted proxy is
 * xff[xff.length - trustedProxies]; anything left of it is client-controlled.
 */
export const clientIp = (c: Context, trustedProxies: number): string => {
  const xff = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  if (trustedProxies > 0 && xff.length >= trustedProxies) {
    return xff[xff.length - trustedProxies]!
  }
  // Bun.serve passes the server as the fetch env; absent when called via app.request() in tests.
  const server = c.env as { requestIP?: (req: Request) => { address: string } | null } | undefined
  return server?.requestIP?.(c.req.raw)?.address ?? 'unknown'
}
