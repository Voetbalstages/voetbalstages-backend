import { Types } from 'mongoose'
import {
  Camps,
  Registrations,
  Students,
  getSettings,
  ACTIVE,
  type CampOption,
  type UserDoc
} from '../db/models/index.js'
import { badRequest, conflict, notFound } from '../lib/errors.js'
import { calculateCampCost } from '../lib/cost.js'
import { newOrderId } from '../lib/ids.js'
import { withLock } from '../lib/mutex.js'
import { reportError } from '../logger.js'
import { isBookable, type CampLike, type RegistrationLike } from '../serializers/index.js'
import { activePaymentFor, charge, withCamps } from './payments.js'
import { sendOrderMail } from './orderMail.js'
import { fireBookingWebhook } from './tracking.js'
import { logActivity } from './activity.js'

export interface OrderItemInput {
  campId: string
  studentId: string
  gadgets?: string[]
  tshirtSize?: string
  shortSize?: string
  shoeSize?: number
}

export interface CreateOrderInput {
  registrations: OrderItemInput[]
  payNow: boolean
  deposit: boolean
  tracking?: Record<string, unknown>
}

const optionFields: Record<CampOption, (item: OrderItemInput) => Record<string, unknown> | null> = {
  GADGETS: i =>
    Array.isArray(i.gadgets) && i.gadgets.length === 2 && i.gadgets.every(g => g.trim())
      ? { gadgets: i.gadgets }
      : null,
  TSHIRTSIZE: i => (i.tshirtSize?.trim() ? { tshirtSize: i.tshirtSize } : null),
  SHORTSIZE: i => (i.shortSize?.trim() ? { shortSize: i.shortSize } : null),
  SHOESIZE: i => (typeof i.shoeSize === 'number' ? { shoeSize: i.shoeSize } : null)
}

/**
 * Checkout. Everything is validated before anything is written; registrations are inserted
 * sequentially and removed again if anything fails afterwards.
 */
export const createOrder = (user: UserDoc, input: CreateOrderInput) =>
  withLock(String(user._id), async () => {
    const items = input.registrations
    const pairs = new Set<string>()
    for (const item of items) {
      const key = `${item.studentId}:${item.campId}`
      if (pairs.has(key)) throw conflict('DUPLICATE_IN_ORDER', 'Same student and camp twice in one order')
      pairs.add(key)
    }

    const studentIds = [...new Set(items.map(i => i.studentId))]
    const students = await Students.find({ _id: { $in: studentIds }, ownerId: user._id }, { _id: 1 }).lean()
    if (students.length !== studentIds.length) throw notFound('Student')

    const campIds = [...new Set(items.map(i => i.campId))]
    const camps = (await Camps.find({ _id: { $in: campIds } }).lean()) as CampLike[]
    if (camps.length !== campIds.length) throw notFound('Camp')
    const campById = new Map(camps.map(c => [String(c._id), c]))

    if (camps.some(c => !isBookable(c))) {
      throw conflict('CAMP_NOT_BOOKABLE', 'One of the camps can no longer be booked')
    }
    if (new Set(camps.map(c => String(c.organizationId))).size > 1) {
      throw conflict('MIXED_ORGANIZATIONS', 'Orders can only contain camps of one organization')
    }

    const settings = await getSettings()
    if (input.deposit) {
      const noDeposit = camps.some(c => {
        const cost = calculateCampCost(c, settings)
        return cost.forcePay || cost.depositTotal <= 0
      })
      if (noDeposit) throw badRequest('DEPOSIT_NOT_AVAILABLE', 'A deposit is not possible for this order')
    }

    const docs = items.map(item => {
      const camp = campById.get(item.campId)!
      const extra: Record<string, unknown> = {}
      for (const option of (camp.options ?? []) as CampOption[]) {
        const fields = optionFields[option]?.(item)
        if (!fields) throw badRequest('MISSING_OPTION', `Camp option ${option} is required`)
        Object.assign(extra, fields)
      }
      return {
        studentId: new Types.ObjectId(item.studentId),
        campId: camp._id,
        userId: user._id,
        organizationId: camp.organizationId,
        ...extra
      }
    })

    const existing = await Registrations.findOne({
      $or: docs.map(d => ({ studentId: d.studentId, campId: d.campId })),
      status: { $in: ACTIVE }
    }).lean()
    if (existing) throw conflict('ALREADY_REGISTERED', 'This student is already registered for this camp')

    const orderId = newOrderId()
    const status = input.payNow ? 'payment_pending' : 'open'
    let created: RegistrationLike[] = []
    let payUrl: string | null = null
    let credit = user.credit ?? 0
    try {
      for (const doc of docs) {
        const reg = await Registrations.create({ ...doc, orderId, status })
        created.push(reg.toObject() as RegistrationLike)
      }
      if (input.payNow) {
        const result = await charge({
          user,
          orderId,
          registrations: await withCamps(created),
          deposit: input.deposit,
          isNewOrder: true
        })
        payUrl = result.payUrl
        credit = result.credit
      }
    } catch (err) {
      await Registrations.deleteMany({ orderId }).catch(e => reportError(e, { orderId }))
      throw err
    }

    created = (await Registrations.find({ orderId }).lean()) as RegistrationLike[]
    sendOrderMail({ registrations: created, orderId, user, template: 'orderConfirmed' }).catch(err =>
      reportError(err, { orderId })
    )
    fireBookingWebhook({ user, registrations: created, orderId, tracking: input.tracking })
    logActivity(user._id, 'ORDER')

    return { orderId, payUrl, credit }
  })

/** (Re)start payment for an outstanding order owned by the caller. */
export const payOrder = (user: UserDoc, orderId: string) =>
  withLock(String(user._id), async () => {
    const regs = (await Registrations.find({ orderId, userId: user._id }).lean()) as RegistrationLike[]
    if (!regs.length) throw notFound('Order')

    const active = await activePaymentFor(orderId)
    if (active?.kind === 'reuse') return { payUrl: active.href, credit: user.credit ?? 0 }
    if (active?.kind === 'pending') {
      throw conflict('PAYMENT_PENDING', 'A payment for this order is still being processed')
    }

    return charge({ user, orderId, registrations: await withCamps(regs), deposit: false })
  })
