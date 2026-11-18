import type { Types } from 'mongoose'
import { env } from '../env.js'
import {
  Camps,
  Locations,
  Organizations,
  Students,
  Users,
  CANCELLABLE,
  type RegistrationStatus,
  type Settings
} from '../db/models/index.js'
import { calculateCampCost, isBefore, round2 } from '../lib/cost.js'
import type {
  CampJson,
  LocationJson,
  OrderJson,
  OrganizationJson,
  RegistrationJson,
  StudentJson,
  UserJson
} from '../schemas.js'

type Id = Types.ObjectId
const iso = (d?: Date | string | null) => (d ? new Date(d).toISOString() : null)
const str = (v: unknown) => (v == null ? '' : String(v))

const DAY = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------- users

export interface UserLike {
  _id: Id
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  secondEmail?: string | null
  telephone?: (string | null)[] | null
  credit?: number | null
  address?: Record<string, unknown> | null
  role?: string | null
}

export const serializeAddress = (a?: Record<string, unknown> | null) => {
  if (!a) return null
  const { _id, ...rest } = a as Record<string, unknown>
  return rest as UserJson['address']
}

export const serializeUser = (u: UserLike): UserJson => {
  const firstName = u.firstName ?? ''
  const lastName = u.lastName ?? ''
  return {
    id: String(u._id),
    firstName,
    lastName,
    fullName: firstName || lastName ? `${firstName} ${lastName}`.trim() : str(u.email),
    email: str(u.email),
    secondEmail: str(u.secondEmail),
    telephone: (u.telephone ?? []).filter((t): t is string => typeof t === 'string'),
    credit: round2(u.credit ?? 0),
    address: serializeAddress(u.address),
    isAdmin: u.role === 'ADMIN',
    isManager: u.role === 'MANAGER'
  }
}

// ---------------------------------------------------------------- students

export interface StudentLike {
  _id: Id
  name?: string | null
  dob?: string | null
  food?: string[] | null
  foodOther?: string | null
  currentClub?: string | null
  remarks?: string | null
  ownerId?: Id[] | null
}

export const serializeStudents = async (students: StudentLike[]): Promise<StudentJson[]> => {
  const ownerIds = [...new Set(students.flatMap(s => (s.ownerId ?? []).map(String)))]
  const owners = ownerIds.length
    ? await Users.find({ _id: { $in: ownerIds } }, { firstName: 1, lastName: 1, email: 1 }).lean()
    : []
  const byId = new Map(owners.map(o => [String(o._id), o]))
  return students.map(s => ({
    id: String(s._id),
    name: str(s.name),
    dob: str(s.dob),
    food: s.food ?? [],
    foodOther: str(s.foodOther),
    currentClub: str(s.currentClub),
    remarks: str(s.remarks),
    owner: (s.ownerId ?? [])
      .map(id => byId.get(String(id)))
      .filter(o => !!o)
      .map(o => ({
        id: String(o!._id),
        firstName: str(o!.firstName),
        lastName: str(o!.lastName),
        email: str(o!.email)
      }))
  }))
}

// ---------------------------------------------------------------- organizations

export interface OrganizationLike {
  _id: Id
  name?: string | null
  path: string
}

export const serializeOrganization = (o: OrganizationLike): OrganizationJson => ({
  id: String(o._id),
  name: str(o.name),
  path: o.path,
  url: `${env.SHOP_URL}/${o.path}`
})

const orgRefs = async (ids: (Id | null | undefined)[]) => {
  const unique = [...new Set(ids.filter(Boolean).map(String))]
  const orgs = unique.length
    ? await Organizations.find({ _id: { $in: unique } }, { name: 1 }).lean()
    : []
  return new Map(orgs.map(o => [String(o._id), { id: String(o._id), name: str(o.name) }]))
}

// ---------------------------------------------------------------- locations

export interface LocationLike {
  _id: Id
  name?: string | null
  path?: string | null
  address?: Record<string, any> | null
  extInfo?: string | null
  message?: string | null
  logo?: { uri?: string | null; name?: string | null } | null
  organizationId?: Id | null
}

export const serializeLocations = async (locations: LocationLike[]): Promise<LocationJson[]> => {
  const orgs = await orgRefs(locations.map(l => l.organizationId))
  return locations.map(l => {
    const a = l.address ?? {}
    return {
      id: String(l._id),
      path: str(l.path),
      name: str(l.name),
      logo: l.logo ? { uri: str(l.logo.uri), name: str(l.logo.name) } : null,
      address: serializeAddress(l.address),
      addressString: `${str(a.streetAddress)}, ${str(a.postcode)} ${str(a.district || a.city)}`,
      extInfo: str(l.extInfo),
      message: str(l.message),
      organization: l.organizationId ? (orgs.get(String(l.organizationId)) ?? null) : null
    }
  })
}

