import type { Context } from 'hono'
import { Types } from 'mongoose'
import type { UserDoc } from '../db/models/index.js'
import { forbidden, unauthorized } from '../lib/errors.js'
import type { AppEnv } from '../types.js'

export interface Staff {
  user: UserDoc
  isAdmin: boolean
  isManager: boolean
  /** Organizations a manager may see. `null` for admins (everything). */
  organizationIds: Types.ObjectId[] | null
}

/** ADMIN or MANAGER (a manager with no organizations sees nothing). 401 anonymous, 403 parents. */
export const requireStaff = (c: Context<AppEnv>): Staff => {
  const user = c.get('user')
  if (!user) throw unauthorized()
  const isAdmin = user.role === 'ADMIN'
  const isManager = user.role === 'MANAGER'
  if (!isAdmin && !isManager) throw forbidden('Admin or manager role required')
  return { user, isAdmin, isManager, organizationIds: isAdmin ? null : (user.organizationIds ?? []) }
}

/** ADMIN only. Managers are read-only, exactly like the old server. */
export const requireAdmin = (c: Context<AppEnv>): Staff => {
  const staff = requireStaff(c)
  if (!staff.isAdmin) throw forbidden('Admin role required')
  return staff
}

/**
 * Mongo condition limiting `field` to the organizations the caller may see, optionally narrowed
 * to one requested organization. Admins: no restriction unless `requested` is given.
 */
export const orgScope = (staff: Staff, requested?: string | null, field = 'organizationId') => {
  const allowed = staff.organizationIds?.map(String)
  if (requested) {
    if (allowed && !allowed.includes(requested)) return { [field]: { $in: [] } }
    return { [field]: new Types.ObjectId(requested) }
  }
  return allowed ? { [field]: { $in: staff.organizationIds } } : {}
}

/** Staff view of the caller, or `null` for anonymous callers and plain parents. Never throws. */
export const optionalStaff = (c: Context<AppEnv>): Staff | null => {
  const user = c.get('user')
  if (!user || (user.role !== 'ADMIN' && user.role !== 'MANAGER')) return null
  return requireStaff(c)
}

/**
 * Filter for resources that have a public face (camps, locations): everyone gets `publicCond`;
 * a MANAGER additionally gets everything of their own organizations; an ADMIN gets everything.
 */
export const visibleTo = (staff: Staff | null, publicCond: Record<string, unknown>, field = 'organizationId') => {
  if (!staff) return publicCond
  if (staff.isAdmin) return {}
  return { $or: [publicCond, { [field]: { $in: staff.organizationIds } }] }
}

/** True when `staff` may see/edit things of this organization. */
export const inScope = (staff: Staff | null, organizationId: unknown) =>
  !!staff && (staff.isAdmin || !!staff.organizationIds?.some(id => String(id) === String(organizationId)))
