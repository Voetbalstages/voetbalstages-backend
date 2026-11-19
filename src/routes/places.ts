import { createRoute, z } from '@hono/zod-openapi'
import { router } from '../lib/router.js'
import { notFound } from '../lib/errors.js'
import { AddressSchema } from '../schemas.js'
import { errorResponses, json } from '../schemas.js'
import { requireUser } from '../auth/session.js'
import { places } from '../services/places.js'

const TAG = ['Places']
const app = router()

app.openapi(
  createRoute({
    method: 'get',
    path: '/autocomplete',
    tags: TAG,
    summary: 'Address suggestions (Google Places proxy)',
    description: '**Requires: login** (any role; the contact-details and location forms use it).',
    request: { query: z.object({ q: z.string().trim().min(2).max(200) }) },
    responses: {
      200: json(z.array(z.object({ placeId: z.string(), description: z.string() }))),
      ...errorResponses(400, 401, 502)
    }
  }),
  async c => {
    requireUser(c)
    return c.json(await places().autocomplete(c.req.valid('query').q), 200)
  }
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/{placeId}',
    tags: TAG,
    summary: 'Resolve a place id to an address',
    description: '**Requires: login.** Needs `GOOGLE_PLACES_API_KEY`.',
    request: { params: z.object({ placeId: z.string().min(5).max(300) }) },
    responses: { 200: json(AddressSchema), ...errorResponses(401, 404, 502) }
  }),
  async c => {
    requireUser(c)
    const address = await places().geocode(c.req.valid('param').placeId)
    if (!address) throw notFound('Place')
    return c.json(address as z.infer<typeof AddressSchema>, 200)
  }
)

export default app
