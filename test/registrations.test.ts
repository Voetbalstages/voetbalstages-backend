import { describe, expect, it } from 'vitest'
import {
  api,
  daysFromNow,
  login,
  seedCamp,
  seedLocation,
  seedOrg,
  seedRegistration,
  seedStudent,
  seedUser,
  world
} from './helpers.js'

const ids = (body: { id: string }[]) => body.map(r => r.id)

describe('GET /registrations', () => {
  it('only lists own registrations and sets X-Total-Count', async () => {
    const w = await world()
    const other = await seedUser()
    const otherStudent = await seedStudent(other)
    const mine = await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: w.campId, organizationId: w.orgId })
    await seedRegistration({ userId: other, studentId: otherStudent, campId: w.campId, organizationId: w.orgId })

    const res = await api('GET', '/registrations', undefined, { cookie: w.cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-total-count')).toBe('1')
    expect(ids(res.body)).toEqual([String(mine)])
    expect(res.body[0]).toMatchObject({
      status: 'open',
      orderId: '20260101-000001',
      student: { id: String(w.studentId), name: 'Lars' },
      camp: { id: String(w.campId) },
      location: { id: String(w.locationId) }
    })
  })

  it('filters by campId, studentId, status and orderId', async () => {
    const w = await world()
    const camp2 = await seedCamp(w.locationId, w.orgId, { period: '2026-zomer-2' })
    const student2 = await seedStudent(w.userId, 'Emma')
    const base = { userId: w.userId, organizationId: w.orgId }
    const a = await seedRegistration({ ...base, studentId: w.studentId, campId: w.campId, status: 'confirmed', orderId: '20260101-000001' })
    const b = await seedRegistration({ ...base, studentId: student2, campId: camp2, status: 'open', orderId: '20260101-000002' })

    const get = async (qs: string) => ids((await api('GET', `/registrations?${qs}`, undefined, { cookie: w.cookie })).body)
    expect(await get(`campId=${camp2}`)).toEqual([String(b)])
    expect(await get(`studentId=${w.studentId}`)).toEqual([String(a)])
    expect(await get('status=confirmed')).toEqual([String(a)])
    expect(await get('orderId=20260101-000002')).toEqual([String(b)])
    expect(await get(`organizationId=${w.orgId}`)).toHaveLength(2)
  })

  it('filters by organization', async () => {
    const w = await world()
    const otherOrg = await seedOrg({ path: 'x', name: 'Other' })
    const otherLoc = await seedLocation(otherOrg, { path: 'other' })
    const otherCamp = await seedCamp(otherLoc, otherOrg)
    await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: w.campId, organizationId: w.orgId })
    const b = await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: otherCamp, organizationId: otherOrg })

    const res = await api('GET', `/registrations?organizationId=${otherOrg}`, undefined, { cookie: w.cookie })
    expect(ids(res.body)).toEqual([String(b)])
  })

  it('paginates with page (0-based) and perPage', async () => {
    const w = await world()
    for (let i = 0; i < 3; i++) {
      await seedRegistration({
        userId: w.userId,
        studentId: w.studentId,
        campId: w.campId,
        organizationId: w.orgId,
        createdAt: daysFromNow(-i)
      })
    }
    const first = await api('GET', '/registrations?perPage=2&page=0', undefined, { cookie: w.cookie })
    const second = await api('GET', '/registrations?perPage=2&page=1', undefined, { cookie: w.cookie })
    expect(first.headers.get('x-total-count')).toBe('3')
    expect(first.body).toHaveLength(2)
    expect(second.body).toHaveLength(1)
    expect(new Set([...ids(first.body), ...ids(second.body)]).size).toBe(3)
  })

  it('sorts by createdAt ascending by default and honours order=desc', async () => {
    const w = await world()
    const old = await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: w.campId, organizationId: w.orgId, createdAt: daysFromNow(-10) })
    const recent = await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: w.campId, organizationId: w.orgId, createdAt: daysFromNow(-1) })

    const asc = await api('GET', '/registrations', undefined, { cookie: w.cookie })
    expect(ids(asc.body)).toEqual([String(old), String(recent)])
    const desc = await api('GET', '/registrations?order=desc', undefined, { cookie: w.cookie })
    expect(ids(desc.body)).toEqual([String(recent), String(old)])
  })

  it('rejects invalid query values and anonymous callers', async () => {
    const w = await world()
    expect((await api('GET', '/registrations?status=bogus', undefined, { cookie: w.cookie })).status).toBe(400)
    expect((await api('GET', '/registrations?campId=not-an-id', undefined, { cookie: w.cookie })).status).toBe(400)
    expect((await api('GET', '/registrations')).status).toBe(401)
  })
})

describe('GET /registrations/{id}', () => {
  it('returns an own registration with server-computed fields', async () => {
    const w = await world()
    const id = await seedRegistration({
      userId: w.userId,
      studentId: w.studentId,
      campId: w.campId,
      organizationId: w.orgId,
      status: 'confirmed',
      paid: 195,
      gadgets: ['bal', 'shirt']
    })
    const res = await api('GET', `/registrations/${id}`, undefined, { cookie: w.cookie })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: String(id),
      status: 'confirmed',
      paid: 195,
      canCancel: true,
      gadgets: ['bal', 'shirt']
    })
    expect(res.body.calculatedCost).toBeDefined()
  })

  it('canCancel is false inside the cancelDays window', async () => {
    const w = await world()
    const soon = await seedCamp(w.locationId, w.orgId, { from: daysFromNow(3), to: daysFromNow(7) })
    const id = await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: soon, organizationId: w.orgId, status: 'confirmed', paid: 195 })
    const res = await api('GET', `/registrations/${id}`, undefined, { cookie: w.cookie })
    expect(res.body.canCancel).toBe(false)
  })

  it("someone else's registration is a 404, unknown ids too, anonymous is 401", async () => {
    const w = await world()
    const other = await seedUser()
    const otherStudent = await seedStudent(other)
    const theirs = await seedRegistration({ userId: other, studentId: otherStudent, campId: w.campId, organizationId: w.orgId })

    expect((await api('GET', `/registrations/${theirs}`, undefined, { cookie: w.cookie })).status).toBe(404)
    expect((await api('GET', `/registrations/${w.campId}`, undefined, { cookie: w.cookie })).status).toBe(404)
    expect((await api('GET', '/registrations/not-an-id', undefined, { cookie: w.cookie })).status).toBe(400)
    expect((await api('GET', `/registrations/${theirs}`)).status).toBe(401)
  })
})

describe('GET /camps/{id}/registrations', () => {
  it('returns only own registrations for that camp when logged in', async () => {
    const w = await world()
    const other = await seedUser()
    const otherStudent = await seedStudent(other)
    const mine = await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: w.campId, organizationId: w.orgId })
    await seedRegistration({ userId: other, studentId: otherStudent, campId: w.campId, organizationId: w.orgId })

    const res = await api('GET', `/camps/${w.campId}/registrations`, undefined, { cookie: w.cookie })
    expect(ids(res.body)).toEqual([String(mine)])
    const asOther = await api('GET', `/camps/${w.campId}/registrations`, undefined, { cookie: await login(other) })
    expect(asOther.body).toHaveLength(1)
    expect(asOther.body[0].id).not.toBe(String(mine))
  })
})
