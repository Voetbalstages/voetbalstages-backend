import { createRoute, z } from '@hono/zod-openapi'
import { getSettings } from '../db/models/index.js'
import { router } from '../lib/router.js'
import { json } from '../schemas.js'

const app = router()

app.openapi(
  createRoute({
    method: 'get',
    path: '/terms',
    tags: ['Settings'],
    summary: 'Global terms (HTML)',
    responses: { 200: json(z.object({ terms: z.string() })) }
  }),
  async c => c.json({ terms: (await getSettings()).terms ?? '' }, 200)
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/settings',
    tags: ['Settings'],
    summary: 'Public settings subset',
    responses: { 200: json(z.object({ earlyBirdToInc: z.string().nullable() })) }
  }),
  async c => {
    const { earlyBirdToInc } = await getSettings()
    return c.json({ earlyBirdToInc: earlyBirdToInc ? new Date(earlyBirdToInc).toISOString() : null }, 200)
  }
)

export default app
