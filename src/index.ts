import { serve } from '@hono/node-server'
import { env } from './env.js'
import { logger } from './logger.js'
import { connectDb, disconnectDb } from './db/connection.js'
import { createApp } from './app.js'

await connectDb(env.MONGO_URI)
logger.info('MongoDB connected')

const server = serve({ fetch: createApp().fetch, port: env.PORT, hostname: '0.0.0.0' }, info =>
  logger.info(`API listening on :${info.port}`)
)

const shutdown = (signal: string) => {
  logger.info({ signal }, 'shutting down')
  server.close(async () => {
    await disconnectDb()
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
