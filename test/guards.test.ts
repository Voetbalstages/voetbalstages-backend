import { describe, expect, it } from 'bun:test'
import { Sessions, Students, api, daysFromNow, login, seedStudent, seedUser, world } from './helpers.js'
import { randomToken, sha256 } from '../src/lib/ids.js'

describe('authentication required', () => {
  const protectedRoutes: [string, string, unknown?][] = [
    ['GET', '/me'],
    ['PATCH', '/me', {}],
    ['GET', '/students'],
    ['POST', '/students', { name: 'x' }],
    ['GET', '/students/507f1f77bcf86cd799439011'],
    ['PATCH', '/students/507f1f77bcf86cd799439011', {}],
    ['DELETE', '/students/507f1f77bcf86cd799439011'],
    ['GET', '/orders'],
    ['POST', '/orders', { registrations: [{ campId: '507f1f77bcf86cd799439011', studentId: '507f1f77bcf86cd799439012' }] }],
    ['GET', '/orders/20260101-000001'],
    ['POST', '/orders/20260101-000001/payment', {}],
    ['GET', '/registrations'],
    ['GET', '/registrations/507f1f77bcf86cd799439011'],
    ['POST', '/registrations/507f1f77bcf86cd799439011/cancel', {}]
  ]

  it.each(protectedRoutes)('%s %s is 401 for anonymous callers', async (method, path, body) => {
    const res = await api(method, path, body)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBeTruthy()
  })

  it('/auth/me answers null instead of 401 when logged out', async () => {
    const res = await api('GET', '/auth/me')
    expect(res.status).toBe(200)
    expect(res.body).toBeNull()
  })

  it('camp sub-resources answer [] instead of 401 when logged out', async () => {
    const w = await world()
    for (const sub of ['available-students', 'registered-students', 'registrations']) {
      const res = await api('GET', `/camps/${w.campId}/${sub}`)
      expect(res.status).toBe(200)
      expect(res.body).toEqual([])
    }
  })

  it('rejects an unknown session cookie and an expired session', async () => {
    const w = await world()
    expect((await api('GET', '/me', undefined, { cookie: '__Host-vs_session=garbage' })).status).toBe(401)

    const token = randomToken()
    await Sessions.create({ _id: sha256(token), userId: w.userId, expiresAt: daysFromNow(-1), refreshedAt: new Date() })
    expect((await api('GET', '/me', undefined, { cookie: `__Host-vs_session=${token}` })).status).toBe(401)
  })
})

describe('GET /me', () => {
  it('returns the profile with fullName, credit and role flags', async () => {
    const w = await world()
    const res = await api('GET', '/me', undefined, { cookie: w.cookie })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: String(w.userId),
      firstName: 'Jan',
      lastName: 'Peeters',
      fullName: 'Jan Peeters',
      credit: 0,
      isAdmin: false,
      isManager: false
    })
    expect(res.body).not.toHaveProperty('hash')
    expect(res.body).not.toHaveProperty('salt')
    expect(res.body).not.toHaveProperty('_id')
    expect(JSON.stringify(res.body)).not.toMatch(/legacy-hash|legacy-salt|\$__/)
  })

  it('falls back to the email as fullName when both names are empty', async () => {
    const id = await seedUser({ firstName: '', lastName: '', email: 'nameless@example.com' })
    const res = await api('GET', '/me', undefined, { cookie: await login(id) })
    expect(res.body.fullName).toBe('nameless@example.com')
  })

  it('PATCH validates input and never touches credit, role or email', async () => {
    const w = await world()
    const patched = await api(
      'PATCH',
      '/me',
      { telephone: ['0470123456'], address: { postcode: '2000' }, secondEmail: 'partner@example.com' },
      { cookie: w.cookie }
    )
    expect(patched.status).toBe(200)
    expect(patched.body).toMatchObject({ telephone: ['0470123456'], secondEmail: 'partner@example.com' })
    expect(patched.body.address.postcode).toBe('2000')
    expect(JSON.stringify(patched.body)).not.toMatch(/legacy-hash|legacy-salt|\$__/)

    for (const forbidden of [{ credit: 999 }, { role: 'admin' }, { email: 'x@y.be' }, { organizationIds: [] }]) {
      expect((await api('PATCH', '/me', forbidden, { cookie: w.cookie })).status).toBe(400)
    }
    expect((await api('PATCH', '/me', { secondEmail: 'not-an-email' }, { cookie: w.cookie })).status).toBe(400)
    expect((await api('PATCH', '/me', { telephone: new Array(6).fill('1') }, { cookie: w.cookie })).status).toBe(400)
    expect((await api('GET', '/me', undefined, { cookie: w.cookie })).body.credit).toBe(0)
  })
})

describe('students validation', () => {
  it('requires a name and rejects unknown or oversized fields', async () => {
    const w = await world()
    const post = (body: unknown) => api('POST', '/students', body, { cookie: w.cookie })
    expect((await post({})).status).toBe(400)
    expect((await post({ name: '   ' })).status).toBe(400)
    expect((await post({ name: 'x'.repeat(101) })).status).toBe(400)
    expect((await post({ name: 'Lars', ownerId: [String(w.userId)] })).status).toBe(400)
    expect((await post({ name: 'Lars', remarks: 'x'.repeat(2001) })).status).toBe(400)
    expect((await post({ name: 'Lars', food: 'vegetarisch' })).status).toBe(400)
  })

  it('creates with defaults and trims the name', async () => {
    const w = await world()
    const res = await api('POST', '/students', { name: '  Emma  ' }, { cookie: w.cookie })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ name: 'Emma', food: [], foodOther: '', currentClub: '', remarks: '' })
  })

  it('PATCH cannot reassign ownership and delete really removes the document', async () => {
    const w = await world()
    const other = await seedUser()
    const res = await api('PATCH', `/students/${w.studentId}`, { ownerId: [String(other)] }, { cookie: w.cookie })
    expect(res.status).toBe(400)

    const id = await seedStudent(w.userId, 'Temp')
    expect((await api('DELETE', `/students/${id}`, undefined, { cookie: w.cookie })).status).toBe(204)
    expect(await Students.findById(id)).toBeNull()
    expect((await api('GET', `/students/${id}`, undefined, { cookie: w.cookie })).status).toBe(404)
  })

  it('GET /students/{id} returns the owner summary', async () => {
    const w = await world()
    const res = await api('GET', `/students/${w.studentId}`, undefined, { cookie: w.cookie })
    expect(res.status).toBe(200)
    expect(res.body.owner[0]).toMatchObject({ id: String(w.userId), firstName: 'Jan', lastName: 'Peeters' })
  })
})
