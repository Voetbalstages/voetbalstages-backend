import { env } from '../env.js'
import { Camps, Locations, Students, type UserDoc } from '../db/models/index.js'
import { logger } from '../logger.js'

type Reg = { campId?: unknown; studentId?: unknown; price?: number | null; status?: string }

/** Ported from voetbalstages/services/conversionTracking.js (n8n booking webhook). */
export const fireBookingWebhook = async ({
  user,
  registrations,
  orderId,
  tracking
}: {
  user: UserDoc
  registrations: Reg[]
  orderId: string
  tracking?: Record<string, unknown>
}) => {
  if (!env.N8N_WEBHOOK_URL) return
  try {
    const populated = await Promise.all(
      registrations.map(async ({ campId, studentId, price, status }) => {
        const camp = await Camps.findById(campId).lean()
        const location = camp ? await Locations.findById(camp.locationId).lean() : null
        const student = await Students.findById(studentId).lean()
        return {
          studentName: student?.name ?? null,
          campName: camp?.name ?? null,
          locationName: location?.name ?? null,
          from: camp?.from ?? null,
          to: camp?.to ?? null,
          price: price || null,
          status
        }
      })
    )
    await fetch(env.N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId,
        registrationCount: registrations.length,
        registrations: populated,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        secondEmail: user.secondEmail || null,
        telephone: user.telephone || [],
        address: user.address || null,
        ...tracking
      })
    })
  } catch (err) {
    logger.error({ err }, 'Conversion tracking webhook error')
  }
}
