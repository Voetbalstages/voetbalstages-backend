import { randomBytes } from 'node:crypto'
import { createRoute, z } from '@hono/zod-openapi'
import { router } from '../lib/router.js'
import { badRequest } from '../lib/errors.js'
import { errorResponses, json } from '../schemas.js'
import { requireAdmin } from '../auth/staff.js'
import { PUBLIC_BASE, storage } from '../services/storage.js'

/** Location logos: PNG or SVG, max 90 KB (the limit the admin form documents). */
export const MAX_LOGO_BYTES = 90 * 1024

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// SVG can carry script. Instead of trying to rewrite it, refuse anything that can execute or load
// external content (admin-only upload, so rejecting is fine).
const SVG_FORBIDDEN =
  /<\s*(script|foreignObject|iframe|embed|object|audio|video|animate|set|use)\b|\son[a-z]+\s*=|javascript:|data:\s*text\/html|(?:xlink:)?href\s*=\s*["'](?!#)/i

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'logo'

const app = router()

app.openapi(
  createRoute({
    method: 'post',
    path: '/logo',
    tags: ['Uploads'],
    summary: 'Upload a location logo',
    description:
      '**Requires: ADMIN.** PNG or SVG, max 90 KB, sent as a base64 data URI. The file type is ' +
      'checked on the content, not the name; SVGs containing scripts, event handlers or external ' +
      'references are refused (`400 UNSAFE_SVG`). Returns `{ uri, name }`: pass that object as ' +
      '`logo` to `PATCH /locations/{id}` or `POST /locations`. Stored in the S3 bucket; ' +
      '`502 UPLOAD_FAILED` / `UPLOAD_NOT_CONFIGURED` when S3 is unavailable.',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              name: z.string().trim().min(1).max(100).openapi({ description: 'Used in the file name, e.g. the location name.' }),
              dataUri: z.string().max(Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 100)
            })
          }
        }
      }
    },
    responses: {
      201: json(z.object({ uri: z.url(), name: z.string() }), 'Stored'),
      ...errorResponses(400, 401, 403, 502)
    }
  }),
  async c => {
    requireAdmin(c)
    const { name, dataUri } = c.req.valid('json')
    const m = dataUri.match(/^data:image\/(png|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/)
    if (!m) throw badRequest('INVALID_FILE', 'Send a base64 data URI of a PNG or SVG image')
    const body = Buffer.from(m[2]!, 'base64')
    if (!body.length || body.length > MAX_LOGO_BYTES) throw badRequest('FILE_TOO_LARGE', 'Logo must be at most 90 KB')
    const isPng = m[1] === 'png'
    if (isPng) {
      if (!body.subarray(0, 8).equals(PNG_MAGIC)) throw badRequest('INVALID_FILE', 'Not a PNG file')
    } else {
      const text = body.toString('utf8')
      if (!/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) throw badRequest('INVALID_FILE', 'Not an SVG file')
      if (SVG_FORBIDDEN.test(text)) throw badRequest('UNSAFE_SVG', 'SVG may not contain scripts or external references')
    }
    const key = `${slug(name)}_logo_${randomBytes(4).toString('hex')}.${isPng ? 'png' : 'svg'}`
    await storage().put(key, body, isPng ? 'image/png' : 'image/svg+xml')
    return c.json({ uri: `${PUBLIC_BASE}${key}`, name: key }, 201)
  }
)

export default app
