import { OpenAPIHono } from '@hono/zod-openapi'
import type { AppEnv } from '../types.js'

export const router = () =>
  new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid request',
              details: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }))
            }
          },
          400
        )
      }
    }
  })
