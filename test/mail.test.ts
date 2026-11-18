import { describe, expect, it } from 'vitest'
import { renderMail } from '../src/services/mailer.js'
import { statusTranslations } from '../src/services/orderMail.js'

const registrations = [
  {
    status: 'confirmed',
    student: { name: 'Lars' },
    camp: { name: 'Week 1', from: new Date('2026-07-06T11:00:00Z'), to: new Date('2026-07-10T11:00:00Z') },
    location: { name: 'Antwerpen' }
  }
]
const order = { name: 'Jan', registrations, statusTranslations, orderId: '20260721-483920', orderLink: 'https://shop.test/bestellingen/20260721-483920' }

describe('email templates', () => {
  it('magic link', async () => {
    const { subject, html } = await renderMail('magicLink', { name: 'Jan', url: 'https://shop.test/inloggen/verifieer?token=abc', minutes: 15 })
    expect(subject).toBe('Inloggen op Voetbalstages.be')
    expect(html).toContain('https://shop.test/inloggen/verifieer?token=abc')
    expect(html).toContain('Beste Jan')
  })

  it.each(['orderConfirmed', 'paymentConfirmed', 'depositConfirmed', 'registrationCanceled'] as const)(
    '%s renders the registrations table with formatted dates',
    async template => {
      const { subject, html } = await renderMail(template, { ...order, amount: '€ 195,00', addedCredit: '€ 195,00' })
      expect(subject.length).toBeGreaterThan(0)
      expect(html).toContain('Lars')
      expect(html).toContain('06/07/2026')
      expect(html).toContain('20260721-483920')
    }
  )
})
