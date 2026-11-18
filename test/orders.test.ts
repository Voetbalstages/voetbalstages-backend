import { describe, expect, it } from 'vitest'
import { outbox } from '../src/services/mailer.js'
import {
  FakeMollie,
  Payments,
  Registrations,
  Users,
  api,
  daysFromNow,
  seedCamp,
  seedLocation,
  seedOrg,
  seedRegistration,
  seedStudent,
  seedUser,
  login,
  world
} from './helpers.js'

const item = (campId: unknown, studentId: unknown, extra = {}) => ({
  campId: String(campId),
  studentId: String(studentId),
  ...extra
})

describe('POST /orders', () => {
  it('creates a pay-later order without touching Mollie', async () => {
    const w = await world()
    const mollie = new FakeMollie().install()
    const res = await api('POST', '/orders', { registrations: [item(w.campId, w.studentId)] }, { cookie: w.cookie })
    expect(res.status).toBe(201)
    expect(res.body.payUrl).toBeNull()
    expect(res.body.order).toMatchObject({ status: 'open', registrationCount: 1, calculatedCost: { total: 195, open: 195 } })
    expect(res.body.order.id).toMatch(/^\d{8}-\d{6}$/)
    expect(mollie.created).toHaveLength(0)
    const reg = await Registrations.findOne().lean()
    expect(reg?.price).toBeUndefined() // pay-later keeps recalculating, like today
    expect(outbox.map(m => m.template)).toContain('orderConfirmed')
  })

  it('payNow starts a Mollie payment, locks the price and stores the payment JSON', async () => {
    const w = await world()
    const mollie = new FakeMollie().install()
    const res = await api('POST', '/orders', { registrations: [item(w.campId, w.studentId)], payNow: true }, { cookie: w.cookie })
    expect(res.status).toBe(201)
    expect(res.body.payUrl).toMatch(/^https:\/\/mollie\.test\/checkout\//)
    expect(mollie.created[0]).toMatchObject({
      amount: 195,
      redirectUrl: `https://shop.test/bestellingen/${res.body.order.id}`,
      webhookUrl: 'https://api.test/api/v1/payments/webhook',
      profileId: 'pfl_abcdefghij',
      applicationFee: { amount: 1 }
    })
    const reg = await Registrations.findOne().lean()
    expect(reg).toMatchObject({ status: 'payment_pending', price: 195 })
    const stored = await Payments.findOne().lean()
    expect(stored).toMatchObject({ status: 'open', metadata: { orderId: res.body.order.id } })
  })

  it('store credit covering everything confirms immediately, no Mollie', async () => {
    const w = await world()
    await Users.updateOne({ _id: w.userId }, { $set: { credit: 200 } })
    const mollie = new FakeMollie().install()
    const res = await api('POST', '/orders', { registrations: [item(w.campId, w.studentId)], payNow: true }, { cookie: w.cookie })
    expect(res.body).toMatchObject({ payUrl: null, credit: 5 })
    expect(mollie.created).toHaveLength(0)
    expect(await Registrations.findOne().lean()).toMatchObject({ status: 'confirmed', paid: 195, price: 195 })
  })

  it('partial credit is added to paid and the rest goes to Mollie', async () => {
    const w = await world()
    await Users.updateOne({ _id: w.userId }, { $set: { credit: 45 } })
    const mollie = new FakeMollie().install()
    const res = await api('POST', '/orders', { registrations: [item(w.campId, w.studentId)], payNow: true }, { cookie: w.cookie })
    expect(res.body.credit).toBe(0)
    expect(mollie.created[0]!.amount).toBe(150)
    expect(await Registrations.findOne().lean()).toMatchObject({ status: 'payment_pending', paid: 45 })
  })

  it('deposit orders charge the deposit and skip the platform fee', async () => {
    const w = await world()
    const mollie = new FakeMollie().install()
    await api('POST', '/orders', { registrations: [item(w.campId, w.studentId)], payNow: true, deposit: true }, { cookie: w.cookie })
    expect(mollie.created[0]).toMatchObject({ amount: 50, metadata: { deposit: true } })
    expect(mollie.created[0]!.applicationFee).toBeUndefined()
  })

  it('refuses a deposit when the camp is in the force-pay window', async () => {
    const w = await world()
    const soon = await seedCamp(w.locationId, w.orgId, { from: daysFromNow(5), to: daysFromNow(9) })
    const res = await api('POST', '/orders', { registrations: [item(soon, w.studentId)], payNow: true, deposit: true }, { cookie: w.cookie })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DEPOSIT_NOT_AVAILABLE')
  })

  it('validates everything before writing anything', async () => {
    const w = await world()
    const otherOrg = await seedOrg({ path: 'x' })
    const otherLoc = await seedLocation(otherOrg, { path: 'x' })
    const otherCamp = await seedCamp(otherLoc, otherOrg)
    const hidden = await seedCamp(w.locationId, w.orgId, { status: 'HIDDEN' })
    const gadgetCamp = await seedCamp(w.locationId, w.orgId, { options: ['GADGETS', 'TSHIRTSIZE'] })
    const strangerStudent = await seedStudent(await seedUser())
    const second = await seedStudent(w.userId, 'Emma')

    const cases: [unknown, number, string][] = [
      [[item(w.campId, w.studentId), item(otherCamp, second)], 409, 'MIXED_ORGANIZATIONS'],
      [[item(w.campId, strangerStudent)], 404, 'NOT_FOUND'],
      [[item(hidden, w.studentId)], 409, 'CAMP_NOT_BOOKABLE'],
      [[item(gadgetCamp, w.studentId, { gadgets: ['bal'] , tshirtSize: '140' })], 400, 'MISSING_OPTION'],
      [[item(w.campId, w.studentId), item(w.campId, w.studentId)], 409, 'DUPLICATE_IN_ORDER']
    ]
    for (const [registrations, status, code] of cases) {
      const res = await api('POST', '/orders', { registrations }, { cookie: w.cookie })
      expect([res.status, res.body.error.code]).toEqual([status, code])
    }
    expect(await Registrations.countDocuments()).toBe(0)

    const ok = await api('POST', '/orders', { registrations: [item(gadgetCamp, w.studentId, { gadgets: ['bal', 'shirt'], tshirtSize: '140', shoeSize: 38 })] }, { cookie: w.cookie })
    expect(ok.status).toBe(201)
    const reg = await Registrations.findOne().lean()
    expect(reg).toMatchObject({ gadgets: ['bal', 'shirt'], tshirtSize: '140' })
    expect(reg?.shoeSize).toBeUndefined() // only fields the camp asks for are stored
  })

  it('409 when the student already holds an active registration for the camp', async () => {
    const w = await world()
    await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: w.campId, organizationId: w.orgId, status: 'confirmed' })
    const res = await api('POST', '/orders', { registrations: [item(w.campId, w.studentId)] }, { cookie: w.cookie })
    expect(res.body.error.code).toBe('ALREADY_REGISTERED')
  })

  it('Mollie failure rolls everything back (registrations and credit) and returns 502', async () => {
    const w = await world()
    await Users.updateOne({ _id: w.userId }, { $set: { credit: 20 } })
    const mollie = new FakeMollie().install()
    mollie.failCreate = true
    const res = await api('POST', '/orders', { registrations: [item(w.campId, w.studentId)], payNow: true }, { cookie: w.cookie })
    expect(res.status).toBe(502)
    expect(await Registrations.countDocuments()).toBe(0)
    expect((await Users.findById(w.userId).lean())?.credit).toBe(20)
  })
})

