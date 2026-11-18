import { Schema, model, type InferSchemaType } from 'mongoose'

// New collection owned by this service.
const loginTokenSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    redirectTo: String,
    agreeToTerms: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null }
  },
  { timestamps: true, collection: 'login_tokens', autoIndex: false }
)

// Keep used/expired tokens a day for debugging, then let Mongo drop them.
loginTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 })

export type LoginToken = InferSchemaType<typeof loginTokenSchema>
export const LoginTokens = model('LoginToken', loginTokenSchema)
