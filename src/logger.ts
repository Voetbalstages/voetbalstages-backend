import { pino } from 'pino'
import { createRequire } from 'node:module'
import { env } from './env.js'

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  ...(env.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty' }
  })
})

// @bugsnag/js is CommonJS with types that don't resolve a default export under NodeNext.
interface BugsnagClient {
  start(opts: { apiKey: string; releaseStage?: string }): unknown
  notify(err: Error, onError?: (event: { addMetadata(section: string, data: object): void }) => void): void
}
const Bugsnag = createRequire(import.meta.url)('@bugsnag/js') as BugsnagClient

let bugsnagStarted = false
if (env.BUGSNAG_API_KEY) {
  Bugsnag.start({ apiKey: env.BUGSNAG_API_KEY, releaseStage: env.NODE_ENV })
  bugsnagStarted = true
}

export const reportError = (err: unknown, meta: Record<string, unknown> = {}) => {
  logger.error({ err, ...meta }, err instanceof Error ? err.message : String(err))
  if (bugsnagStarted) {
    Bugsnag.notify(err instanceof Error ? err : new Error(String(err)), event => {
      event.addMetadata('context', meta)
    })
  }
}
