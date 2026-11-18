import { env } from './env.js'
import { logger } from './logger.js'
import { connectDb, disconnectDb } from './db/connection.js'
import { createApp } from './app.js'

await connectDb(env.MONGO_URI)
logger.info('MongoDB connected')

const server = Bun.serve({ fetch: createApp().fetch, port: env.PORT, hostname: '0.0.0.0' })
logger.info(`API listening on :${server.port}`)

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down')
  setTimeout(() => process.exit(1), 10_000).unref()
  await server.stop()
  await disconnectDb()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
