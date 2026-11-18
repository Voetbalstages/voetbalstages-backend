import { Schema, model, type InferSchemaType } from 'mongoose'
import { legacy } from './shared.js'

// Mirror of voetbalstages/models/settings.js. Read-only here: unlike the old model this never
// creates the singleton settings document.
const settingsSchema = new Schema(
  {
    earlyBirdDiscount: { type: Number, default: 15 },
    earlyBirdToInc: { type: Date },
    depositDays: { type: Number, default: 14 },
    forcePayDays: { type: Number, default: 14 },
    emailFrom: String,
    cancelDays: { type: Number, default: 14 },
    terms: String
  },
  { timestamps: true, ...legacy }
)

export type Settings = InferSchemaType<typeof settingsSchema>
export const SettingsModel = model('settings', settingsSchema)

export const getSettings = async (): Promise<Settings> => {
  const doc = await SettingsModel.findOne().lean()
  if (!doc) throw new Error('Settings document missing')
  return doc as Settings
}
