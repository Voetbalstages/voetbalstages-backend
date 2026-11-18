import { Schema, model } from 'mongoose'
import { legacy } from './shared.js'

// Mirror of voetbalstages/models/payments.js: the plain Mollie payment JSON, strict: false.
const paymentSchema = new Schema(
  {
    id: { type: String, required: true },
    status: {
      type: String,
      enum: ['open', 'canceled', 'pending', 'authorized', 'expired', 'failed', 'paid'],
      default: 'open'
    },
    _links: { checkout: { href: String } },
    metadata: {
      orderId: String,
      userId: String,
      deposit: Boolean,
      organizationId: String
    }
  },
  { strict: false, ...legacy }
)

export const Payments = model('payments', paymentSchema)