describe('POST /orders/{id}/payment', () => {
  const pendingOrder = async () => {
    const w = await world()
    const mollie = new FakeMollie().install()
    const res = await api('POST', '/orders', { registrations: [item(w.campId, w.studentId)] }, { cookie: w.cookie })
    return { ...w, mollie, orderId: res.body.order.id as string }
  }

  it('starts a payment for an open order, then reuses the open checkout instead of a second payment', async () => {
    const { cookie, orderId, mollie } = await pendingOrder()
    const first = await api('POST', `/orders/${orderId}/payment`, undefined, { cookie })
    expect(first.status).toBe(200)
    const second = await api('POST', `/orders/${orderId}/payment`, undefined, { cookie })
    expect(second.body.payUrl).toBe(first.body.payUrl)
    expect(mollie.created).toHaveLength(1)
  })

  it('409 while a payment is pending (e.g. bank transfer)', async () => {
    const { cookie, orderId } = await pendingOrder()
    await api('POST', `/orders/${orderId}/payment`, undefined, { cookie })
    await Payments.updateMany({}, { $set: { status: 'pending' } })
    const res = await api('POST', `/orders/${orderId}/payment`, undefined, { cookie })
    expect(res.body.error.code).toBe('PAYMENT_PENDING')
  })

  it('allows a new payment once the previous checkout expired', async () => {
    const { cookie, orderId, mollie } = await pendingOrder()
    await api('POST', `/orders/${orderId}/payment`, undefined, { cookie })
    await Payments.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000).toISOString() } })
    expect((await api('POST', `/orders/${orderId}/payment`, undefined, { cookie })).status).toBe(200)
    expect(mollie.created).toHaveLength(2)
  })

  it("someone else's order is a 404", async () => {
    const { orderId } = await pendingOrder()
    const stranger = await login(await seedUser())
    expect((await api('POST', `/orders/${orderId}/payment`, undefined, { cookie: stranger })).status).toBe(404)
    expect((await api('GET', `/orders/${orderId}`, undefined, { cookie: stranger })).status).toBe(404)
  })

  it('409 when nothing is left to pay', async () => {
    const w = await world()
    await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: w.campId, organizationId: w.orgId, status: 'confirmed', paid: 195, price: 195, orderId: '20260101-000009' })
    const res = await api('POST', '/orders/20260101-000009/payment', undefined, { cookie: w.cookie })
    expect(res.body.error.code).toBe('NOTHING_TO_PAY')
  })
})

