import path from 'node:path'
import Email from 'email-templates'
import nodemailer from 'nodemailer'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { env } from '../env.js'
import { logger, reportError } from '../logger.js'
import { SettingsModel } from '../db/models/index.js'
import { formatDate } from '../lib/dates.js'

export type Template =
  | 'magicLink'
  | 'orderConfirmed'
  | 'paymentConfirmed'
  | 'depositConfirmed'
  | 'registrationCanceled'

export interface SentMail {
  to: string
  template: Template
  data: Record<string, unknown>
}

/** Mails "sent" while MAIL_DISABLED is on; used by tests and local dev. */
export const outbox: SentMail[] = []

const emailsRoot = path.resolve('emails')

let email: Email | null = null
const getEmail = () => {
  if (email) return email
  const sesClient = new SESv2Client({
    region: env.AWS_SES_REGION,
    credentials: {
      accessKeyId: env.AWS_SES_USER_KEY,
      secretAccessKey: env.AWS_SES_USER_SECRET
    }
  })
  email = new Email({
    views: { root: emailsRoot },
    transport: nodemailer.createTransport({ SES: { sesClient, SendEmailCommand } } as never),
    send: true,
    preview: false,
    juice: true,
    juiceResources: {
      preserveImportant: true,
      applyStyleTags: true,
      removeStyleTags: true,
      webResources: { relativeTo: emailsRoot, images: false }
    }
  })
  return email
}

/** Renders subject + inlined HTML without sending (tests, previews). */
export const renderMail = async (template: Template, data: Record<string, unknown>) => {
  const locals = { ...data, formatDate }
  const [subject, html] = await Promise.all([
    getEmail().render(`${template}/subject`, locals),
    getEmail().render(`${template}/html`, locals)
  ])
  return { subject: subject.trim(), html }
}

const fromAddress = async () => {
  const settings = await SettingsModel.findOne().select('emailFrom').lean()
  return settings?.emailFrom || env.MAIL_FROM_FALLBACK
}

/** Never throws: a failed mail must not fail the request that triggered it. */
export const sendMail = async (to: string, template: Template, data: Record<string, unknown>) => {
  if (env.MAIL_DISABLED) {
    outbox.push({ to, template, data })
    logger.info(
      { to, template, ...(env.DEV_TOOLS && typeof data.url === 'string' && { url: data.url }) },
      'mail (disabled, not sent)'
    )
    return
  }
  try {
    await getEmail().send({
      template,
      message: { from: await fromAddress(), to },
      locals: { ...data, formatDate }
    })
    logger.info({ to, template }, 'mail sent')
  } catch (err) {
    reportError(err, { to, template })
  }
}
