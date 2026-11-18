import { describe, expect, it } from 'vitest'
import { api, daysFromNow, seedCamp, seedLocation, seedOrg, seedSettings } from './helpers.js'

const ids = (body: { id: string }[]) => body.map(r => r.id)

const catalogue = async () => {
  await seedSettings()
  const orgA = await seedOrg()
  const orgB = await seedOrg({ path: 'b', name: 'Other org' })
  const antwerpen = await seedLocation(orgA)
  const gent = await seedLocation(orgB, {
    name: 'Gent',
    path: 'gent',
    address: { streetAddress: 'Plein 2', postcode: '9000', city: 'Gent', district: '' }
  })
  return { orgA, orgB, antwerpen, gent }
}

describe('GET /locations', () => {
  it('filters by organizationId and free-text q (name, city, postcode)', async () => {
    const c = await catalogue()
    const byOrg = await api('GET', `/locations?organizationId=${c.orgB}`)
    expect(ids(byOrg.body)).toEqual([String(c.gent)])
    expect(ids((await api('GET', '/locations?q=gen')).body)).toEqual([String(c.gent)])
    expect(ids((await api('GET', '/locations?q=2000')).body)).toEqual([String(c.antwerpen)])
    expect(ids((await api('GET', '/locations?q=antwerp')).body)).toEqual([String(c.antwerpen)])
    expect((await api('GET', '/locations?q=nothing-matches')).body).toEqual([])
  })

  it('treats q as text, not as a regex', async () => {
    await catalogue()
    const res = await api('GET', '/locations?q=.*')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('filters by visibility and never exposes HIDDEN, even when asked for', async () => {
    const c = await catalogue()
    await seedLocation(c.orgA, { name: 'Auto', path: 'auto', visibility: 'AUTO' })
    await seedLocation(c.orgA, { name: 'Hidden', path: 'hidden', visibility: 'HIDDEN' })
    const visible = await api('GET', '/locations?visibility=VISIBLE')
    expect(visible.body.map((l: { path: string }) => l.path).sort()).toEqual(['antwerpen', 'gent'])
    const auto = await api('GET', '/locations?visibility=AUTO')
    expect(auto.body.map((l: { path: string }) => l.path)).toEqual(['auto'])
    expect((await api('GET', '/locations?visibility=HIDDEN')).status).toBe(400)
  })

  it('sorts by name asc by default and supports order=desc and pagination', async () => {
    await catalogue()
    expect((await api('GET', '/locations')).body.map((l: { name: string }) => l.name)).toEqual(['Antwerpen', 'Gent'])
    expect((await api('GET', '/locations?order=desc')).body.map((l: { name: string }) => l.name)).toEqual(['Gent', 'Antwerpen'])
    const page = await api('GET', '/locations?perPage=1&page=1')
    expect(page.headers.get('x-total-count')).toBe('2')
    expect(page.body.map((l: { name: string }) => l.name)).toEqual(['Gent'])
  })
})

describe('GET /locations/{id} and /by-path/{path}', () => {
  it('resolves a location by id and by slug', async () => {
    const c = await catalogue()
    const byId = await api('GET', `/locations/${c.antwerpen}`)
    expect(byId.status).toBe(200)
    expect(byId.body).toMatchObject({ id: String(c.antwerpen), path: 'antwerpen', organization: { id: String(c.orgA) } })
    expect((await api('GET', '/locations/by-path/gent')).body.id).toBe(String(c.gent))
  })

  it('404s for unknown and hidden locations, 400 for malformed ids', async () => {
    const c = await catalogue()
    const hidden = await seedLocation(c.orgA, { path: 'hidden', visibility: 'HIDDEN' })
    expect((await api('GET', `/locations/${hidden}`)).status).toBe(404)
    expect((await api('GET', `/locations/${c.orgA}`)).status).toBe(404)
    expect((await api('GET', '/locations/by-path/unknown')).status).toBe(404)
    expect((await api('GET', '/locations/nope')).status).toBe(400)
    expect((await api('GET', `/locations/${hidden}/camps`)).status).toBe(404)
  })
})

describe('GET /locations/{id}/camps filters', () => {
  it('filters by year, period and excludePast, sorted by start date', async () => {
    const c = await catalogue()
    const past = await seedCamp(c.antwerpen, c.orgA, { from: new Date('2020-07-06'), to: new Date('2020-07-10'), period: '2020-zomer-1' })
    const later = await seedCamp(c.antwerpen, c.orgA, { from: daysFromNow(90), to: daysFromNow(94), period: '2026-zomer-2' })
    const sooner = await seedCamp(c.antwerpen, c.orgA, { from: daysFromNow(30), to: daysFromNow(34), period: '2026-zomer-1' })

    const all = await api('GET', `/locations/${c.antwerpen}/camps`)
    expect(ids(all.body)).toEqual([String(past), String(sooner), String(later)])
    expect(ids((await api('GET', `/locations/${c.antwerpen}/camps?year=2020`)).body)).toEqual([String(past)])
    expect(ids((await api('GET', `/locations/${c.antwerpen}/camps?excludePast=true`)).body)).toEqual([String(sooner), String(later)])
    expect(ids((await api('GET', `/locations/${c.antwerpen}/camps?period=2026-zomer-2`)).body)).toEqual([String(later)])
  })

  it('does not leak camps of other locations', async () => {
    const c = await catalogue()
    await seedCamp(c.gent, c.orgB)
    expect((await api('GET', `/locations/${c.antwerpen}/camps`)).body).toEqual([])
  })
})

describe('GET /camps', () => {
  it('filters by locationId, organizationId, period and ids', async () => {
    const c = await catalogue()
    const a = await seedCamp(c.antwerpen, c.orgA, { period: '2026-zomer-1' })
    const b = await seedCamp(c.gent, c.orgB, { period: '2026-zomer-2' })

    expect(ids((await api('GET', `/camps?locationId=${c.gent}`)).body)).toEqual([String(b)])
    expect(ids((await api('GET', `/camps?organizationId=${c.orgA}`)).body)).toEqual([String(a)])
    expect(ids((await api('GET', '/camps?period=2026-zomer-2')).body)).toEqual([String(b)])
    expect(ids((await api('GET', `/camps?ids=${a},${b}`)).body).sort()).toEqual([String(a), String(b)].sort())
    expect(ids((await api('GET', `/camps?ids=${a}`)).body)).toEqual([String(a)])
  })

  it('filters by year and excludePast, and never lists hidden camps', async () => {
    const c = await catalogue()
    const past = await seedCamp(c.antwerpen, c.orgA, { from: new Date('2020-07-06'), to: new Date('2020-07-10') })
    const future = await seedCamp(c.antwerpen, c.orgA)
    await seedCamp(c.antwerpen, c.orgA, { status: 'HIDDEN' })

    expect(ids((await api('GET', '/camps?year=2020')).body)).toEqual([String(past)])
    expect(ids((await api('GET', '/camps?excludePast=true')).body)).toEqual([String(future)])
    expect((await api('GET', '/camps')).body).toHaveLength(2)
  })

  it('searches name and period case-insensitively, as text and not as a regex', async () => {
    const c = await catalogue()
    const a = await seedCamp(c.antwerpen, c.orgA, { name: 'Keeperstage', period: '2026-herfst-1' })
    await seedCamp(c.antwerpen, c.orgA, { name: 'Zomerstage', period: '2026-zomer-1' })

    expect(ids((await api('GET', '/camps?q=KEEPER')).body)).toEqual([String(a)])
    expect(ids((await api('GET', '/camps?q=herfst')).body)).toEqual([String(a)])
    expect((await api('GET', '/camps?q=.*')).body).toEqual([])
  })

  it('paginates and sorts', async () => {
    const c = await catalogue()
    const early = await seedCamp(c.antwerpen, c.orgA, { from: daysFromNow(10), to: daysFromNow(14), name: 'B', period: '2026-b' })
    const late = await seedCamp(c.antwerpen, c.orgA, { from: daysFromNow(40), to: daysFromNow(44), name: 'A', period: '2026-a' })

    const byFrom = await api('GET', '/camps?sort=from&order=asc')
    expect(ids(byFrom.body)).toEqual([String(early), String(late)])
    const byName = await api('GET', '/camps?sort=name&order=asc')
    expect(ids(byName.body)).toEqual([String(late), String(early)])
    const page = await api('GET', '/camps?sort=from&order=asc&perPage=1&page=1')
    expect(page.headers.get('x-total-count')).toBe('2')
    expect(ids(page.body)).toEqual([String(late)])
  })

  it('400s on invalid filters', async () => {
    await catalogue()
    expect((await api('GET', '/camps?locationId=bad')).status).toBe(400)
    expect((await api('GET', '/camps?year=1800')).status).toBe(400)
    expect((await api('GET', '/camps?sort=cost')).status).toBe(400)
  })
})

describe('GET /camps/{id} and /camps/available', () => {
  it('404s for hidden and unknown camps, 400 for malformed ids', async () => {
    const c = await catalogue()
    const hidden = await seedCamp(c.antwerpen, c.orgA, { status: 'HIDDEN' })
    expect((await api('GET', `/camps/${hidden}`)).status).toBe(404)
    expect((await api('GET', `/camps/${c.orgA}`)).status).toBe(404)
    expect((await api('GET', '/camps/nope')).status).toBe(400)
  })

  it('exposes location, organization and options on a single camp', async () => {
    const c = await catalogue()
    const id = await seedCamp(c.antwerpen, c.orgA, { options: ['GADGETS', 'TSHIRTSIZE'] })
    const res = await api('GET', `/camps/${id}`)
    expect(res.body).toMatchObject({
      id: String(id),
      status: 'OPEN',
      options: ['GADGETS', 'TSHIRTSIZE'],
      location: { id: String(c.antwerpen), name: 'Antwerpen', organization: { id: String(c.orgA) } }
    })
  })

  it('available returns [] without ids and drops hidden, closed and unknown camps', async () => {
    const c = await catalogue()
    const open = await seedCamp(c.antwerpen, c.orgA)
    const closed = await seedCamp(c.antwerpen, c.orgA, { status: 'CLOSED' })
    const hidden = await seedCamp(c.antwerpen, c.orgA, { status: 'HIDDEN' })
    expect((await api('GET', '/camps/available')).body).toEqual([])
    const res = await api('GET', `/camps/available?ids=${open},${closed},${hidden},${c.orgA}`)
    expect(ids(res.body)).toEqual([String(open)])
  })
})
