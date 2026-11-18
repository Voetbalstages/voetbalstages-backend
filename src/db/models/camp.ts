import { Schema, model, type InferSchemaType } from 'mongoose'
import { legacy } from './shared.js'

export const campOptions = ['GADGETS', 'TSHIRTSIZE', 'SHORTSIZE', 'SHOESIZE'] as const
export type CampOption = (typeof campOptions)[number]

// Mirror of voetbalstages/models/camp.js (read-only from this service, so the
// date-normalising pre-validate hook is not needed).
const campSchema = new Schema(
  {
    locationId: { type: Schema.Types.ObjectId, required: true },
    organizationId: { type: Schema.Types.ObjectId, required: true },
    name: String,
    from: Date,
    to: Date,
    period: String,
    cost: Number,
    deposit: Number,
    earlyBirdToInc: Date,
    status: { type: String, enum: ['OPEN', 'CANCELED', 'HIDDEN'], default: 'OPEN' },
    options: { type: [String], enum: campOptions }
  },
  { ...legacy }
)

export type Camp = InferSchemaType<typeof campSchema> & { _id: import('mongoose').Types.ObjectId }
export const Camps = model('camps', campSchema)
