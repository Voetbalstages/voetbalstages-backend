import type { Types } from 'mongoose'
import { env } from '../env.js'
import {
  Camps,
  Organizations,
  Payments,
  Registrations,
  Users,
  getSettings,
  PAYABLE,
  type RegistrationStatus,
  type Settings,
  type UserDoc
} from '../db/models/index.js'
import { badGateway, conflict } from '../lib/errors.js'
import { calculateCampCost, round2 } from '../lib/cost.js'
import { currency } from '../lib/dates.js'
import { logger, reportError } from '../logger.js'
import type { CampLike, RegistrationLike } from '../serializers/index.js'
import { mollie, type MolliePayment } from './mollie.js'
import { sendOrderMail } from './orderMail.js'
import { logActivity } from './activity.js'

const IN_PROGRESS_STATUSES = ['open', 'pending', 'authorized']
/** Old payment docs may lack expiresAt; treat an open one younger than this as still payable. */
const OPEN_WITHOUT_EXPIRY_MS = 60 * 60 * 1000
/** Don't hand out a checkout URL that's about to expire. */
const REUSE_MARGIN_MS = 2 * 60 * 1000

export type ActivePayment = { kind: 'reuse'; href: string } | { kind: 'pending' } | null

/**
 * Looks in the shared `payments` collection (written by both backends) for a Mollie payment on
 * this order that could still be completed. Prevents double charges.
 */
export const activePaymentFor = async (orderId: string, now = Date.now()): Promise<ActivePayment> => {
  const payments = await Payments.find({
    'metadata.orderId': orderId,
    status: { $in: IN_PROGRESS_STATUSES }
  }).lean<MolliePayment[]>()
  let reusable: string | null = null
  for (const p of payments) {
    if (p.status !== 'open') return { kind: 'pending' }
    const href = p._links?.checkout?.href
    const expiresAt = p.expiresAt ? new Date(p.expiresAt).getTime() : null
    const createdAt = p.createdAt ? new Date(p.createdAt as string).getTime() : null
    const stillOpen =
      expiresAt != null
        ? expiresAt > now
        : createdAt != null && now - createdAt < OPEN_WITHOUT_EXPIRY_MS
    if (!stillOpen) continue
    if (href && expiresAt != null && expiresAt - now > REUSE_MARGIN_MS) reusable = href
    else return { kind: 'pending' }
  }
  return reusable ? { kind: 'reuse', href: reusable } : null
}

type ChargeReg = RegistrationLike & { camp: CampLike }

interface Plan {
  reg: ChargeReg
  due: number
  /** Full price of the registration, used to lock `price` on a full payment. */
  fullPrice: number
  depositMode: boolean
  depositAmount: number
}

const planFor = (reg: ChargeReg, depositMode: boolean, settings: Settings): Plan => {
  const cost = calculateCampCost(reg.camp, settings)
  const fullPrice = reg.price ? Number(reg.price) : cost.total
  const paid = reg.paid ?? 0
  const due = depositMode ? Math.max(0, cost.depositTotal - paid) : Math.max(0, fullPrice - paid)
  return { reg, due: round2(due), fullPrice, depositMode, depositAmount: cost.depositTotal }
}

/** Takes up to `wanted` from the user's credit with a compare-and-set; retries once. */
const takeCredit = async (userId: Types.ObjectId, wanted: number): Promise<number> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = await Users.findById(userId, { credit: 1 }).lean()
    const current = round2(user?.credit ?? 0)
    const take = round2(Math.min(current, wanted))
    if (take <= 0) return 0
    const updated = await Users.findOneAndUpdate(
      { _id: userId, credit: user!.credit },
      { $set: { credit: round2(current - take) } },
      { new: true }
    )
    if (updated) return take
  }
  throw conflict('CREDIT_CHANGED', 'Store credit changed during checkout, please retry')
}

const giveBackCredit = async (userId: Types.ObjectId, amount: number) => {
  if (amount <= 0) return
  await Users.updateOne({ _id: userId }, { $inc: { credit: amount } })
}

export interface ChargeResult {
  payUrl: string | null
  credit: number
}

