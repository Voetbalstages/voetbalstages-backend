import { createRoute, z } from '@hono/zod-openapi'
import { Camps, Registrations, Users, getSettings, type UserDoc } from '../db/models/index.js'
import { router } from '../lib/router.js'
import { notFound } from '../lib/errors.js'
import { ObjectIdParam, OrderSchema, PaginationQuery, booleanQuery, errorResponses, json } from '../schemas.js'
import { serializeOrders, type RegistrationLike } from '../serializers/index.js'
import { requireUser } from '../auth/session.js'
import { createOrder, payOrder } from '../services/orders.js'

const app = router()

const OrderIdParams = z.object({
  orderId: z.string().regex(/^\d{8}-\d{6}$/).openapi({ param: { name: 'orderId', in: 'path' }, example: '20260721-483920' })
})

const CheckoutResult = z
  .object({ order: OrderSchema, payUrl: z.string().nullable(), credit: z.number() })
  .openapi('CheckoutResult')

const tracking = z
  .record(z.string().max(64), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))
  .refine(r => Object.keys(r).length <= 40, 'Too many tracking keys')

const loadOrder = async (user: UserDoc, orderId: string) => {
  const regs = (await Registrations.find({ orderId, userId: user._id }).lean()) as RegistrationLike[]
  if (!regs.length) throw notFound('Order')
  const fresh = await Users.findById(user._id, { credit: 1 }).lean()
  const [order] = await serializeOrders(regs, await getSettings(), fresh?.credit ?? 0)
  return order!
}

app.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['Orders'],
    summary: 'Own orders',
    description:
      'Newest first by default. `outstanding=true` returns only orders with open or deposited ' +
      'registrations for camps that have not ended. Sets `X-Total-Count`.',
    request: {
      query: PaginationQuery.extend({
        outstanding: booleanQuery,
        order: z.enum(['asc', 'desc']).default('desc')
      })
    },
    responses: { 200: json(z.array(OrderSchema)), ...errorResponses(401) }
  }),
  async c => {
    const user = requireUser(c)
    const { page, perPage, order, outstanding } = c.req.valid('query')
    const filter: Record<string, unknown> = { userId: user._id }
    if (outstanding) {
      const futureCamps = await Camps.find({ to: { $gte: new Date() } }, { _id: 1 }).lean()
      filter.status = { $in: ['open', 'deposited'] }
      filter.campId = { $in: futureCamps.map(c => c._id) }
    }
    const orderIds = ((await Registrations.distinct('orderId', filter)) as (string | null)[])
      .filter((id): id is string => !!id)
      .sort()
    if (order === 'desc') orderIds.reverse()
    const pageIds = orderIds.slice(page * perPage, page * perPage + perPage)
    c.header('X-Total-Count', String(orderIds.length))
    if (!pageIds.length) return c.json([], 200)

    const regs = (await Registrations.find({ orderId: { $in: pageIds }, userId: user._id }).lean()) as RegistrationLike[]
    const fresh = await Users.findById(user._id, { credit: 1 }).lean()
    const orders = await serializeOrders(regs, await getSettings(), fresh?.credit ?? 0)
    const byId = new Map(orders.map(o => [o.id, o]))
    return c.json(pageIds.map(id => byId.get(id)!).filter(Boolean), 200)
  }
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['Orders'],
    summary: 'Checkout: create registrations and optionally start payment',
    description:
      'Validates everything before writing: students must be the caller\'s, camps bookable and of ' +
      'one organization, camp options filled in, no duplicates. Store credit is applied first; ' +
      '`payUrl` is null when credit covers everything or `payNow` is false.',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              registrations: z
                .array(
                  z.object({
                    campId: ObjectIdParam,
                    studentId: ObjectIdParam,
                    gadgets: z.array(z.string().max(100)).max(2).optional(),
                    tshirtSize: z.string().max(20).optional(),
                    shortSize: z.string().max(20).optional(),
                    shoeSize: z.number().min(0).max(60).optional()
                  })
                )
                .min(1)
                .max(20),
              payNow: z.boolean().default(false),
              deposit: z.boolean().default(false),
              tracking: tracking.optional()
            })
          }
        }
      }
    },
    responses: { 201: json(CheckoutResult, 'Order created'), ...errorResponses(400, 401, 404, 409, 502) }
  }),
  async c => {
    const user = requireUser(c)
    const { orderId, payUrl, credit } = await createOrder(user, c.req.valid('json'))
    return c.json({ order: await loadOrder(user, orderId), payUrl, credit }, 201)
  }
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/{orderId}',
    tags: ['Orders'],
    summary: 'Single own order',
    request: { params: OrderIdParams },
    responses: { 200: json(OrderSchema), ...errorResponses(401, 404) }
  }),
  async c => {
    const user = requireUser(c)
    return c.json(await loadOrder(user, c.req.valid('param').orderId), 200)
  }
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/{orderId}/payment',
    tags: ['Orders'],
    summary: '(Re)start payment for an outstanding order',
    description:
      'Reuses the checkout URL of a still-open Mollie payment for this order instead of creating ' +
      'a second one. `409 PAYMENT_PENDING` while a payment is being processed, `409 NOTHING_TO_PAY` ' +
      'when the order is settled.',
    request: { params: OrderIdParams },
    responses: { 200: json(CheckoutResult), ...errorResponses(401, 404, 409, 502) }
  }),
  async c => {
    const user = requireUser(c)
    const { orderId } = c.req.valid('param')
    const { payUrl, credit } = await payOrder(user, orderId)
    return c.json({ order: await loadOrder(user, orderId), payUrl, credit }, 200)
  }
)

export default app
