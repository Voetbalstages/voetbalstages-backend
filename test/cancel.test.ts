import { describe, expect, it } from 'bun:test'
import { outbox } from '../src/services/mailer.js'
import { FakeMollie, Payments, Registrations, Users, api, daysFromNow, seedCamp, seedRegistration, world, waitFor } from './helpers.js'

describe('POST /registrations/{id}/cancel', () => {
  it('refunds paid amounts to store credit', async () => {
    const w = await world()
    await Users.updateOne({ _id: w.userId }, { $set: { credit: 10 } })
    const id = await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: w.campId, organizationId: w.orgId, status: 'confirmed', paid: 195, price: 195 })
    const res = await api('POST', `/registrations/${id}/cancel`, undefined, { cookie: w.cookie })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ credit: 205, registration: { status: 'refunded', paid: 0, canCancel: false } })
    await waitFor(() => expect(outbox).toHaveLength(1))
    expect(outbox[0]).toMatchObject({ template: 'registrationCanceled' })
    expect(outbox[0]!.data.addedCredit).toMatch(/195/)
  })

  it('cancels unpaid registrations without credit', async () => {
    const w = await world()
    const id = await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: w.campId, organizationId: w.orgId, status: 'open' })
    const res = await api('POST', `/registrations/${id}/cancel`, undefined, { cookie: w.cookie })
    expect(res.body).toMatchObject({ credit: 0, registration: { status: 'canceled' } })
  })

  it('enforces cancelDays', async () => {
    const w = await world()
    const soon = await seedCamp(w.locationId, w.orgId, { from: daysFromNow(5), to: daysFromNow(9) })
    const id = await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: soon, organizationId: w.orgId, status: 'confirmed', paid: 195 })
    const res = await api('POST', `/registrations/${id}/cancel`, undefined, { cookie: w.cookie })
    expect(res.body.error.code).toBe('NOT_CANCELLABLE')
    expect((await Users.findById(w.userId).lean())?.credit).toBe(0)
  })

  it('refuses while a Mollie payment for the order is open', async () => {
    const w = await world()
    new FakeMollie().install()
    const order = await api('POST', '/orders', { registrations: [{ campId: String(w.campId), studentId: String(w.studentId) }] }, { cookie: w.cookie })
    await api('POST', `/orders/${order.body.order.id}/payment`, undefined, { cookie: w.cookie })
    const reg = await Registrations.findOne().lean()
    const res = await api('POST', `/registrations/${reg!._id}/cancel`, undefined, { cookie: w.cookie })
    expect(res.body.error.code).toBe('PAYMENT_IN_PROGRESS')
    expect(await Payments.countDocuments()).toBe(1)
  })

  it('concurrent cancels credit only once', async () => {
    const w = await world()
    const id = await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: w.campId, organizationId: w.orgId, status: 'confirmed', paid: 195 })
    const results = await Promise.all([1, 2, 3].map(() => api('POST', `/registrations/${id}/cancel`, undefined, { cookie: w.cookie })))
    expect(results.map(r => r.status).sort()).toEqual([200, 409, 409])
    expect((await Users.findById(w.userId).lean())?.credit).toBe(195)
  })

  it("someone else's registration is a 404", async () => {
    const w = await world()
    const { seedUser, login } = await import('./helpers.js')
    const id = await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: w.campId, organizationId: w.orgId, status: 'confirmed', paid: 195 })
    const stranger = await login(await seedUser())
    expect((await api('POST', `/registrations/${id}/cancel`, undefined, { cookie: stranger })).status).toBe(404)
    expect((await api('GET', `/registrations/${id}`, undefined, { cookie: stranger })).status).toBe(404)
  })
})
