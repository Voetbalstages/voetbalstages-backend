import { describe, expect, it } from 'bun:test'
import { Types } from 'mongoose'
import { outbox } from '../src/services/mailer.js'
import { setPlacesGateway } from '../src/services/places.js'
import { setStorageGateway } from '../src/services/storage.js'
import { Registrations, Users, api, daysFromNow, login, seedCamp, seedRegistration, seedUser, world, waitFor } from './helpers.js'

const staff = async (role: 'ADMIN' | 'MANAGER', organizationIds: Types.ObjectId[] = []) =>
  login(await seedUser({ role, organizationIds, email: `${role.toLowerCase()}@example.com` }))

describe('role checks on shared routes', () => {
  const staffOnly: [string, string][] = [
    ['GET', '/users'], ['GET', '/users/export'], ['GET', '/users/507f1f77bcf86cd799439011']
  ]
  it.each(staffOnly)('%s %s: 401 anonymous, 403 parent', async (method, path) => {
    const w = await world()
    expect((await api(method, path)).status).toBe(401)
    expect((await api(method, path, undefined, { cookie: w.cookie })).status).toBe(403)
  })

  const adminWrites: [string, string, unknown][] = [
    ['POST', '/organizations', { name: 'N', path: 'n', mollieProfileId: 'pfl_x1', terms: 't' }],
    ['PATCH', '/organizations/507f1f77bcf86cd799439011', { name: 'x' }],
    ['POST', '/locations', { name: 'N', path: 'n', organizationId: '507f1f77bcf86cd799439011' }],
    ['PATCH', '/locations/507f1f77bcf86cd799439011', { name: 'x' }],
    ['POST', '/camps', { locationId: '507f1f77bcf86cd799439011', from: '2030-01-01', to: '2030-01-02', period: 'p', cost: 1 }],
    ['PATCH', '/camps/507f1f77bcf86cd799439011', { name: 'x' }],
    ['PATCH', '/registrations/507f1f77bcf86cd799439011', { status: 'open' }],
    ['PATCH', '/users/507f1f77bcf86cd799439011', { credit: 1 }],
    ['PATCH', '/settings', { cancelDays: 1 }]
  ]
  it.each(adminWrites)('%s %s: 401 anonymous, 403 parent and manager', async (method, path, body) => {
    const w = await world()
    expect((await api(method, path, body)).status).toBe(401)
    expect((await api(method, path, body, { cookie: w.cookie })).status).toBe(403)
    expect((await api(method, path, body, { cookie: await staff('MANAGER', [w.orgId]) })).status).toBe(403)
  })

  it('places need a login but not a role', async () => {
    const w = await world()
    expect((await api('GET', '/places/autocomplete?q=abc')).status).toBe(401)
    setPlacesGateway({ autocomplete: async q => [{ placeId: 'x_1234', description: q }], geocode: async () => null })
    expect((await api('GET', '/places/autocomplete?q=abc', undefined, { cookie: w.cookie })).status).toBe(200)
  })

  it('the same list route shows parents their own data and staff everything', async () => {
    const w = await world()
    const other = await seedUser()
    const otherStudent = await (await import('./helpers.js')).seedStudent(other, 'Anna')
    await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: w.campId, organizationId: w.orgId })
    await seedRegistration({ userId: other, studentId: otherStudent, campId: w.campId, organizationId: w.orgId, orderId: '20260101-000002' })
    const admin = await staff('ADMIN')
    expect((await api('GET', '/students', undefined, { cookie: w.cookie })).body).toHaveLength(1)
    expect((await api('GET', '/students', undefined, { cookie: admin })).body).toHaveLength(2)
    expect((await api('GET', '/registrations', undefined, { cookie: w.cookie })).body).toHaveLength(1)
    expect((await api('GET', '/registrations', undefined, { cookie: admin })).body).toHaveLength(2)
    // a parent cannot widen the scope with userId
    expect((await api('GET', `/registrations?userId=${other}`, undefined, { cookie: w.cookie })).body).toHaveLength(1)
  })

  it('admin can edit and delete any student, parents only their own', async () => {
    const w = await world()
    const other = await seedUser()
    const otherStudent = await (await import('./helpers.js')).seedStudent(other, 'Anna')
    const admin = await staff('ADMIN')
    expect((await api('PATCH', `/students/${otherStudent}`, { name: 'x' }, { cookie: w.cookie })).status).toBe(404)
    expect((await api('DELETE', `/students/${otherStudent}`, undefined, { cookie: w.cookie })).status).toBe(404)
    expect((await api('PATCH', `/students/${otherStudent}`, { name: 'Anna B' }, { cookie: admin })).body.name).toBe('Anna B')
    expect((await api('DELETE', `/students/${otherStudent}`, undefined, { cookie: admin })).status).toBe(204)
    const mgr = await staff('MANAGER', [w.orgId])
    expect((await api('GET', `/students/${w.studentId}`, undefined, { cookie: mgr })).status).toBe(200)
    expect((await api('DELETE', `/students/${w.studentId}`, undefined, { cookie: mgr })).status).toBe(404)
  })

  it('hidden camps and locations are visible to admins and to managers of that organization only', async () => {
    const w = await world()
    const { seedOrg, seedLocation } = await import('./helpers.js')
    const otherOrg = await seedOrg({ path: 'other' })
    const hiddenLoc = await seedLocation(otherOrg, { path: 'verborgen', name: 'Verborgen', visibility: 'HIDDEN' })
    const hiddenCamp = await seedCamp(w.locationId, w.orgId, { status: 'HIDDEN', period: 'x' })
    const names = async (path: string, cookie?: string) => (await api('GET', path, undefined, { cookie })).body.map((x: any) => x.id)
    expect(await names('/camps')).not.toContain(String(hiddenCamp))
    expect(await names('/camps', w.cookie)).not.toContain(String(hiddenCamp))
    expect(await names('/camps', await staff('ADMIN'))).toContain(String(hiddenCamp))
    expect(await names('/camps', await staff('MANAGER', [w.orgId]))).toContain(String(hiddenCamp))
    expect(await names('/camps', await staff('MANAGER', [otherOrg]))).not.toContain(String(hiddenCamp))
    expect((await api('GET', `/camps/${hiddenCamp}`)).status).toBe(404)
    expect((await api('GET', `/camps/${hiddenCamp}`, undefined, { cookie: await staff('ADMIN') })).status).toBe(200)
    expect(await names('/locations')).not.toContain(String(hiddenLoc))
    expect(await names('/locations', await staff('MANAGER', [otherOrg]))).toContain(String(hiddenLoc))
    expect(await names('/locations', await staff('MANAGER', [w.orgId]))).not.toContain(String(hiddenLoc))
  })

  it('organizations expose the Mollie profile and terms to staff only', async () => {
    const w = await world()
    expect((await api('GET', `/organizations/${w.orgId}`)).body.mollieProfileId).toBeUndefined()
    expect((await api('GET', `/organizations/${w.orgId}`, undefined, { cookie: w.cookie })).body.mollieProfileId).toBeUndefined()
    const admin = await api('GET', `/organizations/${w.orgId}`, undefined, { cookie: await staff('ADMIN') })
    expect(admin.body).toMatchObject({ mollieProfileId: 'pfl_abcdefghij', terms: '<p>Org terms</p>' })
    const mgr = await staff('MANAGER', [w.orgId])
    expect((await api('GET', `/organizations/${w.orgId}`, undefined, { cookie: mgr })).body.mollieProfileId).toBe('pfl_abcdefghij')
    expect((await api('GET', '/organizations')).body[0].mollieProfileId).toBeUndefined()
  })

  it('settings: public subset for everyone, everything for staff', async () => {
    const w = await world()
    expect(Object.keys((await api('GET', '/settings')).body)).toEqual(['earlyBirdToInc'])
    expect((await api('GET', '/settings', undefined, { cookie: w.cookie })).body.cancelDays).toBeUndefined()
    expect((await api('GET', '/settings', undefined, { cookie: await staff('MANAGER') })).body.cancelDays).toBe(14)
  })

  it('/me lists the organizations of staff', async () => {
    const w = await world()
    const res = await api('GET', '/me', undefined, { cookie: await staff('ADMIN') })
    expect(res.body.isAdmin).toBe(true)
    expect(res.body.organizations[0].id).toBe(String(w.orgId))
    expect((await api('GET', '/me', undefined, { cookie: w.cookie })).body.organizations).toBeUndefined()
  })

  it('camp registrations: parents see their own, staff see everyone and can export', async () => {
    const w = await world()
    const other = await seedUser()
    const otherStudent = await (await import('./helpers.js')).seedStudent(other, 'Anna')
    await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: w.campId, organizationId: w.orgId })
    await seedRegistration({ userId: other, studentId: otherStudent, campId: w.campId, organizationId: w.orgId, orderId: '20260101-000002' })
    expect((await api('GET', `/camps/${w.campId}/registrations`, undefined, { cookie: w.cookie })).body).toHaveLength(1)
    expect((await api('GET', `/camps/${w.campId}/registrations`, undefined, { cookie: await staff('ADMIN') })).body).toHaveLength(2)
    const res = await (await import('./helpers.js')).app.request(`/api/v1/camps/${w.campId}/registrations/export`, { headers: { cookie: w.cookie } })
    expect(res.status).toBe(403)
  })
})

