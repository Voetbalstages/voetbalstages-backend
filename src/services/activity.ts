import type { Types } from 'mongoose'
import { Activities, type topics } from '../db/models/index.js'
import { reportError } from '../logger.js'

/** Same audit trail as the old backend (only userId + topic persist; the schema is strict). */
export const logActivity = (userId: Types.ObjectId | string, topic: (typeof topics)[number]) => {
  Activities.create({ userId, topic }).catch(err => reportError(err, { userId, topic }))
}
