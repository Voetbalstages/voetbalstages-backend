import { env } from '../env.js'

export interface MolliePayment {
  id: string
  status: 'open' | 'canceled' | 'pending' | 'authorized' | 'expired' | 'failed' | 'paid'
  amount: { value: string; currency: string }
  expiresAt?: string
  metadata: { orderId: string; userId: string; deposit?: boolean; organizationId?: string }
  _links: { checkout?: { href: string } } & Record<string, unknown>
  [key: string]: unknown
}

export interface CreatePaymentInput {
  amount: number
  description: string
  redirectUrl: string
  webhookUrl: string
  metadata: MolliePayment['metadata']
  profileId: string
  applicationFee?: { amount: number; description: string }
}

export interface MollieGateway {
  createPayment(input: CreatePaymentInput): Promise<MolliePayment>
  getPayment(id: string): Promise<MolliePayment | null>
}

const API = 'https://api.mollie.com/v2'

let cachedToken: { value: string; expiresAt: number } | null = null

/** OAuth access token from the platform refresh token (same credentials as the old backend). */
const accessToken = async () => {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value
  const res = await fetch('https://api.mollie.com/oauth2/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env.MOLLIE_REFRESH_TOKEN,
      client_id: env.MOLLIE_CLIENT_ID,
      client_secret: env.MOLLIE_CLIENT_SECRET
    })
  })
  if (!res.ok) throw new Error(`Mollie token request failed: ${res.status}`)
  const data = (await res.json()) as { access_token: string; expires_in: number }
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 }
  return cachedToken.value
}

const money = (n: number) => ({ currency: 'EUR', value: n.toFixed(2) })

const httpGateway: MollieGateway = {
  async createPayment(input) {
    const res = await fetch(`${API}/payments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: money(input.amount),
        description: input.description,
        redirectUrl: input.redirectUrl,
        webhookUrl: input.webhookUrl,
        metadata: input.metadata,
        profileId: input.profileId,
        testmode: env.MOLLIE_TESTMODE,
        ...(input.applicationFee && {
          applicationFee: {
            amount: money(input.applicationFee.amount),
            description: input.applicationFee.description
          }
        })
      })
    })
    if (!res.ok) throw new Error(`Mollie create payment failed: ${res.status} ${await res.text()}`)
    return (await res.json()) as MolliePayment
  },

  async getPayment(id) {
    if (!/^tr_[A-Za-z0-9]+$/.test(id)) return null
    const res = await fetch(`${API}/payments/${id}?testmode=${env.MOLLIE_TESTMODE}`, {
      headers: { Authorization: `Bearer ${await accessToken()}` }
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Mollie get payment failed: ${res.status}`)
    return (await res.json()) as MolliePayment
  }
}

let gateway: MollieGateway = httpGateway

export const mollie = (): MollieGateway => gateway

/** Test hook. */
export const setMollieGateway = (g: MollieGateway | null) => {
  gateway = g ?? httpGateway
}
