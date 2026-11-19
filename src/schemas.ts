import { z } from '@hono/zod-openapi'
import { campOptions, registrationStatuses } from './db/models/index.js'

export const ObjectIdParam = z
  .string()
  .regex(/^[a-fA-F\d]{24}$/)
  .openapi({ example: '64b7f0c2a1b2c3d4e5f60718' })

export const IdParams = z.object({ id: ObjectIdParam.openapi({ param: { name: 'id', in: 'path' } }) })

export const ErrorSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() })
  })
  .openapi('Error')

export const errorResponses = (...codes: Array<400 | 401 | 403 | 404 | 409 | 429 | 502>) =>
  Object.fromEntries(
    codes.map(code => [
      code,
      { description: `Error ${code}`, content: { 'application/json': { schema: ErrorSchema } } }
    ])
  ) as Record<number, { description: string; content: { 'application/json': { schema: typeof ErrorSchema } } }>

export const json = <T extends z.ZodType>(schema: T, description = 'OK') => ({
  description,
  content: { 'application/json': { schema } }
})

const dateString = z.string().openapi({ example: '2026-07-06T11:00:00.000Z' })

export const AddressSchema = z
  .object({
    formatted: z.string().optional(),
    streetAddress: z.string().optional(),
    postcode: z.string().optional(),
    district: z.string().optional(),
    city: z.string().optional(),
    province: z.string().optional(),
    lat: z.number().nullable().optional(),
    lng: z.number().nullable().optional(),
    placeId: z.string().nullable().optional()
  })
  .openapi('Address')

export const UserSchema = z
  .object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    fullName: z.string(),
    email: z.string(),
    secondEmail: z.string(),
    telephone: z.array(z.string()),
    credit: z.number(),
    address: AddressSchema.nullable(),
    isAdmin: z.boolean(),
    isManager: z.boolean(),
    role: z.enum(['ADMIN', 'MANAGER']).nullable(),
    organizationIds: z.array(z.string()),
    createdAt: dateString.nullable()
  })
  .openapi('User')

export const StudentSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    dob: z.string(),
    food: z.array(z.string()),
    foodOther: z.string(),
    currentClub: z.string(),
    remarks: z.string(),
    createdAt: dateString.nullable(),
    owner: z.array(
      z.object({ id: z.string(), firstName: z.string(), lastName: z.string(), email: z.string() })
    )
  })
  .openapi('Student')

export const OrganizationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    path: z.string(),
    url: z.string(),
    mollieProfileId: z.string().optional().openapi({ description: 'Staff only (ADMIN, or MANAGER of this organization).' }),
    terms: z.string().optional().openapi({ description: 'Staff only here; public via `/organizations/{path}/terms`.' })
  })
  .openapi('Organization')

const OrgRef = z.object({ id: z.string(), name: z.string() })

export const LocationSchema = z
  .object({
    id: z.string(),
    path: z.string(),
    name: z.string(),
    logo: z.object({ uri: z.string(), name: z.string() }).nullable(),
    address: AddressSchema.nullable(),
    addressString: z.string(),
    extInfo: z.string(),
    message: z.string(),
    organization: OrgRef.nullable(),
    organizationId: z.string().nullable(),
    visibility: z.enum(['VISIBLE', 'HIDDEN', 'AUTO'])
  })
  .openapi('Location')

export const CostDetailSchema = z
  .object({
    cost: z.number(),
    currentDiscount: z.number(),
    currentDiscountToInc: dateString.nullable(),
    deposit: z.number(),
    depositTotal: z.number(),
    total: z.number(),
    forcePay: z.boolean()
  })
  .openapi('CostDetail')