// ---------------------------------------------------------------- camps

export interface CampLike {
  _id: Id
  name?: string | null
  period?: string | null
  from?: Date | null
  to?: Date | null
  status?: string | null
  options?: string[] | null
  cost?: number | null
  deposit?: number | null
  earlyBirdToInc?: Date | null
  locationId: Id
  organizationId: Id
}

/** Stored OPEN but already started → CLOSED (old Camp.status resolver). */
export const campStatus = (c: CampLike, now = Date.now()): CampJson['status'] => {
  const status = (c.status ?? 'OPEN') as CampJson['status']
  if (status !== 'OPEN') return status
  return c.from && now < new Date(c.from).getTime() ? 'OPEN' : 'CLOSED'
}

export const isBookable = (c: CampLike, now = Date.now()) => campStatus(c, now) === 'OPEN'

export const serializeCamps = async (camps: CampLike[], settings: Settings): Promise<CampJson[]> => {
  const locIds = [...new Set(camps.map(c => String(c.locationId)))]
  const locations = locIds.length
    ? await Locations.find({ _id: { $in: locIds } }, 'name organizationId').lean()
    : []
  const orgs = await orgRefs(locations.map(l => l.organizationId))
  const locById = new Map(locations.map(l => [String(l._id), l]))
  return camps.map(c => {
    const cost = calculateCampCost(c, settings)
    const loc = locById.get(String(c.locationId))
    return {
      id: String(c._id),
      name: str(c.name),
      period: str(c.period),
      from: iso(c.from),
      to: iso(c.to),
      duration:
        c.from && c.to
          ? Math.round((new Date(c.to).getTime() - new Date(c.from).getTime()) / DAY + 1)
          : 0,
      status: campStatus(c),
      options: (c.options ?? []) as CampJson['options'],
      costDetail: {
        cost: cost.cost,
        currentDiscount: cost.currentDiscount,
        currentDiscountToInc: iso(cost.currentDiscountToInc),
        deposit: cost.deposit,
        depositTotal: cost.depositTotal,
        total: cost.total,
        forcePay: cost.forcePay
      },
      location: loc
        ? {
            id: String(loc._id),
            name: str(loc.name),
            organization: loc.organizationId
              ? (orgs.get(String(loc.organizationId)) ?? null)
              : null
          }
        : null
    }
  })
}

// ---------------------------------------------------------------- registrations & orders

export interface RegistrationLike {
  _id: Id
  status: RegistrationStatus
  orderId?: string | null
  paid?: number | null
  price?: number | null
  createdAt?: Date | null
  gadgets?: string[] | null
  tshirtSize?: string | null
  shortSize?: string | null
  shoeSize?: number | null
  studentId?: Id | null
  campId?: Id | null
  userId?: Id | null
  organizationId: Id
}

/** Batch-loads everything registrations refer to, so serializing N registrations is O(1) queries. */
export const loadRegistrationRefs = async (regs: RegistrationLike[]) => {
  const ids = (key: 'campId' | 'studentId') => [
    ...new Set(regs.map(r => r[key]).filter(Boolean).map(String))
  ]
  const campIds = ids('campId')
  const studentIds = ids('studentId')
  const [camps, students] = await Promise.all([
    campIds.length ? Camps.find({ _id: { $in: campIds } }).lean() : [],
    studentIds.length ? Students.find({ _id: { $in: studentIds } }, { name: 1 }).lean() : []
  ])
  const locIds = [...new Set(camps.map(c => String(c.locationId)))]
  const locations = locIds.length
    ? await Locations.find({ _id: { $in: locIds } }, 'name').lean()
    : []
  return {
    camps: new Map(camps.map(c => [String(c._id), c as CampLike])),
    students: new Map(students.map(s => [String(s._id), s])),
    locations: new Map(locations.map(l => [String(l._id), l]))
  }
}

export type RegistrationRefs = Awaited<ReturnType<typeof loadRegistrationRefs>>

