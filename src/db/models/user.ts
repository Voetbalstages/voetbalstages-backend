import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose'
import { addressSchema, legacy } from './shared.js'

// Mirror of voetbalstages/models/user.js. The passport-local-mongoose `hash`/`salt` fields are
// deliberately absent: this service never reads or writes passwords.
const userSchema = new Schema(
  {
    googleId: String,
    facebookId: String,
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    email: { type: String, default: '' },
    secondEmail: { type: String, default: '' },
    telephone: [{ type: String, default: '' }],
    agreeToTerms: [String],
    resetToken: String,
    role: { type: String, enum: ['ADMIN', 'MANAGER'] },
    organizationIds: [Schema.Types.ObjectId],
    credit: { type: Number, default: 0 },
    address: addressSchema
  },
  { timestamps: true, ...legacy }
)

export type User = InferSchemaType<typeof userSchema>
export type UserDoc = HydratedDocument<User>
export const Users = model('users', userSchema)
