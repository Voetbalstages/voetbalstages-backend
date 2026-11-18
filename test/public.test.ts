import { describe, expect, it } from 'bun:test'
import { api, daysFromNow, seedCamp, seedLocation, seedOrg, seedSettings, seedStudent, seedUser, login, seedRegistration } from './helpers.js'

describe('public catalogue', () => {
  it('lists visible locations only, with X-Total-Count', async () => {
    await seedSettings()
    const org = await seedOrg()
    await seedLocation(org)
    await seedLocation(org, { name: 'Gent', path: 'gent', visibility: 'HIDDEN' })
    const res = await api('GET', '/locations')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-total-count')).toBe('1')
    expect(res.body[0]).toMatchObject({
      path: 'antwerpen',
      addressString: 'Straat 1, 2000 Antwerpen',
      organization: { name: 'Voetbalstages' }
    })
    expect((await api('GET', '/locations/by-path/gent')).status).toBe(404)
  })

  it('never returns hidden camps and reports started camps as CLOSED', async () => {
    await seedSettings()
    const org = await seedOrg()
    const loc = await seedLocation(org)
    const open = await seedCamp(loc, org)
    await seedCamp(loc, org, { status: 'HIDDEN' })
    const started = await seedCamp(loc, org, { from: daysFromNow(-1), to: daysFromNow(3) })

    const list = await api('GET', `/locations/${loc}/camps`)
    expect(list.body.map((c: { id: string }) => c.id).sort()).toEqual([String(open), String(started)].sort())
    const closed = list.body.find((c: { id: string }) => c.id === String(started))
    expect(closed.status).toBe('CLOSED')
    expect(closed.duration).toBe(5)

    const available = await api('GET', `/camps/available?ids=${open},${started}`)
    expect(available.body.map((c: { id: string }) => c.id)).toEqual([String(open)])
  })

  it('computes costDetail server-side (early bird, deposit, force pay)', async () => {
    await seedSettings({ earlyBirdToInc: daysFromNow(10) })
    const org = await seedOrg()
    const loc = await seedLocation(org)
    const far = await seedCamp(loc, org)
    const soon = await seedCamp(loc, org, { from: daysFromNow(7), to: daysFromNow(11) })

    const farCamp = (await api('GET', `/camps/${far}`)).body
    expect(farCamp.costDetail).toMatchObject({ cost: 195, currentDiscount: 15, total: 180, deposit: 50, forcePay: false })
    const soonCamp = (await api('GET', `/camps/${soon}`)).body
    expect(soonCamp.costDetail).toMatchObject({ deposit: 0, depositTotal: 0, forcePay: true })
  })

  it('camp sub-resources split own students by registration', async () => {
    await seedSettings()
    const org = await seedOrg()
    const loc = await seedLocation(org)
    const camp = await seedCamp(loc, org)
    const userId = await seedUser()
    const booked = await seedStudent(userId, 'Booked')
    const free = await seedStudent(userId, 'Free')
    await seedRegistration({ userId, studentId: booked, campId: camp, organizationId: org, status: 'confirmed' })
    const cookie = await login(userId)

    const registered = await api('GET', `/camps/${camp}/registered-students`, undefined, { cookie })
    expect(registered.body.map((s: { name: string }) => s.name)).toEqual(['Booked'])
    const available = await api('GET', `/camps/${camp}/available-students`, undefined, { cookie })
    expect(available.body.map((s: { name: string }) => s.name)).toEqual(['Free'])
    expect((await api('GET', `/camps/${camp}/registrations`)).body).toEqual([])
    expect(free).toBeTruthy()
  })

  it('serves organizations, terms and the public settings subset', async () => {
    await seedSettings({ earlyBirdToInc: new Date('2026-05-01T00:00:00Z') })
    const org = await seedOrg()
    expect((await api('GET', `/organizations/${org}`)).body).toEqual({
      id: String(org),
      name: 'Voetbalstages',
      path: 'v',
      url: 'https://shop.test/v'
    })
    expect((await api('GET', '/organizations/by-path/v')).body.id).toBe(String(org))
    expect((await api('GET', '/organizations/v/terms')).body).toEqual({ terms: '<p>Org terms</p>' })
    expect((await api('GET', '/terms')).body).toEqual({ terms: '<p>Global terms</p>' })
    expect((await api('GET', '/settings')).body).toEqual({ earlyBirdToInc: '2026-05-01T00:00:00.000Z' })
  })

  it('serves the OpenAPI document', async () => {
    const res = await api('GET', '/openapi.json')
    expect(res.status).toBe(200)
    expect(Object.keys(res.body.paths)).toContain('/api/v1/orders/{orderId}/payment')
  })
})

describe('students', () => {
  it('CRUD scoped to the owner', async () => {
    await seedSettings()
    const me = await seedUser()
    const other = await seedUser()
    const cookie = await login(me)
    const otherStudent = await seedStudent(other)

    const created = await api('POST', '/students', { name: 'Lars', dob: '2015-04-12', food: ['vegetarisch'] }, { cookie })
    expect(created.status).toBe(201)
    expect(created.body.owner[0].id).toBe(String(me))

    const list = await api('GET', '/students', undefined, { cookie })
    expect(list.body).toHaveLength(1)

    expect((await api('GET', `/students/${otherStudent}`, undefined, { cookie })).status).toBe(404)
    expect((await api('PATCH', `/students/${otherStudent}`, { name: 'x' }, { cookie })).status).toBe(404)
    expect((await api('DELETE', `/students/${otherStudent}`, undefined, { cookie })).status).toBe(404)

    const patched = await api('PATCH', `/students/${created.body.id}`, { remarks: 'allergie' }, { cookie })
    expect(patched.body.remarks).toBe('allergie')
    expect((await api('DELETE', `/students/${created.body.id}`, undefined, { cookie })).status).toBe(204)
  })
})

describe('OpenAPI document', () => {
  it('has no regex flags leaked into string patterns (Swagger UI validates them client-side)', async () => {
    const res = await api('GET', '/openapi.json')
    const patterns = [...JSON.stringify(res.body).matchAll(/"pattern":"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]!)
    expect(patterns.length).toBeGreaterThan(0)
    for (const p of patterns) expect(p).not.toMatch(/\/[gimsuy]+$/)
    const id = '6afd87132eccafb885411d15'
    const objectId = patterns.find(p => p.includes('{24}'))!
    expect(new RegExp(JSON.parse(`"${objectId}"`)).test(id)).toBe(true)
  })
})
