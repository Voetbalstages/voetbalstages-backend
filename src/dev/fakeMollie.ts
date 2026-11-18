import { randomBytes } from 'node:crypto'
import { env } from '../env.js'
import type { CreatePaymentInput, MollieGateway, MolliePayment } from '../services/mollie.js'

/** Stand-in for Mollie when DEV_TOOLS is on. State is in memory, so it resets on restart. */
interface FakePayment {
  payment: MolliePayment
  redirectUrl: string
}

const payments = new Map<string, FakePayment>()

export const fakeGateway: MollieGateway = {
  async createPayment(input: CreatePaymentInput) {
    const id = `tr_dev${randomBytes(6).toString('hex')}`
    const payment: MolliePayment = {
      id,
      status: 'open',
      amount: { value: input.amount.toFixed(2), currency: 'EUR' },
      description: input.description,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      metadata: input.metadata,
      _links: { checkout: { href: `${env.API_URL}/api/v1/dev/checkout/${id}` } }
    }
    payments.set(id, { payment, redirectUrl: input.redirectUrl })
    return structuredClone(payment)
  },

  async getPayment(id) {
    const found = payments.get(id)
    return found ? structuredClone(found.payment) : null
  }
}

export const fakePayment = (id: string) => payments.get(id)

export const setFakeStatus = (id: string, status: MolliePayment['status']) => {
  const found = payments.get(id)
  if (found) found.payment.status = status
  return found
}
