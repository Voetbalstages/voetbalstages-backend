import { createRoute, z } from '@hono/zod-openapi'
import { Organizations } from '../db/models/index.js'
import { router } from '../lib/router.js'
import { notFound } from '../lib/errors.js'
import { IdParams, OrganizationSchema, errorResponses, json } from '../schemas.js'
import { serializeOrganization } from '../serializers/index.js'

const app = router()
const TermsSchema = z.object({ terms: z.string() }).openapi('Terms')
const PathParams = z.object({ path: z.string().regex(/^[a-zA-Z0-9-]+$/).max(100) })

app.openapi(
  createRoute({
    method: 'get',
    path: '/by-path/{path}',
    tags: ['Organizations'],
    summary: 'Organization by slug',
    request: { params: PathParams },
    responses: { 200: json(OrganizationSchema), ...errorResponses(404) }
  }),
  async c => {
    const org = await Organizations.findOne({ path: c.req.valid('param').path }).lean()
    if (!org) throw notFound('Organization')
    return c.json(serializeOrganization(org), 200)
  }
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/{id}',
    tags: ['Organizations'],
    summary: 'Organization by id',
    request: { params: IdParams },
    responses: { 200: json(OrganizationSchema), ...errorResponses(404) }
  }),
  async c => {
    const org = await Organizations.findById(c.req.valid('param').id).lean()
    if (!org) throw notFound('Organization')
    return c.json(serializeOrganization(org), 200)
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

export default app
