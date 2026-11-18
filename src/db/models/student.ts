import { Schema, model, type InferSchemaType } from 'mongoose'
import { legacy } from './shared.js'

// Mirror of voetbalstages/models/student.js
const studentSchema = new Schema(
  {
    name: String,
    ownerId: [Schema.Types.ObjectId],
    dob: String,
    food: [String],
    foodOther: String,
    currentClub: String,
    remarks: String
  },
  { timestamps: true, ...legacy }
)

export type Student = InferSchemaType<typeof studentSchema>
export const Students = model('students', studentSchema)
