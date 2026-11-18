import {
  Camps,
  Registrations,
  Users,
  getSettings,
  CANCELLABLE,
  type UserDoc
} from '../db/models/index.js'
import { conflict, notFound } from '../lib/errors.js'
import { round2 } from '../lib/cost.js'
import { currency } from '../lib/dates.js'
import { withLock } from '../lib/mutex.js'
import { logger, reportError } from '../logger.js'
import { canCancel, type CampLike, type RegistrationLike } from '../serializers/index.js'
import { activePaymentFor } from './payments.js'
import { sendOrderMail } from './orderMail.js'
import { logActivity } from './activity.js'

/**
 * Cancel a registration, refunding anything paid to store credit.
 * Fixes vs. the old cancelAndRefund: enforces canCancel, refuses while a payment is in progress,
 * and flips the status atomically before crediting so concurrent cancels can't double-credit.
 */
export const cancelRegistration = (user: UserDoc, registrationId: string) =>
  withLock(String(user._id), async () => {
    const reg = (await Registrations.findOne({ _id: registrationId, userId: user._id }).lean()) as
      | RegistrationLike
      | null
    if (!reg) throw notFound('Registration')

    const [settings, camp] = await Promise.all([
      getSettings(),
      reg.campId ? (Camps.findById(reg.campId).lean() as Promise<CampLike | null>) : null
    ])
    if (!canCancel(reg, camp ?? undefined, settings)) {
      throw conflict('NOT_CANCELLABLE', 'This registration can no longer be cancelled')
    }
    if (reg.orderId && (await activePaymentFor(reg.orderId))) {
      throw conflict('PAYMENT_IN_PROGRESS', 'Finish or wait for the open payment before cancelling')
    }

    const nextStatus = (reg.paid ?? 0) > 0 ? 'refunded' : 'canceled'
    const before = (await Registrations.findOneAndUpdate(
      { _id: reg._id, userId: user._id, status: { $in: CANCELLABLE } },
      { $set: { status: nextStatus, paid: 0 } },
      { new: false }
    ).lean()) as RegistrationLike | null
    if (!before) throw conflict('NOT_CANCELLABLE', 'This registration can no longer be cancelled')

    const refund = round2(before.paid ?? 0)
    let credit = user.credit ?? 0
    if (refund > 0) {
      const ctx = { registrationId: String(reg._id), userId: String(user._id), amount: refund }
      // If the process dies between the status flip and the $inc, this line is the trail
      // for manual reconciliation (no "credit refund done" line will follow it).
      logger.warn(ctx, 'credit refund pending')
      try {
        const updated = await Users.findOneAndUpdate(
          { _id: user._id },
          { $inc: { credit: refund } },
          { new: true }
        ).lean()
        credit = updated?.credit ?? credit
        logger.info(ctx, 'credit refund done')
      } catch (err) {
        reportError(err, { ...ctx, msg: 'credit refund FAILED, reconcile manually' })
        throw err
      }
    }

    const after = { ...before, status: nextStatus, paid: 0 } as RegistrationLike
    sendOrderMail({
      registrations: [after],
      orderId: String(before.orderId ?? ''),
      user,
      template: 'registrationCanceled',
      extra: { addedCredit: refund > 0 ? currency(refund) : null }
    }).catch(err => reportError(err, { registrationId }))
    logActivity(user._id, 'REGISTRATION')

    return { registration: after, credit: round2(credit) }
  })
