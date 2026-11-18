import { createRoute, z } from '@hono/zod-openapi'
import { env } from '../env.js'
import { router } from '../lib/router.js'
import { RateLimiter } from '../lib/rateLimit.js'
import { clientIp } from '../lib/clientIp.js'
import { tooManyRequests } from '../lib/errors.js'
import { UserSchema, errorResponses, json } from '../schemas.js'
import { serializeUser } from '../serializers/index.js'
import { normalizeEmail, requestMagicLink, verifyMagicLink } from '../auth/magicLink.js'
import { createSession, destroySession, requireUser } from '../auth/session.js'

const WINDOW = 15 * 60 * 1000
export const emailLimiter = new RateLimiter(3, WINDOW)
export const ipLimiter = new RateLimiter(20, WINDOW)

const app = router()

app.openapi(
  createRoute({
    method: 'post',
    path: '/magic-link',
    tags: ['Auth'],
    summary: 'Email a one-time login link',
    description:
      'Always 204, whether or not the account exists. `redirectTo` must be a relative path and is ' +
      'returned again by verify. `agreeToTerms` is only used when the email has no account yet.',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              email: z.email().max(254),
              agreeToTerms: z.boolean().optional(),
              redirectTo: z.string().max(500).optional()
            })
          }
        }
      }
    },
    responses: { 204: { description: 'Mail sent (or silently skipped)' }, ...errorResponses(400, 429) }
  }),
  async c => {
    const body = c.req.valid('json')
    const ip = clientIp(c, env.TRUSTED_PROXY_COUNT)
    if (!ipLimiter.take(ip) || !emailLimiter.take(normalizeEmail(body.email))) throw tooManyRequests()
    await requestMagicLink(body)
    return c.body(null, 204)
  }
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/magic-link/verify',
    tags: ['Auth'],
    summary: 'Exchange a login token for a session',
    description:
      'Called by the shop page the email links to (never a GET, so mail scanners cannot burn the ' +
      'token). `409 TERMS_REQUIRED` means the email is new: show the terms and call again with ' +
      '`agreeToTerms: true`; the token stays valid.',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({ token: z.string().min(20).max(200), agreeToTerms: z.boolean().optional() })
          }
        }
      }
    },
    responses: {
      200: json(z.object({ user: UserSchema, redirectTo: z.string().nullable() }), 'Logged in'),
      ...errorResponses(400, 409)
    }
  }),
  async c => {
    const { user, redirectTo } = await verifyMagicLink(c.req.valid('json'))
    await createSession(c, user._id)
    return c.json({ user: serializeUser(user), redirectTo }, 200)
  }
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/logout',
    tags: ['Auth'],
    summary: 'Destroy the session',
    responses: { 204: { description: 'Logged out' }, ...errorResponses(401) }
  }),
  async c => {
    requireUser(c)
    await destroySession(c)
    return c.body(null, 204)
  }
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/me',
    tags: ['Auth'],
    summary: 'Current user or null',
    responses: { 200: json(UserSchema.nullable()) }
  }),
  c => {
    const user = c.get('user')
    return c.json(user ? serializeUser(user) : null, 200)
  }
)

export default app