describe('admin organizations & locations', () => {
  it('creates, validates and updates an organization', async () => {
    await world()
    const cookie = await staff('ADMIN')
    const bad = await api('POST', '/organizations', { name: 'N', path: 'n', mollieProfileId: 'x', terms: 't' }, { cookie })
    expect(bad.status).toBe(400)
    const ok = await api('POST', '/organizations', { name: 'Nieuw', path: 'nieuw', mollieProfileId: 'pfl_abc123', terms: '<p>t</p>' }, { cookie })
    expect(ok.status).toBe(201)
    expect(ok.body.mollieProfileId).toBe('pfl_abc123')
    const dup = await api('POST', '/organizations', { name: 'X', path: 'NIEUW', mollieProfileId: 'pfl_abc123', terms: 't' }, { cookie })
    expect(dup.body.error.code).toBe('VALIDATION_ERROR') // uppercase not a slug
    const dup2 = await api('POST', '/organizations', { name: 'X', path: 'nieuw', mollieProfileId: 'pfl_abc123', terms: 't' }, { cookie })
    expect(dup2.body.error.code).toBe('PATH_TAKEN')
    const patched = await api('PATCH', `/organizations/${ok.body.id}`, { name: 'Nieuw 2' }, { cookie })
    expect(patched.body.name).toBe('Nieuw 2')
  })

  it('creates a hidden location by default, rejects duplicate paths', async () => {
    const w = await world()
    const cookie = await staff('ADMIN')
    const res = await api('POST', '/locations', { name: 'Gent', path: 'gent', organizationId: String(w.orgId) }, { cookie })
    expect(res.status).toBe(201)
    expect(res.body.visibility).toBe('HIDDEN')
    expect((await api('POST', '/locations', { name: 'G', path: 'gent', organizationId: String(w.orgId) }, { cookie })).body.error.code).toBe('PATH_TAKEN')
    const upd = await api('PATCH', `/locations/${res.body.id}`, { visibility: 'VISIBLE', address: { city: 'Gent', postcode: '9000' } }, { cookie })
    expect(upd.body).toMatchObject({ visibility: 'VISIBLE', address: { city: 'Gent' } })
    const list = await api('GET', '/locations?visibility=VISIBLE', undefined, { cookie })
    expect(list.headers.get('x-total-count')).toBe('2') // seeded + new
  })
})

