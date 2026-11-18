import { describe, expect, it } from 'bun:test'
import { seed, SEED_USERS } from '../scripts/seed.js'
import { fakeGateway, setFakeStatus } from '../src/dev/fakeMollie.js'
import { Locations, Organizations } from '../src/db/models/index.js'
import { Camps, Registrations, Students, Users, api, login } from './helpers.js'

describe('dev seed', () => {
  it('inserts a consistent dataset covering every registration status', async () => {
    expect(await seed()).toBe(true)

    const [camps, locations, orgs, students, users, regs] = await Promise.all([
      Camps.find().lean(),
      Locations.find().lean(),
      Organizations.find().lean(),
      Students.find().lean(),
      Users.find().lean(),
      Registrations.find().lean()
    ])
    const ids = (docs: { _id: unknown }[]) => new Set(docs.map(d => String(d._id)))
    const locationIds = ids(locations)
    const orgIds = ids(orgs)
    const studentIds = ids(students)
    const userIds = ids(users)
    const campIds = ids(camps)

    for (const c of camps) {
      expect(locationIds.has(String(c.locationId))).toBe(true)
      expect(orgIds.has(String(c.organizationId))).toBe(true)
    }
    for (const r of regs) {
      expect(campIds.has(String(r.campId))).toBe(true)
      expect(studentIds.has(String(r.studentId))).toBe(true)
      expect(userIds.has(String(r.userId))).toBe(true)
      const camp = camps.find(c => String(c._id) === String(r.campId))!
      expect(String(camp.organizationId)).toBe(String(r.organizationId))
    }
    for (const s of students) expect(s.ownerId!.every(o => userIds.has(String(o)))).toBe(true)

    expect(new Set(regs.map(r => r.status))).toEqual(
      new Set(['open', 'payment_pending', 'confirmed', 'deposited', 'canceled', 'refunded'])
    )
    expect(new Set(users.map(u => u.role).filter(Boolean))).toEqual(new Set(['ADMIN', 'MANAGER']))
    expect(new Set(camps.map(c => c.status))).toEqual(new Set(['OPEN', 'HIDDEN', 'CANCELED']))
    expect(new Set(camps.flatMap(c => c.options ?? []))).toEqual(new Set(['GADGETS', 'TSHIRTSIZE', 'SHORTSIZE', 'SHOESIZE']))
    expect(new Set(locations.map(l => l.visibility))).toEqual(new Set(['VISIBLE', 'AUTO', 'HIDDEN']))
    expect(orgs).toHaveLength(2)
  })

  it('serves the seeded data through the API', async () => {
    await seed()
    const parent = await Users.findOne({ email: SEED_USERS.parent }).lean()
    const cookie = await login(parent!._id)

    const locations = await api('GET', '/locations')
    expect(locations.body.map((l: { path: string }) => l.path)).not.toContain('hasselt')
    expect(locations.body.length).toBeGreaterThanOrEqual(4)

    const me = await api('GET', '/me', undefined, { cookie })
    expect(me.body).toMatchObject({ fullName: 'Jan Peeters', credit: 25 })
    expect((await api('GET', '/students', undefined, { cookie })).body).toHaveLength(3)

    const orders = await api('GET', '/orders', undefined, { cookie })
    expect(orders.body.length).toBeGreaterThanOrEqual(6)
    const outstanding = await api('GET', '/orders?outstanding=true', undefined, { cookie })
    expect(outstanding.body.every((o: { status: string }) => ['open', 'deposited'].includes(o.status))).toBe(true)
    expect(outstanding.body.length).toBeGreaterThan(0)

    const available = await api('GET', '/camps?excludePast=true')
    expect(available.body.length).toBeGreaterThan(5)
    expect(available.body.every((c: { status: string }) => c.status !== 'HIDDEN')).toBe(true)
  })

  it('skips when data exists, and --reset wipes and re-seeds', async () => {
    expect(await seed()).toBe(true)
    expect(await seed()).toBe(false)
    await Users.collection.insertOne({ email: 'extra@example.test' })
    expect(await seed({ reset: true })).toBe(true)
    expect(await Users.countDocuments({ email: 'extra@example.test' })).toBe(0)
    expect(await Users.countDocuments()).toBe(5)
  })
})

describe('fake Mollie gateway (DEV_TOOLS)', () => {
  it('creates a payment with a local checkout URL and reflects status changes', async () => {
    const created = await fakeGateway.createPayment({
      amount: 12.5,
      description: 'test',
      redirectUrl: 'http://shop/x',
      webhookUrl: 'http://api/webhook',
      metadata: { orderId: '20260101-000001', userId: 'u' },
      profileId: 'pfl_x'
    })
    expect(created).toMatchObject({ status: 'open', amount: { value: '12.50', currency: 'EUR' } })
    expect(created._links.checkout?.href).toContain(`/api/v1/dev/checkout/${created.id}`)

    setFakeStatus(created.id, 'paid')
    expect((await fakeGateway.getPayment(created.id))?.status).toBe('paid')
    expect(await fakeGateway.getPayment('tr_unknown')).toBeNull()
  })
})
