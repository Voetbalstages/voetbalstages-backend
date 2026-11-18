import { randomBytes, randomInt, createHash } from 'node:crypto'
import { Types } from 'mongoose'
import { notFound } from './errors.js'

export const OBJECT_ID = /^[a-f\d]{24}$/i

export const oid = (id: string, what?: string) => {
  if (!OBJECT_ID.test(id)) throw notFound(what)
  return new Types.ObjectId(id)
}

export const randomToken = () => randomBytes(32).toString('base64url')

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/** Same format as the old backend: YYYYMMDD-###### (UTC date, 6 random digits). */
export const newOrderId = (now = new Date()) => {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '')
  const digits = String(randomInt(0, 1_000_000)).padStart(6, '0')
  return `${ymd}-${digits}`
}

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
