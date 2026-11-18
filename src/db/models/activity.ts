import { Schema, model } from 'mongoose'
import { legacy } from './shared.js'

export const topics = [
  'REGISTRATION',
  'ORDER',
  'PAYMENT',
  'STUDENT',
  'USER',
  'SETTINGS',
  'CAMP',
  'ORGANIZATION',
  'LOCATION'
] as const

// Mirror of voetbalstages/models/activity.js. Model name `activity` → collection `activities`.
// The schema is strict with only userId + topic, exactly like the old one.
const activitySchema = new Schema(
  {
    userId: Schema.Types.ObjectId,
    topic: { type: String, enum: topics, required: true }
  },
  { timestamps: true, ...legacy }
)

export const Activities = model('activity', activitySchema)
