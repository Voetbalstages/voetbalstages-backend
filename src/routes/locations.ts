import { createRoute, z } from '@hono/zod-openapi'
import { Camps, Locations, getSettings } from '../db/models/index.js'
import { router } from '../lib/router.js'
import { notFound } from '../lib/errors.js'
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
  json
} from '../schemas.js'
import { serializeCamps, serializeLocations } from '../serializers/index.js'

const app = router()

const visible = { visibility: { $ne: 'HIDDEN' } }

app.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['Locations'],
    summary: 'Visible locations',
    description: 'Sets `X-Total-Count`. Hidden locations are never returned.',
    request: {
      query: PaginationQuery.extend({
        visibility: z.enum(['VISIBLE', 'AUTO']).optional(),
        organizationId: ObjectIdParam.optional(),
        q: z.string().max(100).optional(),
        sort: z.enum(['name', 'path']).default('name')
      })
    },
    responses: { 200: json(z.array(LocationSchema)) }
  }),
  async c => {
    const { page, perPage, sort, order, visibility, organizationId, q } = c.req.valid('query')
    const filter: Record<string, unknown> = visibility ? { visibility } : { ...visible }
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
    const location = await Locations.findOne({ path: c.req.valid('param').path, ...visible }).lean()
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
    const location = await Locations.findOne({ _id: c.req.valid('param').id, ...visible }).lean()
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
    const location = await Locations.exists({ _id: id, ...visible })
    if (!location) throw notFound('Location')
    const from: Record<string, Date> = year ? yearRange(year) : {}
    if (excludePast) from.$gte = new Date(Math.max(Date.now(), from.$gte?.getTime() ?? 0))
    const filter: Record<string, unknown> = { locationId: id, status: { $ne: 'HIDDEN' } }
    if (Object.keys(from).length) filter.from = from
    if (period) filter.period = period
    const [camps, settings] = await Promise.all([
      Camps.find(filter).sort({ from: 1 }).lean(),
      getSettings()
    ])
    return c.json(await serializeCamps(camps, settings), 200)
  }
)

export default app
