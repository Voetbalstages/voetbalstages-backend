import { createRoute, z } from '@hono/zod-openapi'
import { Registrations, getSettings, registrationStatuses } from '../db/models/index.js'
import { router } from '../lib/router.js'
import { notFound } from '../lib/errors.js'
import { IdParams, ObjectIdParam, PaginationQuery, RegistrationSchema, errorResponses, json } from '../schemas.js'
import { serializeRegistrations, type RegistrationLike } from '../serializers/index.js'
import { requireUser } from '../auth/session.js'
import { cancelRegistration } from '../services/cancel.js'

const app = router()

app.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['Registrations'],
    summary: 'Own registrations',
    description: 'Sets `X-Total-Count`.',
    request: {
      query: PaginationQuery.extend({
        campId: ObjectIdParam.optional(),
        studentId: ObjectIdParam.optional(),
        status: z.enum(registrationStatuses).optional(),
        orderId: z.string().max(20).optional(),
        organizationId: ObjectIdParam.optional(),
        sort: z.enum(['createdAt', 'status', 'orderId']).default('createdAt')
      })
    },
    responses: { 200: json(z.array(RegistrationSchema)), ...errorResponses(401) }
  }),
  async c => {
    const user = requireUser(c)
    const { page, perPage, sort, order, ...filters } = c.req.valid('query')
    const filter: Record<string, unknown> = { userId: user._id }
    for (const [key, value] of Object.entries(filters)) if (value) filter[key] = value
    const [total, regs] = await Promise.all([
      Registrations.countDocuments(filter),
      Registrations.find(filter)
        .sort({ [sort]: order === 'asc' ? 1 : -1, _id: 1 })
        .skip(page * perPage)
        .limit(perPage)
        .lean()
    ])
    c.header('X-Total-Count', String(total))
    return c.json(await serializeRegistrations(regs as RegistrationLike[], await getSettings()), 200)
  }
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/{id}',
    tags: ['Registrations'],
    summary: 'Single own registration',
    request: { params: IdParams },
    responses: { 200: json(RegistrationSchema), ...errorResponses(401, 404) }
  }),
  async c => {
    const user = requireUser(c)
    const reg = await Registrations.findOne({ _id: c.req.valid('param').id, userId: user._id }).lean()
    if (!reg) throw notFound('Registration')
    const [json] = await serializeRegistrations([reg as RegistrationLike], await getSettings())
    return c.json(json!, 200)
  }
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/{id}/cancel',
    tags: ['Registrations'],
    summary: 'Cancel, refunding anything paid to store credit',
    description:
      '`409 NOT_CANCELLABLE` unless `canCancel` is true; `409 PAYMENT_IN_PROGRESS` while a Mollie ' +
      'payment for the order is open or pending. `credit` is the user\'s new total.',
    request: { params: IdParams },
    responses: {
      200: json(z.object({ registration: RegistrationSchema, credit: z.number() })),
      ...errorResponses(401, 404, 409)
    }
  }),
  async c => {
    const user = requireUser(c)
    const { registration, credit } = await cancelRegistration(user, c.req.valid('param').id)
    const [json] = await serializeRegistrations([registration], await getSettings())
    return c.json({ registration: json!, credit }, 200)
  }
)

export default app
