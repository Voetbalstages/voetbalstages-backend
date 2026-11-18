import { Hono } from 'hono'
import { handlePaymentWebhook } from '../services/payments.js'
import { fakePayment, setFakeStatus } from './fakeMollie.js'
import type { MolliePayment } from '../services/mollie.js'

/** Only mounted when DEV_TOOLS=true. GET with side effects is fine for a local fake. */
const app = new Hono()

const outcomes: Record<string, { status: MolliePayment['status']; label: string }> = {
  paid: { status: 'paid', label: 'Pay (success)' },
  pending: { status: 'pending', label: 'Pending (e.g. bank transfer)' },
  failed: { status: 'failed', label: 'Fail' },
  canceled: { status: 'canceled', label: 'Cancel' },
  expired: { status: 'expired', label: 'Expire' }
}

app.get('/checkout/:id', c => {
  const id = c.req.param('id')
  const found = fakePayment(id)
  if (!found) return c.text('Unknown fake payment (the API restarted?)', 404)
  const { payment } = found
  const links = Object.entries(outcomes)
    .map(([key, o]) => `<li><a href="/api/v1/dev/checkout/${id}/${key}">${o.label}</a></li>`)
    .join('')
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Fake Mollie</title>
<body style="font-family:system-ui;max-width:32rem;margin:3rem auto">
<h1>Fake Mollie checkout</h1>
<p>${payment.description} &mdash; <b>EUR ${payment.amount.value}</b><br><small>${id} &middot; ${payment.status}</small></p>
<ul>${links}</ul></body>`
  )
})

app.get('/checkout/:id/:outcome', async c => {
  const { id, outcome } = c.req.param()
  const chosen = outcomes[outcome]
  const found = setFakeStatus(id, chosen?.status ?? 'open')
  if (!found || !chosen) return c.text('Unknown payment or outcome', 404)
  await handlePaymentWebhook(id)
  return c.redirect(found.redirectUrl)
})

export default app
