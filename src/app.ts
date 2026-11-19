import { OpenAPIHono } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import type { MiddlewareHandler } from 'hono'
import { env } from './env.js'
import { logger, reportError } from './logger.js'
import { dbHealthy } from './db/connection.js'
import { ApiError } from './lib/errors.js'
import { sessionMiddleware } from './auth/session.js'
import type { AppEnv } from './types.js'
import authRoutes from './routes/auth.js'
import meRoutes from './routes/me.js'
import studentRoutes from './routes/students.js'
import locationRoutes from './routes/locations.js'
import campRoutes from './routes/camps.js'
import orderRoutes from './routes/orders.js'
import registrationRoutes from './routes/registrations.js'
import organizationRoutes from './routes/organizations.js'
import publicRoutes from './routes/public.js'
import paymentRoutes from './routes/payments.js'
import userRoutes from './routes/users.js'
import placesRoutes from './routes/places.js'
import uploadRoutes from './routes/uploads.js'
import devRoutes from './dev/routes.js'

const BASE = '/api/v1'

const errorBody = (code: string, message: string) => ({ error: { code, message } })

/**
 * CSRF guard for cookie-authenticated requests. POST is the only "simple" method we accept, so
 * requiring a JSON content type forces a CORS preflight for every state-changing request; the
 * Origin, when a browser sends one, must be on the allowlist.
 */
const requestGuard: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'POST') {
    const type = c.req.header('content-type') ?? ''
    if (!type.toLowerCase().startsWith('application/json')) {
      return c.json(errorBody('UNSUPPORTED_MEDIA_TYPE', 'Send Content-Type: application/json'), 415)
    }
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin')
    if (origin && !env.CORS_ORIGINS.includes(origin)) {
      return c.json(errorBody('FORBIDDEN_ORIGIN', 'Origin not allowed'), 403)
    }
  }
  await next()
}

export const createApp = () => {
  const app = new OpenAPIHono<AppEnv>()

  app.use('*', async (c, next) => {
    const start = Date.now()
    await next()
    logger.info(
      { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start },
      'request'
    )
  })
  app.use('*', secureHeaders())

  app.get('/health', c =>
    dbHealthy() ? c.json({ status: 'ok', db: 'up' }) : c.json({ status: 'error', db: 'down' }, 503)
  )

  // Mollie webhook: before CORS/guard/session, it is server-to-server.
  app.route(`${BASE}/payments`, paymentRoutes)
  if (env.DEV_TOOLS) app.route(`${BASE}/dev`, devRoutes)

  app.use(
    `${BASE}/*`,
    cors({
      origin: origin => (env.CORS_ORIGINS.includes(origin) ? origin : null),
      credentials: true,
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      exposeHeaders: ['X-Total-Count'],
      maxAge: 600
    })
  )
  app.use(`${BASE}/*`, requestGuard)
  app.use(`${BASE}/*`, sessionMiddleware)

  app.route(`${BASE}/auth`, authRoutes)
  app.route(`${BASE}/me`, meRoutes)
  app.route(`${BASE}/students`, studentRoutes)
  app.route(`${BASE}/locations`, locationRoutes)
  app.route(`${BASE}/camps`, campRoutes)
  app.route(`${BASE}/orders`, orderRoutes)
  app.route(`${BASE}/registrations`, registrationRoutes)
  app.route(`${BASE}/organizations`, organizationRoutes)
  app.route(`${BASE}/users`, userRoutes)
  app.route(`${BASE}/places`, placesRoutes)
  app.route(`${BASE}/uploads`, uploadRoutes)
  app.route(BASE, publicRoutes)

  app.doc(`${BASE}/openapi.json`, {
    openapi: '3.0.0',
    info: {
      title: 'Voetbalstages API',
      version: '1.0.0',
      description:
        'REST API for the shop and the admin panel. Both use the same resources; the logged-in user ' +
        'decides what a call returns and may do. Operations that need a role say **Requires: ADMIN** / ' +
        '**staff** in their description; staff get extra fields and see hidden records. Auth is a host-only session cookie: send ' +
        "`credentials: 'include'` and `Content-Type: application/json` on every POST."
    },
    servers: [{ url: env.API_URL }]
  })
  app.get(`${BASE}/docs`, swaggerUI({ url: `${BASE}/openapi.json` }))

  app.notFound(c => c.json(errorBody('NOT_FOUND', 'Route not found'), 404))

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(errorBody(err.code, err.message), err.status)
    if (err instanceof SyntaxError) return c.json(errorBody('INVALID_JSON', 'Malformed JSON body'), 400)
    reportError(err, { method: c.req.method, path: c.req.path })
    return c.json(errorBody('INTERNAL', 'Something went wrong'), 500)
  })

  return app
}
