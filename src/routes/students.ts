import { createRoute, z } from '@hono/zod-openapi'
import { Students } from '../db/models/index.js'
import { router } from '../lib/router.js'
import { notFound } from '../lib/errors.js'
import { IdParams, ObjectIdParam, PaginationQuery, StudentSchema, errorResponses, idListQuery, json } from '../schemas.js'
import { escapeRegex } from '../lib/ids.js'
import { optionalStaff } from '../auth/staff.js'
import { serializeStudents } from '../serializers/index.js'
import { requireUser } from '../auth/session.js'
import { logActivity } from '../services/activity.js'

const StudentBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    dob: z.string().max(20),
    food: z.array(z.string().max(50)).max(10),
    foodOther: z.string().max(500),
    currentClub: z.string().max(100),
    remarks: z.string().max(2000)
  })
  .strict()

const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { 'application/json': { schema } } } })

const app = router()

/** Owners may touch their own children; staff may read all, ADMIN may also write. */
const access = (c: Parameters<typeof requireUser>[0], user: { _id: unknown }, write: boolean) => {
  const staff = optionalStaff(c)
  if (staff && (!write || staff.isAdmin)) return {}
  return { ownerId: user._id }
}

app.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['Students'],
    summary: 'Students',
    description:
      'Parents: their own children. **Staff (ADMIN/MANAGER): every child**, with the extra filters ' +
      '`name`, `ownerId`, `ids`. Sets `X-Total-Count`.',
    request: {
      query: PaginationQuery.extend({
        name: z.string().max(100).optional(),
        ownerId: ObjectIdParam.optional(),
        ids: idListQuery,
        sort: z.enum(['createdAt', 'name', 'dob']).default('createdAt')
      })
    },
    responses: { 200: json(z.array(StudentSchema)), ...errorResponses(401) }
  }),
  async c => {
    const user = requireUser(c)
    const { page, perPage, sort, order, name, ownerId, ids } = c.req.valid('query')
    const filter: Record<string, unknown> = optionalStaff(c) ? {} : { ownerId: user._id }
    if (name) filter.name = { $regex: escapeRegex(name), $options: 'i' }
    if (ownerId) filter.ownerId = ownerId
    if (ids) filter._id = { $in: ids }
    const [total, students] = await Promise.all([
      Students.countDocuments(filter),
      Students.find(filter)
        .sort({ [sort]: order === 'asc' ? 1 : -1, _id: 1 })
        .skip(page * perPage)
        .limit(perPage)
        .lean()
    ])
    c.header('X-Total-Count', String(total))
    return c.json(await serializeStudents(students), 200)
  }
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['Students'],
    summary: 'Create a student (caller becomes owner)',
    request: body(StudentBody.partial({ dob: true, food: true, foodOther: true, currentClub: true, remarks: true })),
    responses: { 201: json(StudentSchema, 'Created'), ...errorResponses(400, 401) }
  }),
  async c => {
    const user = requireUser(c)
    const doc = await Students.create({ ...c.req.valid('json'), ownerId: [user._id] })
    logActivity(user._id, 'STUDENT')
    const [student] = await serializeStudents([doc.toObject()])
    return c.json(student!, 201)
  }
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/{id}',
    tags: ['Students'],
    summary: 'Single student',
    description: 'Owner, or staff.',
    request: { params: IdParams },
    responses: { 200: json(StudentSchema), ...errorResponses(401, 404) }
  }),
  async c => {
    const user = requireUser(c)
    const student = await Students.findOne({ _id: c.req.valid('param').id, ...access(c, user, false) }).lean()
    if (!student) throw notFound('Student')
    const [json] = await serializeStudents([student])
    return c.json(json!, 200)
  }
)

app.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}',
    tags: ['Students'],
    summary: 'Update a student',
    description: 'The owner, or **ADMIN**. Managers are read-only.',
    request: { params: IdParams, ...body(StudentBody.partial()) },
    responses: { 200: json(StudentSchema), ...errorResponses(400, 401, 404) }
  }),
  async c => {
    const user = requireUser(c)
    const student = await Students.findOneAndUpdate(
      { _id: c.req.valid('param').id, ...access(c, user, true) },
      { $set: c.req.valid('json') },
      { new: true }
    ).lean()
    if (!student) throw notFound('Student')
    logActivity(user._id, 'STUDENT')
    const [json] = await serializeStudents([student])
    return c.json(json!, 200)
  }
)

app.openapi(
  createRoute({
    method: 'delete',
    path: '/{id}',
    tags: ['Students'],
    summary: 'Delete a student',
    description: 'The owner, or **ADMIN**. Managers are read-only.',
    request: { params: IdParams },
    responses: { 204: { description: 'Deleted' }, ...errorResponses(401, 404) }
  }),
  async c => {
    const user = requireUser(c)
    const res = await Students.deleteOne({ _id: c.req.valid('param').id, ...access(c, user, true) })
    if (!res.deletedCount) throw notFound('Student')
    logActivity(user._id, 'STUDENT')
    return c.body(null, 204)
  }
)

export default app
