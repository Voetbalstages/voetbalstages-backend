import { createRoute, z } from '@hono/zod-openapi'
import { SettingsModel, getSettings } from '../db/models/index.js'
import { router } from '../lib/router.js'
import { SettingsSchema, errorResponses, json } from '../schemas.js'
import { serializeSettings } from '../serializers/index.js'
import { optionalStaff, requireAdmin } from '../auth/staff.js'
import { logActivity } from '../services/activity.js'

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
    summary: 'Settings',
    description:
      'Public: only `earlyBirdToInc`. **Staff (ADMIN/MANAGER) additionally get** the day counts, ' +
      'discount, `emailFrom` and `terms`. Deposit/cancel/force-pay effects are already baked into ' +
      '`costDetail` and `canCancel`.',
    responses: { 200: json(SettingsSchema) }
  }),
  async c => c.json(serializeSettings(await getSettings(), !!optionalStaff(c)), 200)
)

app.openapi(
  createRoute({
    method: 'patch',
    path: '/settings',
    tags: ['Settings'],
    summary: 'Update settings',
    description:
      '**Requires: ADMIN.** Affects every price and cancel check immediately. The settings ' +
      'document must already exist (it is never created here).',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z
              .object({
                earlyBirdDiscount: z.number().min(0).max(10000),
                earlyBirdToInc: z.iso.datetime().nullable(),
                depositDays: z.number().int().min(0).max(365),
                forcePayDays: z.number().int().min(0).max(365),
                cancelDays: z.number().int().min(0).max(365),
                emailFrom: z.string().max(200),
                terms: z.string().max(200_000)
              })
              .strict()
              .partial()
          }
        }
      }
    },
    responses: { 200: json(SettingsSchema), ...errorResponses(400, 401, 403) }
  }),
  async c => {
    const { user } = requireAdmin(c)
    await getSettings()
    const data = c.req.valid('json')
    const $set = {
      ...data,
      ...(data.earlyBirdToInc !== undefined && { earlyBirdToInc: data.earlyBirdToInc ? new Date(data.earlyBirdToInc) : null })
    }
    await SettingsModel.updateOne({}, { $set })
    logActivity(user._id, 'SETTINGS')
    return c.json(serializeSettings(await getSettings(), true), 200)
  }
)

export default app
