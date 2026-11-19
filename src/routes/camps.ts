import { createRoute, z } from '@hono/zod-openapi'
import { Camps, Locations, Registrations, Students, getSettings, ACTIVE, campOptions, registrationStatuses } from '../db/models/index.js'
import { router } from '../lib/router.js'
import { badRequest, conflict, notFound } from '../lib/errors.js'
import { toCsv } from '../lib/csv.js'
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
import { optionalStaff, requireAdmin, requireStaff, visibleTo, inScope } from '../auth/staff.js'
import { logActivity } from '../services/activity.js'
import {
  serializeCamps,
  serializeRegistrations,
  serializeStudents,
  type RegistrationLike
} from '../serializers/index.js'

const app = router()

const notHidden = { status: { $ne: 'HIDDEN' } }

const date = z.union([z.iso.datetime(), z.iso.date()])
/** Camps always run 11:00 UTC (old pre-validate hook). */
const at11 = (d: string) => {
  const x = new Date(d)
  x.setUTCHours(11, 0, 0, 0)
  return x
}
const CampBody = z
  .object({
    locationId: ObjectIdParam,
    name: z.string().trim().max(100),
    from: date,
    to: date,
    period: z.string().trim().min(1).max(100),
    cost: z.number().min(0),
    deposit: z.number().min(0).nullable(),
    earlyBirdToInc: date.nullable(),
    status: z.enum(['OPEN', 'CANCELED', 'HIDDEN']),
    options: z.array(z.enum(campOptions)).max(4)
  })
  .strict()
const checkMoney = (cost: number | null | undefined, deposit: number | null | undefined) => {
  if (deposit && cost != null && deposit > cost) throw badRequest('DEPOSIT_TOO_HIGH', 'Deposit cannot exceed the price')
}
const checkDates = (from?: Date | null, to?: Date | null) => {
  if (from && to && to < from) throw badRequest('INVALID_DATES', '`to` must not be before `from`')
}
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { 'application/json': { schema } } } })
const REG_STATUS = z.enum(registrationStatuses)

app.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['Camps'],
    summary: 'List / filter camps',
    description:
      'Sets `X-Total-Count`. `HIDDEN` camps are only returned to staff (ADMIN: all, MANAGER: own ' +
      'organizations). `status` filters on the stored status.',
    request: {
      query: PaginationQuery.extend({
        locationId: ObjectIdParam.optional(),
        organizationId: ObjectIdParam.optional(),
        period: z.string().max(100).optional(),
        year: z.coerce.number().int().min(2000).max(2100).optional(),
        excludePast: booleanQuery,
        ids: idListQuery,
        q: z.string().max(100).optional(),
        status: z.enum(['OPEN', 'CANCELED', 'HIDDEN']).optional(),
        sort: z.enum(['from', 'period', 'name', 'cost']).default('period')
      })
    },
    responses: { 200: json(z.array(CampSchema)) }
  }),
  async c => {
    const q = c.req.valid('query')
    const staff = optionalStaff(c)
    const filter: Record<string, unknown> = { $and: [visibleTo(staff, notHidden)] }
    if (q.status) filter.status = q.status
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
    const camp = await Camps.findOne({
      $and: [{ _id: c.req.valid('param').id }, visibleTo(optionalStaff(c), notHidden)]
    }).lean()
    if (!camp) throw notFound('Camp')
    const [json] = await serializeCamps([camp], await getSettings())
    return c.json(json!, 200)
  }
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['Camps'],
    summary: 'Create a camp',
    description:
      '**Requires: ADMIN.** `locationId`, `from`, `to`, `period` and `cost` are required. The ' +
      'organization is taken from the location. Dates are stored at 11:00 UTC. An empty/0 `deposit` ' +
      'means no deposit payment.',
    request: body(CampBody.partial({ name: true, deposit: true, earlyBirdToInc: true, status: true, options: true })),
    responses: { 201: json(CampSchema, 'Created'), ...errorResponses(400, 401, 403) }
  }),
  async c => {
    const { user } = requireAdmin(c)
    const d = c.req.valid('json')
    if (!d.locationId || !d.from || !d.to || !d.period || d.cost == null) {
      throw badRequest('VALIDATION_ERROR', 'locationId, from, to, period and cost are required')
    }
    const location = await Locations.findById(d.locationId).lean()
    if (!location?.organizationId) throw badRequest('UNKNOWN_LOCATION', 'Location not found or without organization')
    const from = at11(d.from)
    const to = at11(d.to)
    checkDates(from, to)
    checkMoney(d.cost, d.deposit)
    const camp = await Camps.create({
      ...d,
      from,
      to,
      earlyBirdToInc: d.earlyBirdToInc ? new Date(d.earlyBirdToInc) : undefined,
      organizationId: location.organizationId
    })
    logActivity(user._id, 'CAMP')
    return c.json((await serializeCamps([camp.toObject()], await getSettings()))[0]!, 201)
  }
)

