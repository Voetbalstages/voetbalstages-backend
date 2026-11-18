import { createRoute, z } from '@hono/zod-openapi'
import { Camps, Registrations, Students, getSettings, ACTIVE } from '../db/models/index.js'
import { router } from '../lib/router.js'
import { notFound } from '../lib/errors.js'
import { escapeRegex } from '../lib/ids.js'
import { yearRange } from '../lib/dates.js'
import {
  CampSchema,
  IdParams,
  ObjectIdParam,
  PaginationQuery,
  RegistrationSchema,
  StudentSchema,
  booleanQuery,
  errorResponses,
  idListQuery,
  json
} from '../schemas.js'
import {
  serializeCamps,
  serializeRegistrations,
  serializeStudents,
  type RegistrationLike
} from '../serializers/index.js'

const app = router()

const notHidden = { status: { $ne: 'HIDDEN' } }

app.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['Camps'],
    summary: 'List / filter camps',
    description: 'Sets `X-Total-Count`. Hidden camps are never returned.',
    request: {
      query: PaginationQuery.extend({
        locationId: ObjectIdParam.optional(),
        organizationId: ObjectIdParam.optional(),
        period: z.string().max(100).optional(),
        year: z.coerce.number().int().min(2000).max(2100).optional(),
        excludePast: booleanQuery,
        ids: idListQuery,
        q: z.string().max(100).optional(),
        sort: z.enum(['from', 'period', 'name']).default('period')
      })
    },
    responses: { 200: json(z.array(CampSchema)) }
  }),
  async c => {
    const q = c.req.valid('query')
    const filter: Record<string, unknown> = { ...notHidden }
    if (q.locationId) filter.locationId = q.locationId
    if (q.organizationId) filter.organizationId = q.organizationId
    if (q.period) filter.period = q.period
    if (q.ids) filter._id = { $in: q.ids }
    const from: Record<string, Date> = q.year ? yearRange(q.year) : {}
    if (q.excludePast) from.$gte = new Date(Math.max(Date.now(), from.$gte?.getTime() ?? 0))
    if (Object.keys(from).length) filter.from = from
    if (q.q) {
      const rx = { $regex: escapeRegex(q.q), $options: 'i' }
      filter.$or = [{ name: rx }, { period: rx }]
    }
    const [total, camps, settings] = await Promise.all([
      Camps.countDocuments(filter),
      Camps.find(filter)
        .sort({ [q.sort]: q.order === 'asc' ? 1 : -1, _id: 1 })
        .skip(q.page * q.perPage)
        .limit(q.perPage)
        .lean(),
      getSettings()
    ])
    c.header('X-Total-Count', String(total))
    return c.json(await serializeCamps(camps, settings), 200)
  }
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/available',
    tags: ['Camps'],
    summary: 'Bookable subset of the given camp ids (cart revalidation)',
    request: { query: z.object({ ids: idListQuery }) },
    responses: { 200: json(z.array(CampSchema)) }
  }),
  async c => {
    const { ids } = c.req.valid('query')
    if (!ids?.length) return c.json([], 200)
    const [camps, settings] = await Promise.all([
      Camps.find({ _id: { $in: ids }, status: 'OPEN', from: { $gt: new Date() } }).lean(),
      getSettings()
    ])
    return c.json(await serializeCamps(camps, settings), 200)
  }
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/{id}',
    tags: ['Camps'],
    summary: 'Single camp',
    request: { params: IdParams },
    responses: { 200: json(CampSchema), ...errorResponses(404) }
  }),
  async c => {
    const camp = await Camps.findOne({ _id: c.req.valid('param').id, ...notHidden }).lean()
    if (!camp) throw notFound('Camp')
    const [json] = await serializeCamps([camp], await getSettings())
    return c.json(json!, 200)
  }
)

/** Own students split by whether they hold an active registration for the camp. */
const studentsForCamp = async (userId: unknown, campId: string, registered: boolean) => {
  const students = await Students.find({ ownerId: userId }).sort({ createdAt: 1 }).lean()
  const regs = await Registrations.find(
    { campId, studentId: { $in: students.map(s => s._id) }, status: { $in: ACTIVE } },
    { studentId: 1 }
  ).lean()
  const booked = new Set(regs.map(r => String(r.studentId)))
  return serializeStudents(students.filter(s => booked.has(String(s._id)) === registered))
}

for (const [path, registered, summary] of [
  ['/{id}/available-students', false, 'Own students that can still be booked into this camp'],
  ['/{id}/registered-students', true, 'Own students already registered for this camp']
] as const) {
  app.openapi(
    createRoute({
      method: 'get',
      path,
      tags: ['Camps'],
      summary,
      description: 'Returns `[]` when not logged in.',
      request: { params: IdParams },
      responses: { 200: json(z.array(StudentSchema)) }
    }),
    async c => {
      const user = c.get('user')
      if (!user) return c.json([], 200)
      return c.json(await studentsForCamp(user._id, c.req.valid('param').id, registered), 200)
    }
  )
}

app.openapi(
  createRoute({
    method: 'get',
    path: '/{id}/registrations',
    tags: ['Camps'],
    summary: 'Own registrations for this camp',
    description: 'Returns `[]` when not logged in.',
    request: { params: IdParams },
    responses: { 200: json(z.array(RegistrationSchema)) }
  }),
  async c => {
    const user = c.get('user')
    if (!user) return c.json([], 200)
    const regs = (await Registrations.find({ campId: c.req.valid('param').id, userId: user._id })
      .sort({ createdAt: 1 })
      .lean()) as RegistrationLike[]
    return c.json(await serializeRegistrations(regs, await getSettings()), 200)
  }
)

export default app