describe('GET /orders', () => {
  it('lists own orders newest first, outstanding filter only shows unpaid future camps', async () => {
    const w = await world()
    const past = await seedCamp(w.locationId, w.orgId, { from: daysFromNow(-20), to: daysFromNow(-16) })
    const base = { userId: w.userId, studentId: w.studentId, organizationId: w.orgId }
    await seedRegistration({ ...base, campId: w.campId, orderId: '20260101-000001', status: 'open' })
    await seedRegistration({ ...base, campId: w.campId, orderId: '20260102-000002', status: 'confirmed', paid: 195, price: 195 })
    await seedRegistration({ ...base, campId: past, orderId: '20250101-000003', status: 'open' })
    await seedRegistration({ userId: await seedUser(), studentId: w.studentId, organizationId: w.orgId, campId: w.campId, orderId: '20260103-000004' })

    const all = await api('GET', '/orders', undefined, { cookie: w.cookie })
    expect(all.body.map((o: { id: string }) => o.id)).toEqual(['20260102-000002', '20260101-000001', '20250101-000003'])
    expect(all.headers.get('x-total-count')).toBe('3')

    const paged = await api('GET', '/orders?perPage=1&page=1', undefined, { cookie: w.cookie })
    expect(paged.body.map((o: { id: string }) => o.id)).toEqual(['20260101-000001'])

    const outstanding = await api('GET', '/orders?outstanding=true', undefined, { cookie: w.cookie })
    expect(outstanding.body.map((o: { id: string }) => o.id)).toEqual(['20260101-000001'])
  })
})
