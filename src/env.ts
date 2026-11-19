import { z } from 'zod'

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform(v => v === 'true' || v === '1')

const csv = z
  .string()
  .transform(v =>
    v
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  )

const schema = z
  .object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Which deployment this is. Defaults to production so a forgotten variable can never enable dev tooling.
  APP_ENV: z.enum(['local', 'staging', 'production']).default('production'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),

  MONGO_URI: z.string().min(1),

  API_URL: z.url().transform(u => u.replace(/\/$/, '')),
  SHOP_URL: z.url().transform(u => u.replace(/\/$/, '')),
  CORS_ORIGINS: csv,
  TRUSTED_PROXY_COUNT: z.coerce.number().int().min(0).default(1),

  MAIL_DISABLED: bool.default(false),
  MAIL_FROM_FALLBACK: z.string().default('"Voetbalstages.be" <thomas@voetbalstages.be>'),
  AWS_SES_REGION: z.string().default('eu-west-1'),
  AWS_SES_USER_KEY: z.string().default(''),
  AWS_SES_USER_SECRET: z.string().default(''),

  MOLLIE_CLIENT_ID: z.string().default(''),
  MOLLIE_CLIENT_SECRET: z.string().default(''),
  MOLLIE_REFRESH_TOKEN: z.string().default(''),
  MOLLIE_TESTMODE: bool.default(true),
  APPLICATION_FEE: z.coerce.number().min(0).default(0),

  // Local development only: logs magic-link URLs and replaces Mollie with a fake checkout page.
  DEV_TOOLS: bool.default(false),

  // Logo uploads (S3 bucket `voetbalstages`, eu-central-1). Without keys the upload endpoint answers 502.
  AWS_S3_USER_KEY: z.string().default(''),
  AWS_S3_USER_SECRET: z.string().default(''),

  // Admin address lookup (Google Places / Geocoding). Without it the places endpoints answer 502.
  GOOGLE_PLACES_API_KEY: z.string().default(''),

  N8N_WEBHOOK_URL: z.string().optional(),
  BUGSNAG_API_KEY: z.string().optional()
  })
  .refine(e => !(e.DEV_TOOLS && e.APP_ENV === 'production'), {
    path: ['DEV_TOOLS'],
    message: 'DEV_TOOLS (fake payments, logged login links) must not be enabled when APP_ENV=production'
  })

export type Env = z.infer<typeof schema>

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('Invalid environment:', z.prettifyError(parsed.error))
  process.exit(1)
}

export const env: Env = parsed.data
