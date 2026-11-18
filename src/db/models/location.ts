import { Schema, model, type InferSchemaType } from 'mongoose'
import { addressSchema, fileSchema, legacy } from './shared.js'

// Mirror of voetbalstages/models/location.js
const locationSchema = new Schema(
  {
    name: String,
    address: addressSchema,
    image: String,
    path: String,
    extInfo: String,
    message: String,
    organizationId: Schema.Types.ObjectId,
    logo: fileSchema,
    visibility: { type: String, enum: ['VISIBLE', 'HIDDEN', 'AUTO'] }
  },
  { ...legacy }
)

export type Location = InferSchemaType<typeof locationSchema>
export const Locations = model('locations', locationSchema)