/** Old Registration.canCancel resolver, with the same rules enforced on cancel. */
export const canCancel = (
  r: Pick<RegistrationLike, 'status' | 'campId'>,
  camp: CampLike | undefined,
  settings: Settings,
  now = Date.now()
) =>
  CANCELLABLE.includes(r.status) &&
  !!r.campId &&
  !!camp?.from &&
  isBefore(camp.from, settings.cancelDays ?? 14, now)

/** What the registration costs in total: the locked `price` if set, else the live camp cost. */
export const registrationPrice = (
  r: Pick<RegistrationLike, 'price'>,
  camp: CampLike | undefined,
  settings: Settings
) => {
  if (r.price) return Number(r.price)
  return camp ? calculateCampCost(camp, settings).total : 0
}

export const serializeRegistration = (
  r: RegistrationLike,
  refs: RegistrationRefs,
  settings: Settings
): RegistrationJson => {
  const camp = r.campId ? refs.camps.get(String(r.campId)) : undefined
  const student = r.studentId ? refs.students.get(String(r.studentId)) : undefined
  const location = camp ? refs.locations.get(String(camp.locationId)) : undefined
  const paid = round2(r.paid ?? 0)
  let calculatedCost: RegistrationJson['calculatedCost']
  if (r.price) {
    const price = Number(r.price)
    calculatedCost = {
      cost: price,
      currentDiscount: 0,
      subTotal: price,
      total: price,
      paid,
      toPay: round2(price - paid)
    }
  } else if (camp) {
    const c = calculateCampCost(camp, settings)
    calculatedCost = {
      cost: c.cost,
      currentDiscount: c.currentDiscount,
      subTotal: c.subTotal,
      total: c.total,
      paid,
      toPay: round2(c.total - paid)
    }
  } else {
    calculatedCost = { cost: 0, currentDiscount: 0, subTotal: 0, total: 0, paid, toPay: 0 }
  }
  return {
    id: String(r._id),
    status: r.status,
    orderId: str(r.orderId),
    paid,
    canCancel: canCancel(r, camp, settings),
    createdAt: iso(r.createdAt),
    gadgets: r.gadgets ?? [],
    tshirtSize: r.tshirtSize ?? null,
    shortSize: r.shortSize ?? null,
    shoeSize: r.shoeSize ?? null,
    student: student ? { id: String(student._id), name: str(student.name) } : null,
    camp: camp
      ? {
          id: String(camp._id),
          name: str(camp.name),
          from: iso(camp.from),
          to: iso(camp.to),
          period: str(camp.period)
        }
      : null,
    location: location ? { id: String(location._id), name: str(location.name) } : null,
    organizationId: String(r.organizationId),
    calculatedCost
  }
}

export const serializeRegistrations = async (regs: RegistrationLike[], settings: Settings) => {
  const refs = await loadRegistrationRefs(regs)
  return regs.map(r => serializeRegistration(r, refs, settings))
}

const STATUS_PRECEDENCE: RegistrationStatus[] = [
  'payment_pending',
  'open',
  'deposited',
  'confirmed',
  'refunded'
]

export const orderStatus = (regs: Pick<RegistrationLike, 'status'>[]): RegistrationStatus => {
  const statuses = new Set(regs.map(r => r.status))
  return STATUS_PRECEDENCE.find(s => statuses.has(s)) ?? 'canceled'
}

/** Groups registrations by orderId into Order objects (old Order resolvers). */
export const serializeOrders = async (
  regs: RegistrationLike[],
  settings: Settings,
  userCredit: number
): Promise<OrderJson[]> => {
  const refs = await loadRegistrationRefs(regs)
  const byOrder = new Map<string, RegistrationLike[]>()
  for (const r of regs) {
    const key = str(r.orderId)
    byOrder.set(key, [...(byOrder.get(key) ?? []), r])
  }
  const credit = round2(userCredit)
  return [...byOrder.entries()].map(([id, orderRegs]) => {
    orderRegs.sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime())
    let total = 0
    for (const r of orderRegs) {
      if (r.status === 'canceled' || r.status === 'refunded' || !r.campId) continue
      total += registrationPrice(r, refs.camps.get(String(r.campId)), settings)
    }
    total = round2(total)
    const paid = round2(orderRegs.reduce((sum, r) => sum + (r.paid ?? 0), 0))
    return {
      id,
      status: orderStatus(orderRegs),
      createdAt: iso(orderRegs[0]?.createdAt),
      registrationCount: orderRegs.length,
      calculatedCost: { total, paid, credit, open: round2(Math.max(0, total - paid - credit)) },
      registrations: orderRegs.map(r => serializeRegistration(r, refs, settings))
    }
  })
}
