import { env } from '../env.js'
import type { UserDoc } from '../db/models/index.js'
import { loadRegistrationRefs, type RegistrationLike } from '../serializers/index.js'
import { sendMail, type Template } from './mailer.js'

export const statusTranslations = {
  open: 'Bevestigd - niet betaald',
  payment_pending: 'Betaling in behandeling',
  confirmed: 'Bevestigd - betaald',
  canceled: 'Geannuleerd',
  refunded: 'Terugbetaald',
  deposited: 'Voorschot betaald'
}

/** Port of the old sendOrderMail: same templates, same locals. */
export const sendOrderMail = async ({
  registrations,
  orderId,
  user,
  template,
  extra = {}
}: {
  registrations: RegistrationLike[]
  orderId: string
  user: Pick<UserDoc, 'email' | 'firstName'>
  template: Template
  extra?: Record<string, unknown>
}) => {
  if (!user.email) return
  const refs = await loadRegistrationRefs(registrations)
  const populated = registrations.map(r => {
    const camp = r.campId ? refs.camps.get(String(r.campId)) : undefined
    return {
      status: r.status,
      student: (r.studentId && refs.students.get(String(r.studentId))) || { name: '' },
      camp: camp ?? { from: null, to: null, name: '' },
      location: (camp && refs.locations.get(String(camp.locationId))) || { name: '' }
    }
  })
  await sendMail(user.email, template, {
    name: user.firstName,
    registrations: populated,
    statusTranslations,
    orderId,
    orderLink: `${env.SHOP_URL}/bestellingen/${orderId}`,
    ...extra
  })
}