describe('admin camps', () => {
  it('creates a camp with org from the location, 11:00 UTC dates and validation', async () => {
    const w = await world()
    const cookie = await staff('ADMIN')
    const body = { locationId: String(w.locationId), from: '2030-07-01', to: '2030-07-05', period: '2030-zomer-1', cost: 200, deposit: 50 }
    const res = await api('POST', '/camps', body, { cookie })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ organizationId: String(w.orgId), from: '2030-07-01T11:00:00.000Z', storedStatus: 'OPEN', cost: 200 })
    expect((await api('POST', '/camps', { ...body, deposit: 500 }, { cookie })).body.error.code).toBe('DEPOSIT_TOO_HIGH')
    expect((await api('POST', '/camps', { ...body, to: '2030-06-01' }, { cookie })).body.error.code).toBe('INVALID_DATES')
    expect((await api('POST', '/camps', { name: 'x' }, { cookie })).status).toBe(400)
  })

  it('lists hidden camps, patches status and price', async () => {
    const w = await world()
    const cookie = await staff('ADMIN')
    await api('PATCH', `/camps/${w.campId}`, { status: 'HIDDEN', cost: 250, earlyBirdToInc: null }, { cookie })
    const list = await api('GET', '/camps?status=HIDDEN', undefined, { cookie })
    expect(list.body).toHaveLength(1)
    expect(list.body[0]).toMatchObject({ status: 'HIDDEN', cost: 250 })
    expect((await api('GET', '/camps')).body).toHaveLength(0) // gone from the shop
  })

  it('lists and exports camp registrations', async () => {
    const w = await world()
    const cookie = await staff('ADMIN')
    await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: w.campId, organizationId: w.orgId, status: 'confirmed', paid: 195, tshirtSize: '140', gadgets: ['bal'] })
    const list = await api('GET', `/camps/${w.campId}/registrations`, undefined, { cookie })
    expect(list.body[0]).toMatchObject({ student: { name: 'Lars' }, user: { firstName: 'Jan' }, paid: 195 })
    const csv = await (await import('./helpers.js')).app.request(`/api/v1/camps/${w.campId}/registrations/export`, { headers: { cookie } })
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/)
    const text = await csv.text()
    expect(text.split('\n')[0]).toStartWith('naam kind;geboortedatum')
    expect(text).toContain('Lars;2015-04-12;Jan Peeters')
  })
})

