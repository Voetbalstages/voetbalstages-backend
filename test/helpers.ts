import { Types } from 'mongoose'
import { createApp } from '../src/app.js'
import {
  Camps,
  Locations,
  Organizations,
  Payments,
  Registrations,
  Sessions,
  SettingsModel,
  Students,
  Users
} from '../src/db/models/index.js'
import { randomToken, sha256 } from '../src/lib/ids.js'
import { setMollieGateway, type CreatePaymentInput, type MolliePayment } from '../src/services/mollie.js'

export const app = createApp()

const DAY = 24 * 60 * 60 * 1000
export const daysFromNow = (d: number) => new Date(Date.now() + d * DAY)

type Opts = { cookie?: string; origin?: string; headers?: Record<string, string> }

export const api = async (method: string, path: string, body?: unknown, opts: Opts = {}) => {
  const headers: Record<string, string> = { ...opts.headers }
  if (method !== 'GET') headers['content-type'] = 'application/json'
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.origin) headers.origin = opts.origin
  const res = await app.request(`/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }
}

export const seedSettings = (overrides: Record<string, unknown> = {}) =>
  SettingsModel.collection.insertOne({
    earlyBirdDiscount: 15,
    earlyBirdToInc: daysFromNow(-1),
    depositDays: 14,
    forcePayDays: 14,
    cancelDays: 14,
    emailFrom: 'test@voetbalstages.be',
    terms: '<p>Global terms</p>',
    ...overrides
  })

export const seedOrg = async (overrides: Record<string, unknown> = {}) => {
  const _id = new Types.ObjectId()
  await Organizations.collection.insertOne({
    _id,
    name: 'Voetbalstages',
    path: 'v',
    mollieProfileId: 'pfl_abcdefghij',
    terms: '<p>Org terms</p>',
    ...overrides
  })
  return _id
}

export const seedLocation = async (organizationId: Types.ObjectId, overrides: Record<string, unknown> = {}) => {
  const _id = new Types.ObjectId()
  await Locations.collection.insertOne({
    _id,
    name: 'Antwerpen',
    path: 'antwerpen',
    organizationId,
    visibility: 'VISIBLE',
    address: { streetAddress: 'Straat 1', postcode: '2000', city: 'Antwerpen', district: '' },
    ...overrides
  })
  return _id
}

export const seedCamp = async (
  locationId: Types.ObjectId,
  organizationId: Types.ObjectId,
  overrides: Record<string, unknown> = {}
) => {
  const _id = new Types.ObjectId()
  await Camps.collection.insertOne({
    _id,
    locationId,
    organizationId,
    name: 'Zomerstage week 1',
    period: '2026-zomer-1',
    from: daysFromNow(60),
    to: daysFromNow(64),
    cost: 195,
    deposit: 50,
    status: 'OPEN',
    options: [],
    ...overrides
  })
  return _id
}

export const seedUser = async (overrides: Record<string, unknown> = {}) => {
  const _id = new Types.ObjectId()
  await Users.collection.insertOne({
    _id,
    email: `user-${_id}@example.com`,
    firstName: 'Jan',
    lastName: 'Peeters',
    credit: 0,
    hash: 'legacy-hash',
    salt: 'legacy-salt',
    createdAt: new Date(),
    ...overrides
  })
  return _id
}

export const login = async (userId: Types.ObjectId) => {
  const token = randomToken()
  await Sessions.create({
    _id: sha256(token),
    userId,
    expiresAt: daysFromNow(30),
    refreshedAt: new Date()
  })
  return `__Host-vs_session=${token}`
}

export const seedStudent = async (ownerId: Types.ObjectId, name = 'Lars') => {
  const doc = await Students.create({ name, dob: '2015-04-12', ownerId: [ownerId] })
  return doc._id
}

export const seedRegistration = async (overrides: Record<string, unknown>) => {
  const doc = await Registrations.collection.insertOne({
    status: 'open',
    paid: 0,
    orderId: '20260101-000001',
    createdAt: new Date(),
    ...overrides
  })
  return doc.insertedId
}

/** Base world: settings, one org, one location, one camp, one logged-in user with a student. */
export const world = async () => {
  await seedSettings()
  const orgId = await seedOrg()
  const locationId = await seedLocation(orgId)
  const campId = await seedCamp(locationId, orgId)
  const userId = await seedUser()
  const studentId = await seedStudent(userId)
  const cookie = await login(userId)
  return { orgId, locationId, campId, userId, studentId, cookie }
}

export class FakeMollie {
  created: CreatePaymentInput[] = []
  payments = new Map<string, MolliePayment>()
  failCreate = false
  private seq = 0

  install() {
    setMollieGateway({
      createPayment: async input => {
        if (this.failCreate) throw new Error('Mollie down')
        this.created.push(input)
        const id = `tr_test${++this.seq}`
        const payment: MolliePayment = {
          id,
          status: 'open',
          amount: { value: input.amount.toFixed(2), currency: 'EUR' },
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          metadata: input.metadata,
          _links: { checkout: { href: `https://mollie.test/checkout/${id}` } }
        }
        this.payments.set(id, payment)
        return payment
      },
      getPayment: async id => this.payments.get(id) ?? null
    })
    return this
  }

  setStatus(id: string, status: MolliePayment['status']) {
    this.payments.get(id)!.status = status
  }
}

export const webhook = (id: string) =>
  app.request('/api/v1/payments/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `id=${id}`
  })

export { Camps, Payments, Registrations, Users, Students, Sessions }
