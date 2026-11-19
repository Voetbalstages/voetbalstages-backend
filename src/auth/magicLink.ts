import { env } from '../env.js'
import { LoginTokens, Users, type UserDoc } from '../db/models/index.js'
import { conflict, badRequest } from '../lib/errors.js'
import { escapeRegex, randomToken, sha256 } from '../lib/ids.js'
import { sendMail } from '../services/mailer.js'
import { logActivity } from '../services/activity.js'

const TOKEN_TTL_MS = 15 * 60 * 1000

/** Only same-site relative paths, so the link can't be turned into an open redirect. */
export const safeRedirect = (value?: string | null) => {
  if (!value) return null
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null
  return value
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase()

/**
 * Existing account for an email. Old OAuth signups stored emails without lowercasing, so: exact
 * lowercase match first, else the oldest case-insensitive match.
 */
export const findUserByEmail = async (email: string): Promise<UserDoc | null> => {
  const exact = await Users.findOne({ email }).sort({ createdAt: 1, _id: 1 })
  if (exact) return exact
  return Users.findOne({ email: { $regex: `^${escapeRegex(email)}$`, $options: 'i' } }).sort({
    createdAt: 1,
    _id: 1
  })
}

export const requestMagicLink = async (input: {
  email: string
  agreeToTerms?: boolean
  redirectTo?: string
  target?: 'shop' | 'admin'
}) => {
  const email = normalizeEmail(input.email)
  const user = await findUserByEmail(email)
  const admin = input.target === 'admin'
  // Admin links never create accounts and are only sent to staff (still a silent 204 for everyone else).
  if (admin && (!env.ADMIN_URL || !user?.role)) return
  const token = randomToken()
  await LoginTokens.create({
    tokenHash: sha256(token),
    email,
    redirectTo: safeRedirect(input.redirectTo),
    agreeToTerms: input.agreeToTerms === true,
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS)
  })
  const base = admin ? `${env.ADMIN_URL}/login/verify` : `${env.SHOP_URL}/inloggen/verifieer`
  await sendMail(email, 'magicLink', {
    name: user?.firstName || '',
    url: `${base}?token=${encodeURIComponent(token)}`,
    minutes: TOKEN_TTL_MS / 60000
  })
}

/**
 * Exchanges a token for a user. Unknown emails get an account, but only once terms are
 * accepted (on the request or on this call); until then the token stays valid.
 */
export const verifyMagicLink = async (input: { token: string; agreeToTerms?: boolean }) => {
  const tokenHash = sha256(input.token)
  const now = new Date()
  const record = await LoginTokens.findOne({ tokenHash, usedAt: null, expiresAt: { $gt: now } }).lean()
  if (!record) throw badRequest('INVALID_TOKEN', 'This login link is invalid or has expired')

  let user = await findUserByEmail(record.email)
  const agreed = record.agreeToTerms || input.agreeToTerms === true
  if (!user && !agreed) throw conflict('TERMS_REQUIRED', 'Accept the terms to create your account')

  const consumed = await LoginTokens.findOneAndUpdate(
    { tokenHash, usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } }
  )
  if (!consumed) throw badRequest('INVALID_TOKEN', 'This login link is invalid or has expired')

  if (!user) {
    user = await Users.findOneAndUpdate(
      { email: record.email },
      {
        $setOnInsert: {
          email: record.email,
          agreeToTerms: ['agrees'],
          firstName: '',
          lastName: '',
          secondEmail: '',
          credit: 0
        }
      },
      { upsert: true, new: true }
    )
    logActivity(user!._id, 'USER')
  }
  return { user: user!, redirectTo: record.redirectTo ?? null }
}