/**
 * Applies store credit, then starts a Mollie payment for the rest. Shared by order creation
 * (payNow) and POST /orders/{id}/payment. Callers hold the per-user lock.
 *
 * Fixes vs. the old useCredit/startPayment: only payable registrations take part, `paid` is
 * added to rather than overwritten, credit is taken with a compare-and-set, and a Mollie failure
 * rolls everything back and surfaces as 502 instead of returning an error object as payUrl.
 */
export const charge = async ({
  user,
  orderId,
  registrations,
  deposit,
  isNewOrder = false
}: {
  user: UserDoc
  orderId: string
  registrations: ChargeReg[]
  deposit: boolean
  /** A brand-new order with nothing due (free camps) is confirmed instead of rejected. */
  isNewOrder?: boolean
}): Promise<ChargeResult> => {
  const settings = await getSettings()
  const payable = registrations.filter(r => PAYABLE.includes(r.status))
  // Deposit mode is all-or-nothing per payment, so the webhook can trust metadata.deposit.
  const depositMode =
    deposit &&
    payable.length > 0 &&
    payable.every(
      r => r.status !== 'deposited' && calculateCampCost(r.camp, settings).depositTotal > 0
    )
  const plans = payable.map(r => planFor(r, depositMode, settings)).filter(p => p.due > 0)
  const totalDue = round2(plans.reduce((s, p) => s + p.due, 0))
  if (totalDue <= 0) {
    if (!isNewOrder) throw conflict('NOTHING_TO_PAY', 'This order has nothing left to pay')
    await Registrations.updateMany(
      { orderId, status: { $in: PAYABLE } },
      { $set: { status: 'confirmed' } }
    )
    return { payUrl: null, credit: await currentCredit(user._id) }
  }

  const snapshots = plans.map(p => ({
    _id: p.reg._id,
    status: p.reg.status,
    paid: p.reg.paid ?? 0,
    price: p.reg.price ?? null
  }))

  const applied = await takeCredit(user._id, totalDue)
  let creditLeft = applied
  const remaining = round2(totalDue - applied)

  try {
    for (const p of plans) {
      const share = round2(Math.min(creditLeft, p.due))
      creditLeft = round2(creditLeft - share)
      const paid = round2((p.reg.paid ?? 0) + share)
      const $set: Record<string, unknown> = { paid }
      if (share === p.due) {
        // Fully covered by credit.
        if (p.depositMode) $set.status = 'deposited'
        else {
          $set.status = 'confirmed'
          $set.price = p.fullPrice
        }
      } else if (!p.depositMode && remaining > 0) {
        // A full payment is being started: lock the price Mollie will charge.
        $set.price = p.fullPrice
      }
      if (share > 0 || $set.price !== undefined) {
        const res = await Registrations.updateOne(
          { _id: p.reg._id, status: { $in: PAYABLE } },
          { $set }
        )
        if (res.matchedCount === 0) throw conflict('ORDER_CHANGED', 'Order changed, please retry')
      }
    }

    if (remaining <= 0) {
      const regs = await Registrations.find({ orderId }).lean()
      sendOrderMail({
        registrations: regs as RegistrationLike[],
        orderId,
        user,
        template: depositMode ? 'depositConfirmed' : 'paymentConfirmed',
        extra: { amount: currency(0) }
      }).catch(err => reportError(err, { orderId }))
      logActivity(user._id, 'PAYMENT')
      return { payUrl: null, credit: await currentCredit(user._id) }
    }

    const organizationId = registrations[0]!.organizationId
    const org = await Organizations.findById(organizationId, { mollieProfileId: 1 }).lean()
    if (!org) throw new Error(`Organization ${organizationId} not found`)

    const anyDeposit = depositMode
    const fee = round2(env.APPLICATION_FEE * plans.length)
    let payment: MolliePayment
    try {
      payment = await mollie().createPayment({
        amount: remaining,
        description: `Voetbalstages reservatie: ${orderId}`,
        redirectUrl: `${env.SHOP_URL}/bestellingen/${orderId}`,
        webhookUrl: `${env.API_URL}/api/v1/payments/webhook`,
        metadata: {
          orderId,
          userId: String(user._id),
          deposit: anyDeposit,
          organizationId: String(organizationId)
        },
        profileId: org.mollieProfileId,
        ...(!anyDeposit &&
          fee > 0 &&
          fee < remaining && {
            applicationFee: { amount: fee, description: 'Platform kost shop.voetbalstages.be' }
          })
      })
    } catch (err) {
      reportError(err, { orderId })
      throw badGateway('PAYMENT_PROVIDER_ERROR', 'Could not start the payment, please retry')
    }
    await Payments.create(payment)
    logActivity(user._id, 'PAYMENT')
    const href = payment._links?.checkout?.href
    if (!href) throw badGateway('PAYMENT_PROVIDER_ERROR', 'Payment has no checkout URL')
    return { payUrl: href, credit: await currentCredit(user._id) }
  } catch (err) {
    // Roll back: credit, paid amounts, locked prices, and pending statuses (so the user can retry).
    await giveBackCredit(user._id, applied).catch(e =>
      reportError(e, { msg: 'credit rollback failed', userId: String(user._id), applied })
    )
    await Promise.all(
      snapshots.map(s =>
        Registrations.updateOne(
          { _id: s._id },
          {
            $set: {
              paid: s.paid,
              status: (s.status === 'payment_pending' ? 'open' : s.status) as RegistrationStatus,
              ...(s.price == null ? {} : { price: s.price })
            },
            ...(s.price == null ? { $unset: { price: 1 } } : {})
          }
        )
      )
    ).catch(e => reportError(e, { msg: 'registration rollback failed', orderId }))
    throw err
  }
}

