import { Hono } from 'hono'
import { handlePaymentWebhook } from '../services/payments.js'
import { reportError } from '../logger.js'

/**
 * Mollie webhook. Plain Hono (not in the OpenAPI docs) and mounted before the JSON/CSRF guard:
 * Mollie posts `id=tr_…` form-encoded without an Origin header. The body is only used as a
 * lookup key; the payment itself is always re-fetched from Mollie.
 */
const app = new Hono()

app.post('/webhook', async c => {
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
  const id = typeof body.id === 'string' ? body.id : ''
  if (!id) return c.text('OK', 200)
  try {
    await handlePaymentWebhook(id)
    return c.text('OK', 200)
  } catch (err) {
    reportError(err, { paymentId: id })
    // Non-2xx makes Mollie retry later.
    return c.text('Error', 500)
  }
})

export default app
