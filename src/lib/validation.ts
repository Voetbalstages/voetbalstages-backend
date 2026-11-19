import { AddressSchema } from '../schemas.js'

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const visibilities = ['VISIBLE', 'HIDDEN', 'AUTO'] as const
export const AddressInput = AddressSchema.strict()