const currentCredit = async (userId: Types.ObjectId) =>
  round2((await Users.findById(userId, { credit: 1 }).lean())?.credit ?? 0)

/** Loads registrations with their camps attached, as `charge` expects. */
export const withCamps = async (regs: RegistrationLike[]): Promise<ChargeReg[]> => {
  const camps = await Camps.find({ _id: { $in: regs.map(r => r.campId).filter(Boolean) } }).lean()
  const byId = new Map(camps.map(c => [String(c._id), c as CampLike]))
  return regs
    .filter(r => r.campId && byId.has(String(r.campId)))
    .map(r => ({ ...r, camp: byId.get(String(r.campId))! }))
}

const FAILED = ['expired', 'failed', 'canceled']

/**
 * Mollie webhook handler. Always re-fetches the payment from Mollie and only acts on payments
 * this service created. Idempotent: does nothing unless the stored status actually changes.
 * Never downgrades: only `paid` confirms/deposits; failure statuses only reopen payment_pending.
 */
export const handlePaymentWebhook = async (paymentId: string) => {
  const stored = await Payments.findOne({ id: paymentId }).lean<MolliePayment>()
  if (!stored) {
    logger.warn({ paymentId }, 'webhook for unknown payment, ignored')
    return
  }
  const payment = await mollie().getPayment(paymentId)
  if (!payment) return

  // Compare-and-set on the status so concurrent retries process a transition once.
  const transitioned = await Payments.findOneAndUpdate(
    { id: paymentId, status: stored.status },
    { $set: payment }
  )
  if (!transitioned || stored.status === payment.status) return

  const { orderId, deposit, userId } = stored.metadata
  const regs = (await Registrations.find({ orderId }).lean()) as RegistrationLike[]

  if (payment.status === 'paid') {
    const settings = await getSettings()
    for (const reg of await withCamps(regs)) {
      if (!PAYABLE.includes(reg.status)) continue
      const $set: Record<string, unknown> =
        deposit && reg.camp.deposit
          ? { status: 'deposited', paid: Math.max(reg.paid ?? 0, Number(reg.camp.deposit)) }
          : (() => {
              const price = reg.price ? Number(reg.price) : calculateCampCost(reg.camp, settings).total
              return { status: 'confirmed', paid: price, price }
            })()
      await Registrations.updateOne({ _id: reg._id, status: { $in: PAYABLE } }, { $set })
    }
    const user = await Users.findById(userId).lean()
    if (user) {
      const updated = (await Registrations.find({ orderId }).lean()) as RegistrationLike[]
      await sendOrderMail({
        registrations: updated,
        orderId,
        user: user as UserDoc,
        template: deposit ? 'depositConfirmed' : 'paymentConfirmed',
        extra: { amount: currency(Number(payment.amount.value)) }
      })
    }
  } else if (FAILED.includes(payment.status)) {
    await Registrations.updateMany(
      { orderId, status: 'payment_pending' },
      { $set: { status: 'open' } }
    )
  }
  if (userId) logActivity(userId, 'PAYMENT')
}
