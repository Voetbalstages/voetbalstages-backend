import { createRoute, z } from '@hono/zod-openapi'
import { Camps, Locations, Organizations, getSettings } from '../db/models/index.js'
import { router } from '../lib/router.js'
import { badRequest, conflict, notFound } from '../lib/errors.js'
import { escapeRegex } from '../lib/ids.js'
import { yearRange } from '../lib/dates.js'
import {
  CampSchema,
  IdParams,
  LocationSchema,
  ObjectIdParam,
  PaginationQuery,
  booleanQuery,
  errorResponses,
  idListQuery,
  json
} from '../schemas.js'
import { serializeCamps, serializeLocations } from '../serializers/index.js'
import { AddressInput, SLUG, visibilities } from '../lib/validation.js'
import { optionalStaff, requireAdmin, visibleTo } from '../auth/staff.js'
import { PUBLIC_BASE } from '../services/storage.js'
import { logActivity } from '../services/activity.js'

const app = router()

const visible = { visibility: { $ne: 'HIDDEN' } }

const LocationBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    path: z.string().regex(SLUG).max(60),
    organizationId: ObjectIdParam,
    address: AddressInput,
    extInfo: z.string().max(500),
    message: z.string().max(5000),
    visibility: z.enum(visibilities),
    logo: z
      .object({
        uri: z.url().max(500).refine(u => u.startsWith(PUBLIC_BASE), 'Upload the file with POST /uploads/logo first'),
        name: z.string().max(200)
      })
      .nullable()
  })
  .strict()
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { 'application/json': { schema } } } })
const pathTaken = async (path: string, exceptId?: string) =>
  !!(await Locations.exists({ path, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }))

