import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'

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
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
