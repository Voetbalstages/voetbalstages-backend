import { createRoute, z } from '@hono/zod-openapi'
import { Users } from '../db/models/index.js'
import { router } from '../lib/router.js'
import { AddressSchema, UserSchema, errorResponses, json } from '../schemas.js'
import { serializeUser } from '../serializers/index.js'
import { requireUser } from '../auth/session.js'
import { logActivity } from '../services/activity.js'

const app = router()

app.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['Me'],
    summary: 'Current user profile',
    responses: { 200: json(UserSchema), ...errorResponses(401) }
  }),
  c => c.json(serializeUser(requireUser(c)), 200)
)

app.openapi(
  createRoute({
    method: 'patch',
    path: '/',
    tags: ['Me'],
    summary: 'Update own profile',
    description:
      'Email is not writable here: with magic-link login a self-service email change would allow ' +
      'account takeover. `role`, `credit` and `organizationIds` are never client-writable.',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z
              .object({
                firstName: z.string().max(100),
                lastName: z.string().max(100),
                secondEmail: z.union([z.email(), z.literal('')]),
                telephone: z.array(z.string().max(40)).max(5),
                address: AddressSchema
              })
              .partial()
              .strict()
          }
        }
      }
    },
    responses: { 200: json(UserSchema), ...errorResponses(400, 401) }
  }),
  async c => {
    const user = requireUser(c)
    const updated = await Users.findOneAndUpdate(
      { _id: user._id },
      { $set: c.req.valid('json') },
      { new: true, runValidators: true }
    )
    logActivity(user._id, 'USER')
    return c.json(serializeUser(updated!), 200)
  }
)

export default app
