import type { FilterQuery } from 'mongoose'
import { Camps, Locations, Registrations, Students, Users } from '../db/models/index.js'
import { toCsv } from '../lib/csv.js'

const MONTHS: Record<string, string> = {
  januari: '01', februari: '02', maart: '03', april: '04', mei: '05', juni: '06', juli: '07',
  augustus: '08', september: '09', oktober: '10', november: '11', december: '12',
  january: '01', february: '02', march: '03', may: '05', june: '06', july: '07', august: '08', october: '10'
}
const p2 = (s: string) => s.padStart(2, '0')

/** Ported from the old exportUsers: free-text birth dates in many formats → Date. */
export const parseDob = (str?: string | null): Date | null => {
  if (!str) return null
  const s = str.trim()
  let m
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s)
  if ((m = s.match(/^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{4})$/))) return new Date(`${m[3]}-${p2(m[2]!)}-${p2(m[1]!)}`)
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/))) {
    return new Date(`${+m[3]! < 50 ? '20' : '19'}${m[3]}-${p2(m[2]!)}-${p2(m[1]!)}`)
  }
  if ((m = s.match(/^(\d{2})(\d{2})(\d{4})$/)) && +m[1]! >= 1 && +m[1]! <= 31 && +m[2]! >= 1 && +m[2]! <= 12 && +m[3]! >= 1990 && +m[3]! <= 2030) {
    return new Date(`${m[3]}-${m[2]}-${m[1]}`)
  }
  if ((m = s.toLowerCase().match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/)) && MONTHS[m[2]!]) {
    return new Date(`${m[3]}-${MONTHS[m[2]!]}-${p2(m[1]!)}`)
  }
  return null
}

const normalizeDob = (s?: string | null) => {
  const d = parseDob(s)
  return d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : (s ?? '')
}
const day = (d?: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : '')

const HEADERS = [
  'firstName', 'lastName', 'email', 'secondEmail', 'telephone', 'role', 'credit', 'streetAddress', 'postcode',
  'city', 'province', 'createdAt', 'totalChildren', 'oldestChild', 'youngestChild', 'totalRegistrations',
  'firstRegistration', 'lastRegistration', 'firstLocation', 'lastLocation', 'firstCampYear', 'lastCampDate',
  'totalSpend', 'avgSpendPerRegistration', 'hasAbandonedRegistration', 'foodRestrictions', 'currentClubs', 'campOptions'
]

/** User export for email marketing (same columns as the old `/api/users/export`). */
export const exportUsersCsv = async (query: FilterQuery<unknown>) => {
  const users = await Users.find(query).lean()
  const userIds = users.map(u => u._id)
  const [students, confirmed, abandoned] = await Promise.all([
    Students.find({ ownerId: { $in: userIds } }).lean(),
    Registrations.find({ userId: { $in: userIds }, status: 'confirmed' }).lean(),
    Registrations.find({ userId: { $in: userIds }, status: { $in: ['open', 'payment_pending'] } }, { userId: 1 }).lean()
  ])
  const camps = await Camps.find({ _id: { $in: [...new Set(confirmed.map(r => String(r.campId)).filter(x => x !== 'undefined'))] } }).lean()
  const locations = await Locations.find({ _id: { $in: [...new Set(camps.map(c => String(c.locationId)))] } }, 'name').lean()
  const campById = new Map(camps.map(c => [String(c._id), c]))
  const locById = new Map(locations.map(l => [String(l._id), l]))
  const studentsByUser = new Map<string, typeof students>()
  for (const s of students) for (const o of s.ownerId ?? []) studentsByUser.set(String(o), [...(studentsByUser.get(String(o)) ?? []), s])
  const regsByUser = new Map<string, typeof confirmed>()
  for (const r of confirmed) regsByUser.set(String(r.userId), [...(regsByUser.get(String(r.userId)) ?? []), r])
  const abandonedUsers = new Set(abandoned.map(r => String(r.userId)))

  const rows = users.map(u => {
    const id = String(u._id)
    const kids = studentsByUser.get(id) ?? []
    const regs = [...(regsByUser.get(id) ?? [])].sort((a, b) => +new Date(a.createdAt!) - +new Date(b.createdAt!))
    const byDob = kids
      .filter(k => k.dob)
      .sort((a, b) => {
        const da = parseDob(a.dob)
        const db = parseDob(b.dob)
        return da && db ? +da - +db : (a.dob ?? '').localeCompare(b.dob ?? '')
      })
    const first = regs[0]
    const last = regs[regs.length - 1]
    const firstCamp = first && campById.get(String(first.campId))
    const lastCamp = last && campById.get(String(last.campId))
    const spend = regs.reduce((sum, r) => sum + (r.paid ?? 0), 0)
    const options = new Set<string>()
    for (const r of regs) {
      campById.get(String(r.campId))?.options?.forEach(o => options.add(o))
      r.gadgets?.forEach(g => options.add(g))
    }
    return {
      firstName: u.firstName, lastName: u.lastName, email: u.email, secondEmail: u.secondEmail,
      telephone: (u.telephone ?? []).join(', '), role: u.role ?? '', credit: u.credit ?? 0,
      streetAddress: u.address?.streetAddress, postcode: u.address?.postcode, city: u.address?.city,
      province: u.address?.province, createdAt: day(u.createdAt), totalChildren: kids.length,
      oldestChild: normalizeDob(byDob[0]?.dob), youngestChild: normalizeDob(byDob[byDob.length - 1]?.dob),
      totalRegistrations: regs.length, firstRegistration: day(first?.createdAt), lastRegistration: day(last?.createdAt),
      firstLocation: firstCamp ? locById.get(String(firstCamp.locationId))?.name : '',
      lastLocation: lastCamp ? locById.get(String(lastCamp.locationId))?.name : '',
      firstCampYear: firstCamp?.from ? new Date(firstCamp.from).getUTCFullYear() : '',
      lastCampDate: day(lastCamp?.to), totalSpend: spend,
      avgSpendPerRegistration: regs.length ? (spend / regs.length).toFixed(2) : '',
      hasAbandonedRegistration: abandonedUsers.has(id) ? 'yes' : 'no',
      foodRestrictions: [...new Set(kids.flatMap(k => k.food ?? []).filter(Boolean))].join(', '),
      currentClubs: [...new Set(kids.map(k => k.currentClub).filter(Boolean))].join(', '),
      campOptions: [...options].join(', ')
    }
  })
  return { csv: toCsv(HEADERS, rows), count: rows.length }
}
