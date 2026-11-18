import { Schema, model, type InferSchemaType } from 'mongoose'
import { legacy } from './shared.js'

// Mirror of voetbalstages/models/organization.js
const organizationSchema = new Schema(
  {
    name: String,
    path: { type: String, required: true },
    mollieProfileId: { type: String, required: true },
    terms: { type: String, required: true }
  },
  { ...legacy }
)

export type Organization = InferSchemaType<typeof organizationSchema>
export const Organizations = model('organizations', organizationSchema)
