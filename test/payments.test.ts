import { describe, expect, it } from 'vitest'
import { outbox } from '../src/services/mailer.js'
import { FakeMollie, Payments, Registrations, api, webhook, world } from './helpers.js'

const checkout = async (deposit = false) => {
  const w = await world()
  const mollie = new FakeMollie().install()
  const res = await api(
    'POST',
    '/orders',
    { registrations: [{ campId: String(w.campId), studentId: String(w.studentId) }], payNow: true, deposit },
    { cookie: w.cookie }
  )
  const paymentId = [...mollie.payments.keys()][0]!
  outbox.length = 0
  return { ...w, mollie, paymentId, orderId: res.body.order.id as string }
}

describe('Mollie webhook', () => {
  it('accepts the form-encoded body Mollie sends and confirms on paid, mailing once across retries', async () => {
    const { mollie, paymentId } = await checkout()
    mollie.setStatus(paymentId, 'paid')
    expect((await webhook(paymentId)).status).toBe(200)
    expect((await webhook(paymentId)).status).toBe(200)
    expect(await Registrations.findOne().lean()).toMatchObject({ status: 'confirmed', paid: 195, price: 195 })
    expect(outbox.filter(m => m.template === 'paymentConfirmed')).toHaveLength(1)
    expect(await Payments.findOne({ id: paymentId }).lean()).toMatchObject({ status: 'paid' })
  })

  it('marks deposit payments as deposited', async () => {
    const { mollie, paymentId } = await checkout(true)
    mollie.setStatus(paymentId, 'paid')
    await webhook(paymentId)
    expect(await Registrations.findOne().lean()).toMatchObject({ status: 'deposited', paid: 50 })
    expect(outbox.map(m => m.template)).toEqual(['depositConfirmed'])
  })

  it('an expired checkout reopens payment_pending registrations', async () => {
    const { mollie, paymentId } = await checkout()
    mollie.setStatus(paymentId, 'expired')
    await webhook(paymentId)
    expect((await Registrations.findOne().lean())?.status).toBe('open')
  })

  it('never downgrades a deposited registration when a balance checkout expires', async () => {
    const { mollie, paymentId } = await checkout()
    await Registrations.updateMany({}, { $set: { status: 'deposited', paid: 50 } })
    mollie.setStatus(paymentId, 'expired')
    await webhook(paymentId)
    expect(await Registrations.findOne().lean()).toMatchObject({ status: 'deposited', paid: 50 })
  })

  it('ignores payments this service did not create', async () => {
    const { mollie } = await checkout()
    mollie.payments.set('tr_foreign', { ...[...mollie.payments.values()][0]!, id: 'tr_foreign', status: 'paid' })
    expect((await webhook('tr_foreign')).status).toBe(200)
    expect((await Registrations.findOne().lean())?.status).toBe('payment_pending')
  })
})
