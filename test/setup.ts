import { inject, beforeAll, beforeEach, afterAll } from 'vitest'

Object.assign(process.env, {
  NODE_ENV: 'test',
  MONGO_URI: inject('mongoUri'),
  API_URL: 'https://api.test',
  SHOP_URL: 'https://shop.test',
  CORS_ORIGINS: 'https://shop.test',
  TRUSTED_PROXY_COUNT: '1',
  MAIL_DISABLED: 'true',
  MOLLIE_TESTMODE: 'true',
  APPLICATION_FEE: '1'
})

const { default: mongoose } = await import('mongoose')
const { connectDb, disconnectDb } = await import('../src/db/connection.js')
const { outbox } = await import('../src/services/mailer.js')
const { emailLimiter, ipLimiter } = await import('../src/routes/auth.js')
const { setMollieGateway } = await import('../src/services/mollie.js')

beforeAll(async () => {
  await connectDb(process.env.MONGO_URI!)
})

beforeEach(async () => {
  const collections = await mongoose.connection.db!.collections()
  await Promise.all(collections.map(c => c.deleteMany({})))
  outbox.length = 0
  emailLimiter.reset()
  ipLimiter.reset()
  setMollieGateway(null)
})

afterAll(async () => {
  await disconnectDb()
})
