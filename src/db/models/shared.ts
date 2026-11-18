import { Schema } from 'mongoose'

// Mirrors of the old backend's embedded schemas (voetbalstages/models/address.js, file.js).
export const addressSchema = new Schema({
  formatted: { type: String, default: '' },
  streetAddress: { type: String, default: '' },
  postcode: { type: String, default: '' },
  district: { type: String, default: '' },
  city: { type: String, default: '' },
  province: { type: String, default: '' },
  lat: Number,
  lng: Number,
  placeId: String
})

export const fileSchema = new Schema({
  uri: String,
  name: String
})

// Legacy collections are owned by the old backend: never build indexes on them from here.
export const legacy = { autoIndex: false, autoCreate: false } as const
