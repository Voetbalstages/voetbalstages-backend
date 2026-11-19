import { createRoute, z } from '@hono/zod-openapi'
import { ACTIVE, Camps, Registrations, getSettings, registrationStatuses } from '../db/models/index.js'
import { router } from '../lib/router.js'
import { conflict, notFound } from '../lib/errors.js'
import { escapeRegex } from '../lib/ids.js'
import { yearRange } from '../lib/dates.js'
import { IdParams, ObjectIdParam, PaginationQuery, RegistrationSchema, errorResponses, json } from '../schemas.js'
import { serializeRegistrations, type RegistrationLike } from '../serializers/index.js'
import { requireUser } from '../auth/session.js'
import { adminCancelRegistration, cancelRegistration } from '../services/cancel.js'
import { logActivity } from '../services/activity.js'
import { optionalStaff, orgScope, requireAdmin } from '../auth/staff.js'

const app = router()

const Patch = z
  .object({
    status: z.enum(registrationStatuses),
    campId: ObjectIdParam,
    price: z.number().min(0).nullable(),
    gadgets: z.array(z.string().max(50)).max(10),
    tshirtSize: z.string().max(20)
  })
  .strict()

/** Parents: own registrations. Staff: all (a MANAGER only their organizations). */
const scope = (c: Parameters<typeof requireUser>[0], userId: unknown, organizationId?: string) => {
  const staff = optionalStaff(c)
  return staff ? orgScope(staff, organizationId) : { userId, ...(organizationId && { organizationId }) }
}

app.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['Registrations'],
    summary: 'Registrations',
    description:
      'Parents: their own. **Staff: every parent\'s** (MANAGER: own organizations). Sets `X-Total-Count`.',
    request: {
      query: PaginationQuery.extend({
        campId: ObjectIdParam.optional(),
        studentId: ObjectIdParam.optional(),
        status: z.enum(registrationStatuses).optional(),
        orderId: z.string().max(20).optional(),
        organizationId: ObjectIdParam.optional(),
        userId: ObjectIdParam.optional().openapi({ description: 'Staff only; ignored for parents.' }),
        locationId: ObjectIdParam.optional(),
        year: z.coerce.number().int().min(2000).max(2100).optional(),
        period: z.string().max(100).optional(),
        sort: z.enum(['createdAt', 'status', 'orderId', 'paid']).default('createdAt')
      })
    },
    responses: { 200: json(z.array(RegistrationSchema)), ...errorResponses(401) }
  }),
  async c => {
    const user = requireUser(c)
    const { page, perPage, sort, order, organizationId, locationId, year, period, orderId, userId, ...rest } =
      c.req.valid('query')
    const staff = optionalStaff(c)
    const filter: Record<string, unknown> = scope(c, user._id, organizationId)
    for (const [key, value] of Object.entries(rest)) if (value) filter[key] = value
    if (staff && userId) filter.userId = userId
    if (orderId) filter.orderId = { $regex: `^${escapeRegex(orderId)}`, $options: 'i' }
    if (locationId || year || period) {
      const campFilter: Record<string, unknown> = {}
      if (locationId) campFilter.locationId = locationId
      if (year) campFilter.from = yearRange(year)
      if (period) campFilter.period = period
      const ids = (await Camps.find(campFilter, { _id: 1 }).lean()).map(x => x._id)
      filter.campId = rest.campId ? { $in: ids.filter(x => String(x) === rest.campId) } : { $in: ids }
    }
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
    summary: 'Single registration',
    description: 'The owner, or staff (MANAGER: own organizations).',
    request: { params: IdParams },
    responses: { 200: json(RegistrationSchema), ...errorResponses(401, 404) }
  }),
  async c => {
    const user = requireUser(c)
    const reg = await Registrations.findOne({ _id: c.req.valid('param').id, ...scope(c, user._id) }).lean()
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
      '**Owner:** only while `canCancel` is true. **ADMIN:** any registration (even other parents\'), ' +
      'any time, ignoring `cancelDays` and open payments; the refund goes to the owning parent. ' +

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
    const id = c.req.valid('param').id
    const { registration, credit } = optionalStaff(c)?.isAdmin
      ? await adminCancelRegistration(user, id)
      : await cancelRegistration(user, id)
    const [json] = await serializeRegistrations([registration], await getSettings())
    return c.json({ registration: json!, credit }, 200)
  }
)

app.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}',
    tags: ['Registrations'],
    summary: 'Edit a registration',
    description:
      '**Requires: ADMIN.** `status` is a plain label change: it does not touch `paid` or store credit ' +
      'and sends no mail (use `/cancel`). `campId` moves the child to another camp of the same ' +
      'organization (`409 DUPLICATE_REGISTRATION` if already booked there). `price` is the custom ' +
      'amount due (`null` removes it, the camp price applies again). Short/shoe size are not editable.',
    request: { params: IdParams, body: { content: { 'application/json': { schema: Patch.partial() } } } },
    responses: { 200: json(RegistrationSchema), ...errorResponses(400, 401, 403, 404, 409) }
  }),
  async c => {
    const { user } = requireAdmin(c)
    const { id } = c.req.valid('param')
    const { price, ...data } = c.req.valid('json')
    const reg = (await Registrations.findById(id).lean()) as RegistrationLike | null
    if (!reg) throw notFound('Registration')
    const $set: Record<string, unknown> = { ...data }
    const $unset: Record<string, 1> = {}
    if (price === null) $unset.price = 1
    else if (price !== undefined) $set.price = price
    if (data.campId && data.campId !== String(reg.campId)) {
      const camp = await Camps.findById(data.campId).lean()
      if (!camp) throw notFound('Camp')
      if (String(camp.organizationId) !== String(reg.organizationId)) {
        throw conflict('ORGANIZATION_MISMATCH', 'Target camp belongs to another organization')
      }
      if (
        reg.studentId &&
        (await Registrations.exists({ _id: { $ne: id }, campId: camp._id, studentId: reg.studentId, status: { $in: ACTIVE } }))
      ) {
        throw conflict('DUPLICATE_REGISTRATION', 'This child is already registered for that camp')
      }
    }
    const updated = await Registrations.findOneAndUpdate(
      { _id: id },
      { $set, ...(Object.keys($unset).length && { $unset }) },
      { new: true }
    ).lean()
    logActivity(user._id, 'REGISTRATION')
    return c.json((await serializeRegistrations([updated as RegistrationLike], await getSettings()))[0]!, 200)
  }
)

export default app