app.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['Locations'],
    summary: 'Locations',
    description:
      'Sets `X-Total-Count`. `HIDDEN` locations are only returned to staff (ADMIN: all, MANAGER: own ' +
      'organizations); everyone else gets `VISIBLE` and `AUTO`.',
    request: {
      query: PaginationQuery.extend({
        visibility: z.enum(visibilities).optional(),
        ids: idListQuery,
        organizationId: ObjectIdParam.optional(),
        q: z.string().max(100).optional(),
        sort: z.enum(['name', 'path']).default('name')
      })
    },
    responses: { 200: json(z.array(LocationSchema)) }
  }),
  async c => {
    const { page, perPage, sort, order, visibility, organizationId, q } = c.req.valid('query')
    const { ids } = c.req.valid('query')
    const filter: Record<string, unknown> = { $and: [visibleTo(optionalStaff(c), visible)] }
    if (visibility) filter.visibility = visibility
    if (ids) filter._id = { $in: ids }
    if (organizationId) filter.organizationId = organizationId
    if (q) {
      const rx = { $regex: escapeRegex(q), $options: 'i' }
      filter.$or = [{ name: rx }, { 'address.city': rx }, { 'address.postcode': rx }]
    }
    const [total, locations] = await Promise.all([
      Locations.countDocuments(filter),
      Locations.find(filter)
        .sort({ [sort]: order === 'asc' ? 1 : -1, _id: 1 })
        .skip(page * perPage)
        .limit(perPage)
        .lean()
    ])
    c.header('X-Total-Count', String(total))
    return c.json(await serializeLocations(locations), 200)
  }
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/by-path/{path}',
    tags: ['Locations'],
    summary: 'Location by URL slug',
    request: { params: z.object({ path: z.string().max(200) }) },
    responses: { 200: json(LocationSchema), ...errorResponses(404) }
  }),
  async c => {
    const location = await Locations.findOne({
      $and: [{ path: c.req.valid('param').path }, visibleTo(optionalStaff(c), visible)]
    }).lean()
    if (!location) throw notFound('Location')
    const [json] = await serializeLocations([location])
    return c.json(json!, 200)
  }
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/{id}',
    tags: ['Locations'],
    summary: 'Location by id',
    request: { params: IdParams },
    responses: { 200: json(LocationSchema), ...errorResponses(404) }
  }),
  async c => {
    const location = await Locations.findOne({
      $and: [{ _id: c.req.valid('param').id }, visibleTo(optionalStaff(c), visible)]
    }).lean()
    if (!location) throw notFound('Location')
    const [json] = await serializeLocations([location])
    return c.json(json!, 200)
  }
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/{id}/camps',
    tags: ['Locations'],
    summary: 'Camps at this location',
    request: {
      params: IdParams,
      query: z.object({
        year: z.coerce.number().int().min(2000).max(2100).optional(),
        excludePast: booleanQuery,
        period: z.string().max(100).optional()
      })
    },
    responses: { 200: json(z.array(CampSchema)), ...errorResponses(404) }
  }),
  async c => {
    const { id } = c.req.valid('param')
    const { year, excludePast, period } = c.req.valid('query')
    const staff = optionalStaff(c)
    const location = await Locations.exists({ $and: [{ _id: id }, visibleTo(staff, visible)] })
    if (!location) throw notFound('Location')
    const from: Record<string, Date> = year ? yearRange(year) : {}
    if (excludePast) from.$gte = new Date(Math.max(Date.now(), from.$gte?.getTime() ?? 0))
    const filter: Record<string, unknown> = { locationId: id, ...visibleTo(staff, { status: { $ne: 'HIDDEN' } }) }
    if (Object.keys(from).length) filter.from = from
    if (period) filter.period = period
    const [camps, settings] = await Promise.all([
      Camps.find(filter).sort({ from: 1 }).lean(),
      getSettings()
    ])
    return c.json(await serializeCamps(camps, settings), 200)
  }
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['Locations'],
    summary: 'Create a location',
    description:
      '**Requires: ADMIN.** `name`, `path` and `organizationId` are required; the organization ' +
      'decides the organization of the location\'s camps. `visibility` defaults to `HIDDEN`.',
    request: body(LocationBody.partial({ address: true, extInfo: true, message: true, visibility: true, logo: true })),
    responses: { 201: json(LocationSchema, 'Created'), ...errorResponses(400, 401, 403, 409) }
  }),
  async c => {
    const { user } = requireAdmin(c)
    const data = c.req.valid('json')
    if (!data.name || !data.path || !data.organizationId) {
      throw badRequest('VALIDATION_ERROR', 'name, path and organizationId are required')
    }
    if (!(await Organizations.exists({ _id: data.organizationId }))) throw badRequest('UNKNOWN_ORGANIZATION', 'Organization not found')
    if (await pathTaken(data.path)) throw conflict('PATH_TAKEN', 'Another location uses this path')
    const loc = await Locations.create({ visibility: 'HIDDEN', ...data })
    logActivity(user._id, 'LOCATION')
    return c.json((await serializeLocations([loc.toObject()]))[0]!, 201)
  }
)

app.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}',
    tags: ['Locations'],
    summary: 'Update a location',
    description:
      '**Requires: ADMIN.** `address` is replaced as a whole when sent. Locations cannot be deleted. ' +
      'Changing the organization is refused with `409 HAS_CAMPS` once the location has camps.',
    request: { params: IdParams, ...body(LocationBody.partial()) },
    responses: { 200: json(LocationSchema), ...errorResponses(400, 401, 403, 404, 409) }
  }),
  async c => {
    const { user } = requireAdmin(c)
    const { id } = c.req.valid('param')
    const data = c.req.valid('json')
    const current = await Locations.findById(id).lean()
    if (!current) throw notFound('Location')
    if (data.path && (await pathTaken(data.path, id))) throw conflict('PATH_TAKEN', 'Another location uses this path')
    if (data.organizationId && String(current.organizationId) !== data.organizationId) {
      if (!(await Organizations.exists({ _id: data.organizationId }))) throw badRequest('UNKNOWN_ORGANIZATION', 'Organization not found')
      if (await Camps.exists({ locationId: id })) throw conflict('HAS_CAMPS', 'Location already has camps')
    }
    const loc = await Locations.findOneAndUpdate({ _id: id }, { $set: data }, { new: true }).lean()
    logActivity(user._id, 'LOCATION')
    return c.json((await serializeLocations([loc!]))[0]!, 200)
  }
)

export default app
