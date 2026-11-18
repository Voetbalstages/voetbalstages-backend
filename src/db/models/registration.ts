import { Schema, model, type InferSchemaType, type Types } from 'mongoose'
import { legacy } from './shared.js'

export const registrationStatuses = [
  'open',
  'payment_pending',
  'confirmed',
  'canceled',
  'refunded',
  'deposited'
] as const
export type RegistrationStatus = (typeof registrationStatuses)[number]

/** Statuses that still owe money and can receive credit or a payment. */
export const PAYABLE: RegistrationStatus[] = ['open', 'payment_pending', 'deposited']
/** Statuses that block a new registration for the same student + camp. */
export const ACTIVE: RegistrationStatus[] = ['open', 'payment_pending', 'confirmed', 'deposited']
/** Statuses a user may cancel (subject to Settings.cancelDays). */
export const CANCELLABLE: RegistrationStatus[] = ['open', 'confirmed', 'deposited']

// Mirror of voetbalstages/models/registration.js
const registrationSchema = new Schema(
  {
    studentId: Schema.Types.ObjectId,
    userId: Schema.Types.ObjectId,
    campId: Schema.Types.ObjectId,
    organizationId: { type: Schema.Types.ObjectId, required: true },
    orderId: String,
    status: { type: String, enum: registrationStatuses, default: 'open' },
    paid: { type: Number, default: 0 },
    price: Number,
    tshirtSize: String,
    shortSize: String,
    shoeSize: Number,
    gadgets: [String]
  },
  { timestamps: true, ...legacy }
)

export type Registration = InferSchemaType<typeof registrationSchema> & {
  _id: Types.ObjectId
  status: RegistrationStatus
}
export const Registrations = model('registrations', registrationSchema)