describe('admin registrations', () => {
  it('filters, edits status/price/camp and refuses duplicates', async () => {
    const w = await world()
    const cookie = await staff('ADMIN')
    const reg = await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: w.campId, organizationId: w.orgId, status: 'open' })
    const other = await seedCamp(w.locationId, w.orgId, { period: '2026-zomer-2' })
    const list = await api('GET', `/registrations?status=open&locationId=${w.locationId}`, undefined, { cookie })
    expect(list.body).toHaveLength(1)
    expect((await api('GET', '/registrations?period=nope', undefined, { cookie })).body).toHaveLength(0)

    const price = await api('PATCH', `/registrations/${reg}`, { price: 100, status: 'confirmed' }, { cookie })
    expect(price.body).toMatchObject({ status: 'confirmed', price: 100, paid: 0, calculatedCost: { total: 100 } })
    const unset = await api('PATCH', `/registrations/${reg}`, { price: null }, { cookie })
    expect(unset.body.price).toBeNull()

    await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: other, organizationId: w.orgId, status: 'open', orderId: '20260101-000002' })
    const dup = await api('PATCH', `/registrations/${reg}`, { campId: String(other) }, { cookie })
    expect(dup.body.error.code).toBe('DUPLICATE_REGISTRATION')
  })

  it('admin cancel refunds to the owner even inside the cancel window', async () => {
    const w = await world()
    const cookie = await staff('ADMIN')
    const soon = await seedCamp(w.locationId, w.orgId, { from: daysFromNow(2), to: daysFromNow(6) })
    const reg = await seedRegistration({ userId: w.userId, studentId: w.studentId, campId: soon, organizationId: w.orgId, status: 'confirmed', paid: 195 })
    const res = await api('POST', `/registrations/${reg}/cancel`, undefined, { cookie })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ credit: 195, registration: { status: 'refunded', paid: 0 } })
    expect((await Users.findById(w.userId).lean())?.credit).toBe(195)
    await waitFor(() => expect(outbox.some(m => m.template === 'registrationCanceled')).toBe(true))
    expect((await api('POST', `/registrations/${reg}/cancel`, undefined, { cookie })).body.error.code).toBe('NOT_CANCELLABLE')
    expect((await Registrations.findById(reg).lean())?.status).toBe('refunded')
  })
})

describe('admin users, students, settings, places', () => {
  it('edits a user, enforces manager rules and exports CSV', async () => {
    const w = await world()
    const adminId = await seedUser({ role: 'ADMIN', email: 'a@example.com' })
    const cookie = await login(adminId)
    const res = await api('PATCH', `/users/${w.userId}`, { credit: 25, role: 'MANAGER', organizationIds: [String(w.orgId)], telephone: ['0470'] }, { cookie })
    expect(res.body).toMatchObject({ credit: 25, role: 'MANAGER', organizationIds: [String(w.orgId)] })
    expect((await api('PATCH', `/users/${w.userId}`, { organizationIds: [] }, { cookie })).body.error.code).toBe('MANAGER_NEEDS_ORGANIZATION')
    expect((await api('PATCH', `/users/${adminId}`, { role: null }, { cookie })).body.error.code).toBe('CANNOT_DEMOTE_SELF')
    const back = await api('PATCH', `/users/${w.userId}`, { role: null }, { cookie })
    expect(back.body.role).toBeNull()

    const list = await api('GET', '/users?email=peeters&role=ADMIN', undefined, { cookie })
    expect(list.body).toHaveLength(0)
    const detail = await api('GET', `/users/${w.userId}`, undefined, { cookie })
    expect(detail.body.students).toHaveLength(1)

    const { app } = await import('./helpers.js')
    const csv = await (await app.request('/api/v1/users/export?postcode=', { headers: { cookie } })).text()
    expect(csv.split('\n')[0]).toStartWith('firstName,lastName,email')
    expect(csv).toContain('Jan,Peeters')
  })

  it('edits students and settings', async () => {
    const w = await world()
    const cookie = await staff('ADMIN')
    const s = await api('PATCH', `/students/${w.studentId}`, { currentClub: 'KFC', food: ['halal'] }, { cookie })
    expect(s.body).toMatchObject({ currentClub: 'KFC', food: ['halal'] })
    expect((await api('GET', `/students?name=lar&ownerId=${w.userId}`, undefined, { cookie })).body).toHaveLength(1)
    const set = await api('PATCH', '/settings', { cancelDays: 7, earlyBirdToInc: '2030-01-01T00:00:00.000Z' }, { cookie })
    expect(set.body).toMatchObject({ cancelDays: 7, earlyBirdToInc: '2030-01-01T00:00:00.000Z', depositDays: 14 })
    expect((await api('PATCH', '/settings', { cancelDays: -1 }, { cookie })).status).toBe(400)
  })

  it('proxies places through the gateway', async () => {
    await world()
    const cookie = await staff('ADMIN')
    setPlacesGateway({
      autocomplete: async q => [{ placeId: 'place_1', description: q }],
      geocode: async id => (id === 'place_1' ? { city: 'Gent', placeId: id } : null)
    })
    expect((await api('GET', '/places/autocomplete?q=Gent', undefined, { cookie })).body).toEqual([{ placeId: 'place_1', description: 'Gent' }])
    expect((await api('GET', '/places/place_1', undefined, { cookie })).body.city).toBe('Gent')
    expect((await api('GET', '/places/nope_12', undefined, { cookie })).status).toBe(404)
  })
})

