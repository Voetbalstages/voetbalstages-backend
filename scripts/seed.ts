import { Types } from 'mongoose'
import {
  Activities,
  Camps,
  LoginTokens,
  Locations,
  Organizations,
  Payments,
  Registrations,
  Sessions,
  SettingsModel,
  Students,
  Users
} from '../src/db/models/index.js'

const DAY = 24 * 60 * 60 * 1000
const daysFromNow = (d: number) => new Date(Date.now() + d * DAY)
const id = () => new Types.ObjectId()

const orderId = (createdAt: Date, n: number) =>
  `${createdAt.toISOString().slice(0, 10).replaceAll('-', '')}-${String(n).padStart(6, '0')}`

export const SEED_USERS = {
  admin: 'admin@voetbalstages.test',
  manager: 'manager@voetbalstages.test',
  parent: 'ouder@voetbalstages.test',
  parent2: 'ouder2@voetbalstages.test',
  fresh: 'nieuw@voetbalstages.test'
}

const wipe = () =>
  Promise.all(
    [Users, Students, Camps, Locations, Organizations, Registrations, Payments, SettingsModel, Activities, LoginTokens, Sessions].map(
      m => m.collection.deleteMany({})
    )
  )

/** Inserts the dev dataset. Returns false (and writes nothing) when data already exists and `reset` is off. */
export const seed = async ({ reset = false } = {}) => {
  if (reset) await wipe()
  else if ((await SettingsModel.countDocuments()) > 0) return false

  await SettingsModel.collection.insertOne({
    earlyBirdDiscount: 15,
    earlyBirdToInc: daysFromNow(21),
    depositDays: 14,
    forcePayDays: 14,
    cancelDays: 14,
    emailFrom: 'dev@voetbalstages.test',
    terms: '<h1>Algemene voorwaarden</h1><p>Dev terms. Not legal text.</p>',
    createdAt: new Date(),
    updatedAt: new Date()
  })

  // --- organizations
  const orgV = id()
  const orgK = id()
  await Organizations.collection.insertMany([
    { _id: orgV, name: 'Voetbalstages', path: 'v', mollieProfileId: 'pfl_devvoetbal', terms: '<h1>Voetbalstages</h1><p>Voorwaarden van Voetbalstages.</p>' },
    { _id: orgK, name: 'Keeper Academy', path: 'keeper', mollieProfileId: 'pfl_devkeeper', terms: '<h1>Keeper Academy</h1><p>Voorwaarden van Keeper Academy.</p>' }
  ])

  // --- locations
  const loc = (name: string, path: string, organizationId: Types.ObjectId, city: string, postcode: string, lat: number, lng: number, visibility = 'VISIBLE') => ({
    _id: id(),
    name,
    path,
    organizationId,
    visibility,
    address: { streetAddress: `Sportlaan 1`, postcode, city, district: '', province: '', formatted: `Sportlaan 1, ${postcode} ${city}`, lat, lng },
    extInfo: `<p>Praktische info voor ${name}: parking, kleedkamers en een cafetaria.</p>`,
    message: ''
  })
  const antwerpen = loc('Antwerpen', 'antwerpen', orgV, 'Antwerpen', '2000', 51.2194, 4.4025)
  const gent = loc('Gent', 'gent', orgV, 'Gent', '9000', 51.0543, 3.7174)
  const leuven = loc('Leuven', 'leuven', orgV, 'Leuven', '3000', 50.8798, 4.7005)
  const brugge = loc('Brugge', 'brugge', orgK, 'Brugge', '8000', 51.2093, 3.2247)
  const mechelen = loc('Mechelen', 'mechelen', orgV, 'Mechelen', '2800', 51.0259, 4.4776, 'AUTO')
  const hasselt = loc('Hasselt (verborgen)', 'hasselt', orgV, 'Hasselt', '3500', 50.9307, 5.3325, 'HIDDEN')
  await Locations.collection.insertMany([antwerpen, gent, leuven, brugge, mechelen, hasselt])

  // --- camps
  const camp = (
    location: { _id: Types.ObjectId },
    organizationId: Types.ObjectId,
    name: string,
    startDays: number,
    extra: Record<string, unknown> = {}
  ) => {
    const from = daysFromNow(startDays)
    return {
      _id: id(),
      locationId: location._id,
      organizationId,
      name,
      period: `${from.getFullYear()}-${name.toLowerCase().replaceAll(' ', '-')}`,
      from,
      to: daysFromNow(startDays + 4),
      cost: 195,
      deposit: 50,
      status: 'OPEN',
      options: [] as string[],
      ...extra
    }
  }
  const aPast = camp(antwerpen, orgV, 'Vorige stage', -30)
  const aEarly = camp(antwerpen, orgV, 'Zomerstage vroeg', 45, { options: ['GADGETS', 'TSHIRTSIZE'] })
  const aSizes = camp(antwerpen, orgV, 'Zomerstage maten', 52, { cost: 210, options: ['TSHIRTSIZE', 'SHORTSIZE', 'SHOESIZE'] })
  const aSoon = camp(antwerpen, orgV, 'Binnenkort', 7)
  const aHidden = camp(antwerpen, orgV, 'Verborgen stage', 60, { status: 'HIDDEN' })
  const aCanceled = camp(antwerpen, orgV, 'Geannuleerde stage', 40, { status: 'CANCELED' })
  const gOne = camp(gent, orgV, 'Zomerstage Gent 1', 60)
  const gTwo = camp(gent, orgV, 'Zomerstage Gent 2', 67)
  const lOne = camp(leuven, orgV, 'Zomerstage Leuven', 45)
  const bOne = camp(brugge, orgK, 'Keeperstage 1', 50, { cost: 240, deposit: 60 })
  const bTwo = camp(brugge, orgK, 'Keeperstage 2', 80, { cost: 240, deposit: 60 })
  const mOne = camp(mechelen, orgV, 'Zomerstage Mechelen', 55)
  const hOne = camp(hasselt, orgV, 'Zomerstage Hasselt', 55)
  await Camps.collection.insertMany([aPast, aEarly, aSizes, aSoon, aHidden, aCanceled, gOne, gTwo, lOne, bOne, bTwo, mOne, hOne])

  // --- users + students
  const now = new Date()
  const user = (email: string, firstName: string, lastName: string, extra: Record<string, unknown> = {}) => ({
    _id: id(),
    email,
    firstName,
    lastName,
    secondEmail: '',
    telephone: [] as string[],
    agreeToTerms: ['agrees'],
    organizationIds: [] as Types.ObjectId[],
    credit: 0,
    createdAt: now,
    updatedAt: now,
    ...extra
  })
  const admin = user(SEED_USERS.admin, 'Ada', 'Admin', { role: 'ADMIN' })
  const manager = user(SEED_USERS.manager, 'Mo', 'Manager', { role: 'MANAGER', organizationIds: [orgV] })
  const parent = user(SEED_USERS.parent, 'Jan', 'Peeters', {
    telephone: ['0470123456'],
    credit: 25,
    address: { streetAddress: 'Kerkstraat 12', postcode: '2000', city: 'Antwerpen', district: '', province: 'Antwerpen', formatted: 'Kerkstraat 12, 2000 Antwerpen', lat: 51.22, lng: 4.4 }
  })
  const parent2 = user(SEED_USERS.parent2, 'Sofie', 'Janssens', { telephone: ['0480111222'] })
  const fresh = user(SEED_USERS.fresh, '', '')
  await Users.collection.insertMany([admin, manager, parent, parent2, fresh])

  const student = (owner: { _id: Types.ObjectId }, name: string, dob: string, extra: Record<string, unknown> = {}) => ({
    _id: id(),
    name,
    dob,
    ownerId: [owner._id],
    food: [] as string[],
    foodOther: '',
    currentClub: '',
    remarks: '',
    createdAt: now,
    updatedAt: now,
    ...extra
  })
  const lars = student(parent, 'Lars', '2015-04-12', { currentClub: 'KFC Voorbeeld' })
  const emma = student(parent, 'Emma', '2017-09-30', { food: ['vegetarisch'] })
  const noah = student(parent, 'Noah', '2013-01-20', { foodOther: 'Notenallergie', remarks: 'Speelt keeper' })
  const milan = student(parent2, 'Milan', '2016-06-02')
  await Students.collection.insertMany([lars, emma, noah, milan])

  // --- registrations (one per order unless noted)
  type Reg = Record<string, unknown>
  let seq = 0
  const reg = (
    owner: { _id: Types.ObjectId },
    s: { _id: Types.ObjectId },
    c: { _id: Types.ObjectId; organizationId: Types.ObjectId },
    status: string,
    paid: number,
    createdDaysAgo: number,
    order: string,
    extra: Reg = {}
  ): Reg => {
    const createdAt = daysFromNow(-createdDaysAgo)
    return {
      _id: id(),
      userId: owner._id,
      studentId: s._id,
      campId: c._id,
      organizationId: c.organizationId,
      orderId: order,
      status,
      paid,
      createdAt,
      updatedAt: createdAt,
      ...extra
    }
  }
  const order = (daysAgo: number) => orderId(daysFromNow(-daysAgo), ++seq)
  const oA = order(20)
  const oD = order(1)
  const regs = [
    reg(parent, lars, aEarly, 'confirmed', 180, 20, oA, { price: 180, gadgets: ['bal', 'shirt'], tshirtSize: '140' }),
    reg(parent, emma, aEarly, 'confirmed', 180, 20, oA, { price: 180, gadgets: ['bal', 'bidon'], tshirtSize: '128' }),
    reg(parent, lars, gOne, 'open', 0, 5, order(5)),
    reg(parent, noah, gOne, 'deposited', 50, 8, order(8)),
    reg(parent, emma, lOne, 'payment_pending', 0, 1, oD, { price: 195 }),
    reg(parent, lars, aPast, 'confirmed', 195, 60, order(60)),
    reg(parent, noah, aSoon, 'confirmed', 195, 30, order(30)),
    reg(parent, emma, bOne, 'canceled', 0, 12, order(12)),
    reg(parent, noah, bOne, 'refunded', 0, 15, order(15)),
    reg(parent2, milan, aSizes, 'confirmed', 210, 10, order(10), { price: 210, tshirtSize: '152', shortSize: '152', shoeSize: 36 }),
    reg(parent2, milan, gTwo, 'open', 0, 2, order(2))
  ]
  await Registrations.collection.insertMany(regs)

  // A bank transfer that has not arrived yet, so the pending-payment flow can be tried.
  await Payments.collection.insertOne({
    id: 'tr_devseed0001',
    status: 'pending',
    amount: { value: '195.00', currency: 'EUR' },
    createdAt: new Date().toISOString(),
    expiresAt: daysFromNow(3).toISOString(),
    metadata: { orderId: oD, userId: String(parent._id), deposit: false, organizationId: String(orgV) },
    _links: { checkout: { href: 'https://dev.invalid/checkout/tr_devseed0001' } }
  })

  return true
}

if (import.meta.main) {
  const { env } = await import('../src/env.js')
  const { connectDb, disconnectDb } = await import('../src/db/connection.js')

  const host = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/:?,]+)/.exec(env.MONGO_URI)?.[1] ?? ''
  const local = ['localhost', '127.0.0.1', '::1', 'mongo', 'host.docker.internal']
  if (!local.includes(host) && process.env.SEED_FORCE !== 'true') {
    console.error(`Refusing to seed "${host}": only local databases are allowed (set SEED_FORCE=true to override).`)
    process.exit(1)
  }

  await connectDb(env.MONGO_URI)
  const reset = process.argv.includes('--reset')
  const done = await seed({ reset })
  await disconnectDb()

  if (!done) {
    console.log('Database already has data, skipping seed. Re-run with --reset to wipe and re-seed.')
  } else {
    console.log(`Seeded dev data${reset ? ' (after reset)' : ''}. Log in with a magic link for:`)
    for (const [role, email] of Object.entries(SEED_USERS)) console.log(`  ${role.padEnd(8)} ${email}`)
  }
}