export const CampSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    period: z.string(),
    from: dateString.nullable(),
    to: dateString.nullable(),
    duration: z.number(),
    status: z
      .enum(['OPEN', 'CLOSED', 'CANCELED', 'HIDDEN'])
      .openapi({ description: 'Computed: a started OPEN camp reads CLOSED. `HIDDEN` is only returned to staff.' }),
    storedStatus: z.enum(['OPEN', 'CANCELED', 'HIDDEN']).openapi({ description: 'Status as saved; this is what staff write.' }),
    locationId: z.string(),
    organizationId: z.string(),
    cost: z.number(),
    deposit: z.number(),
    earlyBirdToInc: dateString.nullable(),
    options: z.array(z.enum(campOptions)),
    costDetail: CostDetailSchema,
    location: z
      .object({ id: z.string(), name: z.string(), organization: OrgRef.nullable() })
      .nullable()
  })
  .openapi('Camp')

export const RegistrationSchema = z
  .object({
    id: z.string(),
    status: z.enum(registrationStatuses),
    orderId: z.string(),
    paid: z.number(),
    canCancel: z.boolean(),
    createdAt: dateString.nullable(),
    gadgets: z.array(z.string()),
    tshirtSize: z.string().nullable(),
    shortSize: z.string().nullable(),
    shoeSize: z.number().nullable(),
    price: z.number().nullable().openapi({ description: 'Custom amount due set by an admin; null = camp price.' }),
    student: z
      .object({
        id: z.string(),
        name: z.string(),
        dob: z.string(),
        food: z.array(z.string()),
        foodOther: z.string(),
        currentClub: z.string(),
        remarks: z.string()
      })
      .nullable(),
    user: z
      .object({
        id: z.string(),
        firstName: z.string(),
        lastName: z.string(),
        fullName: z.string(),
        email: z.string(),
        secondEmail: z.string(),
        telephone: z.array(z.string())
      })
      .nullable(),
    camp: z
      .object({
        id: z.string(),
        name: z.string(),
        from: dateString.nullable(),
        to: dateString.nullable(),
        period: z.string()
      })
      .nullable(),
    location: z.object({ id: z.string(), name: z.string() }).nullable(),
    organizationId: z.string(),
    calculatedCost: z.object({
      cost: z.number(),
      currentDiscount: z.number(),
      subTotal: z.number(),
      total: z.number(),
      paid: z.number(),
      toPay: z.number()
    })
  })
  .openapi('Registration')

export const OrderSchema = z
  .object({
    id: z.string(),
    status: z.enum(registrationStatuses),
    createdAt: dateString.nullable(),
    registrationCount: z.number(),
    calculatedCost: z.object({
      total: z.number(),
      paid: z.number(),
      credit: z.number(),
      open: z.number()
    }),
    registrations: z.array(RegistrationSchema)
  })
  .openapi('Order')

export const SettingsSchema = z
  .object({
    earlyBirdToInc: dateString.nullable(),
    earlyBirdDiscount: z.number().optional().openapi({ description: 'Staff only.' }),
    depositDays: z.number().optional().openapi({ description: 'Staff only.' }),
    forcePayDays: z.number().optional().openapi({ description: 'Staff only.' }),
    cancelDays: z.number().optional().openapi({ description: 'Staff only.' }),
    emailFrom: z.string().optional().openapi({ description: 'Staff only.' }),
    terms: z.string().optional().openapi({ description: 'Staff only here; public via `/terms`.' })
  })
  .openapi('Settings')

export const PaginationQuery = z.object({
  page: z.coerce.number().int().min(0).default(0),
  perPage: z.coerce.number().int().min(1).max(500).default(100),
  order: z.enum(['asc', 'desc']).default('asc')
})

export const booleanQuery = z
  .enum(['true', 'false'])
  .transform(v => v === 'true')
  .optional()

export const idListQuery = z
  .string()
  .transform(v => v.split(',').filter(Boolean))
  .pipe(z.array(ObjectIdParam).max(200))
  .optional()

export type UserJson = z.infer<typeof UserSchema>
export type StudentJson = z.infer<typeof StudentSchema>
export type OrganizationJson = z.infer<typeof OrganizationSchema>
export type LocationJson = z.infer<typeof LocationSchema>
export type CampJson = z.infer<typeof CampSchema>
export type RegistrationJson = z.infer<typeof RegistrationSchema>
export type OrderJson = z.infer<typeof OrderSchema>
