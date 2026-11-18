import mongoose from 'mongoose'
import { LoginTokens, Sessions } from './models/index.js'

// Same global as the old backend (voetbalstages/index.js), so findOneAndUpdate semantics match.
mongoose.set('returnOriginal', false)
mongoose.set('strictQuery', true)

export const connectDb = async (uri: string) => {
  await mongoose.connect(uri)
  // Only the collections this service owns get indexes.
  await Promise.all([LoginTokens.createIndexes(), Sessions.createIndexes()])
}

export const disconnectDb = () => mongoose.disconnect()

export const dbHealthy = () => mongoose.connection.readyState === 1