describe('logo upload', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50)])
  const uri = (type: string, buf: Buffer) => `data:image/${type};base64,${buf.toString('base64')}`
  const stored: { key: string; type: string; size: number }[] = []
  setStorageGateway({ put: async (key, body, type) => void stored.push({ key, type, size: body.length }) })

  it('stores a PNG and the returned object is accepted as a location logo', async () => {
    const w = await world()
    const cookie = await staff('ADMIN')
    const res = await api('POST', '/uploads/logo', { name: 'KFC Gent!', dataUri: uri('png', png) }, { cookie })
    expect(res.status).toBe(201)
    expect(res.body.uri).toMatch(/^https:\/\/voetbalstages\.s3\.eu-central-1\.amazonaws\.com\/kfc_gent_logo_[0-9a-f]{8}\.png$/)
    expect(stored.at(-1)).toMatchObject({ type: 'image/png', size: png.length })
    const patched = await api('PATCH', `/locations/${w.locationId}`, { logo: res.body }, { cookie })
    expect(patched.body.logo).toEqual(res.body)
  })

  it('accepts a clean SVG, rejects scripts, wrong content, oversize and foreign logo urls', async () => {
    const w = await world()
    const cookie = await staff('ADMIN')
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>')
    expect((await api('POST', '/uploads/logo', { name: 'a', dataUri: uri('svg+xml', svg) }, { cookie })).status).toBe(201)
    const evil = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    expect((await api('POST', '/uploads/logo', { name: 'a', dataUri: uri('svg+xml', evil) }, { cookie })).body.error.code).toBe('UNSAFE_SVG')
    const onload = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>')
    expect((await api('POST', '/uploads/logo', { name: 'a', dataUri: uri('svg+xml', onload) }, { cookie })).body.error.code).toBe('UNSAFE_SVG')
    expect((await api('POST', '/uploads/logo', { name: 'a', dataUri: uri('png', Buffer.from('not a png')) }, { cookie })).body.error.code).toBe('INVALID_FILE')
    expect((await api('POST', '/uploads/logo', { name: 'a', dataUri: uri('gif', png) }, { cookie })).body.error.code).toBe('INVALID_FILE')
    const big = Buffer.concat([png, Buffer.alloc(91 * 1024)])
    expect((await api('POST', '/uploads/logo', { name: 'a', dataUri: uri('png', big) }, { cookie })).status).toBe(400)
    const foreign = await api('PATCH', `/locations/${w.locationId}`, { logo: { uri: 'https://evil.example/x.png', name: 'x' } }, { cookie })
    expect(foreign.status).toBe(400)
  })

  it('is admin only', async () => {
    const w = await world()
    const body = { name: 'a', dataUri: uri('png', png) }
    expect((await api('POST', '/uploads/logo', body)).status).toBe(401)
    expect((await api('POST', '/uploads/logo', body, { cookie: w.cookie })).status).toBe(403)
    expect((await api('POST', '/uploads/logo', body, { cookie: await staff('MANAGER', [w.orgId]) })).status).toBe(403)
  })
})
