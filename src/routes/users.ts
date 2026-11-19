import { createRoute, z } from '@hono/zod-openapi'
import { Organizations, Students, Users } from '../db/models/index.js'
import { router } from '../lib/router.js'
import { conflict, notFound } from '../lib/errors.js'
import { escapeRegex } from '../lib/ids.js'
import { AddressInput } from '../lib/validation.js'
import { IdParams, ObjectIdParam, OrganizationSchema, PaginationQuery, StudentSchema, UserSchema, errorResponses, idListQuery, json } from '../schemas.js'
import { requireAdmin, requireStaff } from '../auth/staff.js'
import { normalizeEmail } from '../auth/magicLink.js'
import { serializeOrganization, serializeStudents, serializeUser } from '../serializers/index.js'
import { exportUsersCsv } from '../services/exports.js'
import { logActivity } from '../services/activity.js'

const Filters = z.object({
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  email: z.string().max(254).optional(),
  postcode: z.string().max(20).optional(),
  role: z.enum(['ADMIN', 'MANAGER']).optional(),
  q: z.string().max(100).optional(),
  ids: idListQuery
})

const buildFilter = (f: z.infer<typeof Filters>) => {
  const rx = (v: string) => ({ $regex: escapeRegex(v), $options: 'i' })
  const filter: Record<string, unknown> = {}
  if (f.firstName) filter.firstName = rx(f.firstName)
  if (f.lastName) filter.lastName = rx(f.lastName)
  if (f.email) filter.email = rx(f.email)
  if (f.postcode) filter['address.postcode'] = rx(f.postcode)
  if (f.role) filter.role = f.role
  if (f.ids) filter._id = { $in: f.ids }
  if (f.q) filter.$or = ['firstName', 'lastName', 'email'].map(k => ({ [k]: rx(f.q!) }))
  return filter
}

const Patch = z
  .object({
    firstName: z.string().trim().max(100),
    lastName: z.string().trim().max(100),
    email: z.email().max(254),
    secondEmail: z.union([z.email().max(254), z.literal('')]),
    telephone: z.array(z.string().trim().max(30)).max(5),
    address: AddressInput,
    credit: z.number().min(0).max(100_000),
    role: z.enum(['ADMIN', 'MANAGER']).nullable(),
    organizationIds: z.array(ObjectIdParam).max(50)
  })
  .strict()

const TAG = ['Users']
const app = router()

app.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: TAG,
    summary: 'search users (parents, managers, admins)',
    description:
      'Like the old admin, managers can list all users and children (not limited to their ' +
      'organizations). Sets `X-Total-Count`.',
    request: {
      query: PaginationQuery.merge(Filters).extend({
        sort: z.enum(['createdAt', 'firstName', 'lastName', 'email', 'credit']).default('createdAt')
      })
    },
    responses: { 200: json(z.array(UserSchema)), ...errorResponses(401, 403) }
  }),
  async c => {
    requireStaff(c)
    const { page, perPage, sort, order, ...f } = c.req.valid('query')
    const filter = buildFilter(f)
    const [total, users] = await Promise.all([
      Users.countDocuments(filter),
      Users.find(filter)
        .sort({ [sort]: order === 'asc' ? 1 : -1, _id: 1 })
        .skip(page * perPage)
        .limit(perPage)
        .lean()
    ])
    c.header('X-Total-Count', String(total))
    return c.json(users.map(serializeUser), 200)
  }
)

// Declared before `/{id}` so "export" is not read as an id.
app.openapi(
  createRoute({
    method: 'get',
    path: '/export',
    tags: TAG,
    summary: 'users as CSV for email marketing',
    description: '**Requires: staff.** Takes the same filters as the list (no paging). Responds `text/csv`.',
    request: { query: Filters },
    responses: { 200: { description: 'CSV file', content: { 'text/csv': { schema: z.string() } } }, ...errorResponses(401, 403) }
  }),
  async c => {
    requireStaff(c)
    const { csv } = await exportUsersCsv(buildFilter(c.req.valid('query')))
    c.header('Content-Type', 'text/csv; charset=utf-8')
    c.header('Content-Disposition', `attachment; filename="users-export-${new Date().toISOString().slice(0, 10)}.csv"`)
    return c.body(csv, 200)
  }
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/{id}',
    tags: TAG,
    summary: 'One user with their children and organizations',
    description: '**Requires: staff.** Parents use `/me`.',
    request: { params: IdParams },
    responses: {
      200: json(UserSchema.extend({ students: z.array(StudentSchema), organizations: z.array(OrganizationSchema) })),
      ...errorResponses(401, 403, 404)
    }
  }),
  async c => {
    requireStaff(c)
    const user = await Users.findById(c.req.valid('param').id).lean()
    if (!user) throw notFound('User')
    const [students, orgs] = await Promise.all([
      Students.find({ ownerId: user._id }).sort({ createdAt: 1 }).lean(),
      Organizations.find(user.role === 'ADMIN' ? {} : { _id: { $in: user.organizationIds ?? [] } }).lean()
    ])
    return c.json(
      {
        ...serializeUser(user),
        students: await serializeStudents(students),
        organizations: orgs.map(o => serializeOrganization(o, true))
      },
      200
    )
  }
)

app.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}',
    tags: TAG,
    summary: 'Edit a user, incl. store credit and role',
    description:
      '**Requires: ADMIN.** `credit` is set to an absolute amount (not added). `role: MANAGER` needs at least one ' +
      '`organizationIds`; `role: null` makes the user a plain parent. You cannot remove your own admin ' +
      'role. Users cannot be created or deleted here.',
    request: { params: IdParams, body: { content: { 'application/json': { schema: Patch.partial() } } } },
    responses: { 200: json(UserSchema), ...errorResponses(400, 401, 403, 404, 409) }
  }),
  async c => {
    const { user: actor } = requireAdmin(c)
    const { id } = c.req.valid('param')
    const data = c.req.valid('json')
    const current = await Users.findById(id).lean()
    if (!current) throw notFound('User')
    const role = data.role === undefined ? current.role : data.role
    const orgs = data.organizationIds ?? current.organizationIds ?? []
    if (role === 'MANAGER' && !orgs.length) throw conflict('MANAGER_NEEDS_ORGANIZATION', 'A manager needs at least one organization')
    if (String(actor._id) === id && role !== 'ADMIN') throw conflict('CANNOT_DEMOTE_SELF', 'You cannot remove your own admin role')
    const $set: Record<string, unknown> = { ...data }
    const $unset: Record<string, 1> = {}
    if (data.email) $set.email = normalizeEmail(data.email)
    if (data.role === null) {
      delete $set.role
      $unset.role = 1
    }
    const updated = await Users.findOneAndUpdate(
      { _id: id },
      { $set, ...(Object.keys($unset).length && { $unset }) },
      { new: true }
    ).lean()
    logActivity(actor._id, 'USER')
    return c.json(serializeUser(updated!), 200)
  }
)

export default app
