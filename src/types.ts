import type { UserDoc } from './db/models/index.js'

export type AppEnv = {
  Variables: {
    user: UserDoc | null
    sessionId: string | null
  }
}
