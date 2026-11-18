import { Schema, model } from 'mongoose'

// New collection owned by this service. _id is sha256(session token).
const sessionSchema = new Schema(
  {
    _id: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    expiresAt: { type: Date, required: true },
    refreshedAt: { type: Date, required: true }
  },
  { timestamps: true, collection: 'rest_sessions', autoIndex: false }
)

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
sessionSchema.index({ userId: 1 })

export const Sessions = model('Session', sessionSchema)
