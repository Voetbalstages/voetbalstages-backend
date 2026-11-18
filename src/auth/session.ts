import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Types } from 'mongoose'
import { Sessions, Users } from '../db/models/index.js'
import { randomToken, sha256 } from '../lib/ids.js'
import { unauthorized } from '../lib/errors.js'
import type { AppEnv } from '../types.js'

/** Sent as `__Host-vs_session`: host-only, Path=/, Secure. */
const COOKIE = 'vs_session'
const MAX_AGE_S = 30 * 24 * 60 * 60
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000

const writeCookie = (c: Context, token: string) =>
  setCookie(c, COOKIE, token, {
    prefix: 'host',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: MAX_AGE_S
  })

export const createSession = async (c: Context, userId: Types.ObjectId) => {
  const token = randomToken()
  const now = Date.now()
  await Sessions.create({
    _id: sha256(token),
    userId,
    expiresAt: new Date(now + MAX_AGE_S * 1000),
    refreshedAt: new Date(now)
  })
  writeCookie(c, token)
}

export const destroySession = async (c: Context<AppEnv>) => {
  const id = c.get('sessionId')
  if (id) await Sessions.deleteOne({ _id: id })
  deleteCookie(c, COOKIE, { prefix: 'host', path: '/', secure: true })
}

/** Resolves the session cookie to `c.var.user` (or null). Sliding 30-day expiry. */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null)
  c.set('sessionId', null)
  const token = getCookie(c, COOKIE, 'host')
  if (token) {
    const id = sha256(token)
    const session = await Sessions.findOne({ _id: id, expiresAt: { $gt: new Date() } }).lean()
    const user = session ? await Users.findById(session.userId) : null
    if (session && user) {
      c.set('user', user)
      c.set('sessionId', id)
      if (Date.now() - new Date(session.refreshedAt).getTime() > REFRESH_AFTER_MS) {
        const now = Date.now()
        await Sessions.updateOne(
          { _id: id },
          { $set: { expiresAt: new Date(now + MAX_AGE_S * 1000), refreshedAt: new Date(now) } }
        )
        writeCookie(c, token)
      }
    }
  }
  await next()
}

export const requireUser = (c: Context<AppEnv>) => {
  const user = c.get('user')
  if (!user) throw unauthorized()
  return user
}
