import { createRoute, z } from '@hono/zod-openapi'
import { Organizations } from '../db/models/index.js'
import { router } from '../lib/router.js'
import { notFound } from '../lib/errors.js'
import { IdParams, OrganizationSchema, PaginationQuery, errorResponses, json } from '../schemas.js'
import { serializeOrganization } from '../serializers/index.js'
import { SLUG } from '../lib/validation.js'
import { conflict } from '../lib/errors.js'
import { escapeRegex } from '../lib/ids.js'
import { inScope, optionalStaff, requireAdmin } from '../auth/staff.js'
import { logActivity } from '../services/activity.js'

const app = router()

const OrgBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    path: z.string().regex(SLUG).max(60),
    mollieProfileId: z.string().regex(/^pfl_[A-Za-z0-9]+$/, 'Expected a Mollie profile id like pfl_xxxxxxxx'),
    terms: z.string().max(200_000)
  })
  .strict()
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { 'application/json': { schema } } } })
const pathTaken = async (path: string, exceptId?: string) =>
  !!(await Organizations.exists({
    path: { $regex: `^${escapeRegex(path)}$`, $options: 'i' },
    ...(exceptId ? { _id: { $ne: exceptId } } : {})
  }))
const show = (c: Parameters<typeof optionalStaff>[0], org: Parameters<typeof serializeOrganization>[0]) =>
  serializeOrganization(org, inScope(optionalStaff(c), org._id))
const TermsSchema = z.object({ terms: z.string() }).openapi('Terms')
const PathParams = z.object({ path: z.string().regex(/^[a-zA-Z0-9-]+$/).max(100) })

app.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['Organizations'],
    summary: 'List organizations',
    description: 'Public. Staff (ADMIN, or MANAGER of the organization) additionally get `mollieProfileId` and `terms`. Sets `X-Total-Count`.',
    request: { query: PaginationQuery.extend({ sort: z.enum(['name', 'path']).default('name') }) },
    responses: { 200: json(z.array(OrganizationSchema)) }
  }),
  async c => {
    const q = c.req.valid('query')
    const [total, orgs] = await Promise.all([
      Organizations.countDocuments({}),
      Organizations.find({})
        .sort({ [q.sort]: q.order === 'asc' ? 1 : -1, _id: 1 })
        .skip(q.page * q.perPage)
        .limit(q.perPage)
        .lean()
    ])
    c.header('X-Total-Count', String(total))
    return c.json(orgs.map(o => show(c, o)), 200)
  }
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/by-path/{path}',
    tags: ['Organizations'],
    summary: 'Organization by slug',
    description: 'Staff additionally get `mollieProfileId` and `terms`.',
    request: { params: PathParams },
    responses: { 200: json(OrganizationSchema), ...errorResponses(404) }
  }),
  async c => {
    const org = await Organizations.findOne({ path: c.req.valid('param').path }).lean()
    if (!org) throw notFound('Organization')
    return c.json(show(c, org), 200)
  }
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/{id}',
    tags: ['Organizations'],
    summary: 'Organization by id',
    description: 'Staff (ADMIN, or MANAGER of this organization) additionally get `mollieProfileId` and `terms`.',
    request: { params: IdParams },
    responses: { 200: json(OrganizationSchema), ...errorResponses(404) }
  }),
  async c => {
    const org = await Organizations.findById(c.req.valid('param').id).lean()
    if (!org) throw notFound('Organization')
    return c.json(show(c, org), 200)
  }
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/{path}/terms',
    tags: ['Organizations'],
    summary: 'Organization-specific terms (HTML)',
    request: { params: PathParams },
    responses: { 200: json(TermsSchema), ...errorResponses(404) }
  }),
  async c => {
    const org = await Organizations.findOne({ path: c.req.valid('param').path }, { terms: 1 }).lean()
    if (!org) throw notFound('Organization')
    return c.json({ terms: org.terms ?? '' }, 200)
  }
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['Organizations'],
    summary: 'Create an organization',
    description: '**Requires: ADMIN.** `mollieProfileId` must look like `pfl_xxxx`; `path` is a unique lowercase slug.',
    request: body(OrgBody),
    responses: { 201: json(OrganizationSchema, 'Created'), ...errorResponses(400, 401, 403, 409) }
  }),
  async c => {
    const { user } = requireAdmin(c)
    const data = c.req.valid('json')
    if (await pathTaken(data.path)) throw conflict('PATH_TAKEN', 'Another organization uses this path')
    const org = await Organizations.create(data)
    logActivity(user._id, 'ORGANIZATION')
    return c.json(serializeOrganization(org.toObject(), true), 201)
  }
)

app.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}',
    tags: ['Organizations'],
    summary: 'Update an organization',
    description: '**Requires: ADMIN.** Organizations cannot be deleted.',
    request: { params: IdParams, ...body(OrgBody.partial()) },
    responses: { 200: json(OrganizationSchema), ...errorResponses(400, 401, 403, 404, 409) }
  }),
  async c => {
    const { user } = requireAdmin(c)
    const { id } = c.req.valid('param')
    const data = c.req.valid('json')
    if (data.path && (await pathTaken(data.path, id))) throw conflict('PATH_TAKEN', 'Another organization uses this path')
    const org = await Organizations.findOneAndUpdate({ _id: id }, { $set: data }, { new: true }).lean()
    if (!org) throw notFound('Organization')
    logActivity(user._id, 'ORGANIZATION')
    return c.json(serializeOrganization(org, true), 200)
  }
)

export default app