app.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}',
    tags: ['Camps'],
    summary: 'Update a camp',
    description:
      '**Requires: ADMIN.** A price change applies to every registration that is not fully paid. ' +
      'Setting `status` to `CANCELED` does **not** cancel registrations. Moving to a location of ' +
      'another organization is refused with `409 HAS_REGISTRATIONS` once registrations exist. ' +
      'Camps cannot be deleted.',
    request: { params: IdParams, ...body(CampBody.partial()) },
    responses: { 200: json(CampSchema), ...errorResponses(400, 401, 403, 404, 409) }
  }),
  async c => {
    const { user } = requireAdmin(c)
    const { id } = c.req.valid('param')
    const d = c.req.valid('json')
    const current = await Camps.findById(id).lean()
    if (!current) throw notFound('Camp')
    const $set: Record<string, unknown> = { ...d }
    const $unset: Record<string, 1> = {}
    if (d.from) $set.from = at11(d.from)
    if (d.to) $set.to = at11(d.to)
    if (d.earlyBirdToInc !== undefined) {
      if (d.earlyBirdToInc) $set.earlyBirdToInc = new Date(d.earlyBirdToInc)
      else {
        delete $set.earlyBirdToInc
        $unset.earlyBirdToInc = 1
      }
    }
    checkDates((($set.from as Date) ?? current.from) as Date, (($set.to as Date) ?? current.to) as Date)
    checkMoney(d.cost ?? current.cost, d.deposit === undefined ? current.deposit : d.deposit)
    if (d.locationId && d.locationId !== String(current.locationId)) {
      const location = await Locations.findById(d.locationId).lean()
      if (!location?.organizationId) throw badRequest('UNKNOWN_LOCATION', 'Location not found or without organization')
      if (String(location.organizationId) !== String(current.organizationId)) {
        if (await Registrations.exists({ campId: id })) throw conflict('HAS_REGISTRATIONS', 'Camp already has registrations')
        $set.organizationId = location.organizationId
      }
    }
    const camp = await Camps.findOneAndUpdate(
      { _id: id },
      { $set, ...(Object.keys($unset).length && { $unset }) },
      { new: true }
    ).lean()
    logActivity(user._id, 'CAMP')
    return c.json((await serializeCamps([camp!], await getSettings()))[0]!, 200)
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

const campRegistrations = async (c: any, id: string, status?: string) => {
  const user = c.get('user')
  if (!user) return null
  const staff = optionalStaff(c)
  if (staff) {
    const camp = await Camps.findOne({ _id: id }).lean()
    if (!camp || !inScope(staff, camp.organizationId)) throw notFound('Camp')
    return (await Registrations.find({ campId: id, ...(status && { status }) }).sort({ createdAt: 1 }).lean()) as RegistrationLike[]
  }
  return (await Registrations.find({ campId: id, userId: user._id, ...(status && { status }) })
    .sort({ createdAt: 1 })
    .lean()) as RegistrationLike[]
}

app.openapi(
  createRoute({
    method: 'get',
    path: '/{id}/registrations',
    tags: ['Camps'],
    summary: 'Registrations for this camp',
    description:
      'Parents: their own registrations for the camp. **Staff (ADMIN, or MANAGER of the camp\'s ' +
      'organization): every parent\'s registration, every status** (optional `status`), not ' +
      'paginated. Returns `[]` when not logged in.',
    request: { params: IdParams, query: z.object({ status: REG_STATUS.optional() }) },
    responses: { 200: json(z.array(RegistrationSchema)), ...errorResponses(404) }
  }),
  async c => {
    const regs = await campRegistrations(c, c.req.valid('param').id, c.req.valid('query').status)
    if (!regs) return c.json([], 200)
    c.header('X-Total-Count', String(regs.length))
    return c.json(await serializeRegistrations(regs, await getSettings()), 200)
  }
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/{id}/registrations/export',
    tags: ['Camps'],
    summary: 'Camp attendance list as CSV',
    description:
      '**Requires: staff (ADMIN, or MANAGER of the camp\'s organization).** `;` separated, same ' +
      'columns as the old admin download. Includes canceled and refunded registrations: filter on ' +
      '`status` or on the status column. Responds `text/csv`.',
    request: { params: IdParams, query: z.object({ status: REG_STATUS.optional() }) },
    responses: { 200: { description: 'CSV file', content: { 'text/csv': { schema: z.string() } } }, ...errorResponses(401, 403, 404) }
  }),
  async c => {
    requireStaff(c)
    const { id } = c.req.valid('param')
    const regs = (await campRegistrations(c, id, c.req.valid('query').status)) ?? []
    const rows = await serializeRegistrations(regs, await getSettings())
    const headers = [
      'naam kind', 'geboortedatum', 'naam ouder', 'telefoon ouder(s)', 'emailadres ouder 1', 'emailadres ouder 2',
      'huidige club', 'maat t-shirt', 'maat short', 'maat schoenen', 'gadgets', 'opmerkingen', 'speciale eter',
      'order #', 'status', 'bedrag betaald'
    ]
    const csv = toCsv(
      headers,
      rows.map(r => ({
        'naam kind': r.student?.name,
        geboortedatum: r.student?.dob,
        'naam ouder': r.user?.fullName,
        'telefoon ouder(s)': r.user?.telephone.join(' '),
        'emailadres ouder 1': r.user?.email,
        'emailadres ouder 2': r.user?.secondEmail,
        'huidige club': r.student?.currentClub,
        'maat t-shirt': r.tshirtSize,
        'maat short': r.shortSize,
        'maat schoenen': r.shoeSize,
        gadgets: r.gadgets.join(' '),
        opmerkingen: r.student?.remarks,
        'speciale eter': [...(r.student?.food ?? []), r.student?.foodOther].filter(Boolean).join(' '),
        'order #': r.orderId,
        status: r.status,
        'bedrag betaald': r.paid.toFixed(2)
      })),
      ';'
    )
    c.header('Content-Type', 'text/csv; charset=utf-8')
    c.header('Content-Disposition', `attachment; filename="inschrijvingen-${id}.csv"`)
    return c.body(csv, 200)
  }
)

export default app
