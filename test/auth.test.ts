import { describe, expect, it } from 'bun:test'
import { LoginTokens } from '../src/db/models/index.js'
import { outbox } from '../src/services/mailer.js'
import { api, daysFromNow, seedSettings, seedUser, Users, Sessions } from './helpers.js'

const tokenFromOutbox = () => {
  const url = new URL(String(outbox.at(-1)!.data.url))
  expect(url.origin + url.pathname).toBe('https://shop.test/inloggen/verifieer')
  return url.searchParams.get('token')!
}

const cookieFrom = (headers: Headers) => {
  const raw = headers.get('set-cookie')!
  expect(raw).toMatch(/^__Host-vs_session=/)
  expect(raw).toMatch(/HttpOnly/i)
  expect(raw).toMatch(/Secure/i)
  expect(raw).toMatch(/SameSite=Lax/i)
  expect(raw).not.toMatch(/Domain=/i)
  return raw.split(';')[0]!
}

describe('magic link login', () => {
  it('logs an existing user into their account and never touches the password hash', async () => {
    await seedSettings()
    const userId = await seedUser({ email: 'jan@example.com', credit: 25 })

    const req = await api('POST', '/auth/magic-link', { email: 'Jan@Example.com', redirectTo: '/winkelmand' })
    expect(req.status).toBe(204)
    expect(outbox).toHaveLength(1)
    expect(outbox[0]!.to).toBe('jan@example.com')

    const verify = await api('POST', '/auth/magic-link/verify', { token: tokenFromOutbox() })
    expect(verify.status).toBe(200)
    expect(verify.body.user).toMatchObject({ id: String(userId), email: 'jan@example.com', credit: 25 })
    expect(verify.body.redirectTo).toBe('/winkelmand')

    const me = await api('GET', '/auth/me', undefined, { cookie: cookieFrom(verify.headers) })
    expect(me.body.id).toBe(String(userId))

    const raw = await Users.collection.findOne({ _id: userId })
    expect(raw).toMatchObject({ hash: 'legacy-hash', salt: 'legacy-salt' })
  })

  it('finds legacy mixed-case emails (old OAuth signups) and prefers the oldest match', async () => {
    await seedSettings()
    const oldest = await seedUser({ email: 'Piet@Example.com', createdAt: daysFromNow(-400) })
    await seedUser({ email: 'PIET@example.com', createdAt: daysFromNow(-10) })
    await api('POST', '/auth/magic-link', { email: 'piet@example.com' })
    const verify = await api('POST', '/auth/magic-link/verify', { token: tokenFromOutbox() })
    expect(verify.body.user.id).toBe(String(oldest))
  })

  it('tokens are single use', async () => {
    await seedSettings()
    await seedUser({ email: 'a@example.com' })
    await api('POST', '/auth/magic-link', { email: 'a@example.com' })
    const token = tokenFromOutbox()
    expect((await api('POST', '/auth/magic-link/verify', { token })).status).toBe(200)
    const again = await api('POST', '/auth/magic-link/verify', { token })
    expect(again.status).toBe(400)
    expect(again.body.error.code).toBe('INVALID_TOKEN')
  })

  it('rejects expired tokens even before the TTL monitor removes them', async () => {
    await seedSettings()
    await seedUser({ email: 'a@example.com' })
    await api('POST', '/auth/magic-link', { email: 'a@example.com' })
    const token = tokenFromOutbox()
    await LoginTokens.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } })
    expect((await api('POST', '/auth/magic-link/verify', { token })).status).toBe(400)
  })

  it('requires terms before creating a new account, without burning the token', async () => {
    await seedSettings()
    await api('POST', '/auth/magic-link', { email: 'new@example.com' })
    const token = tokenFromOutbox()

    const first = await api('POST', '/auth/magic-link/verify', { token })
    expect(first.status).toBe(409)
    expect(first.body.error.code).toBe('TERMS_REQUIRED')
    expect(await Users.countDocuments()).toBe(0)

    const second = await api('POST', '/auth/magic-link/verify', { token, agreeToTerms: true })
    expect(second.status).toBe(200)
    const user = await Users.findOne({ email: 'new@example.com' }).lean()
    expect(user?.agreeToTerms).toEqual(['agrees'])
  })

  it('creates the account directly when terms were accepted on the request', async () => {
    await seedSettings()
    await api('POST', '/auth/magic-link', { email: 'new@example.com', agreeToTerms: true })
    expect((await api('POST', '/auth/magic-link/verify', { token: tokenFromOutbox() })).status).toBe(200)
  })

  it('drops open-redirect targets', async () => {
    await seedSettings()
    await seedUser({ email: 'a@example.com' })
    await api('POST', '/auth/magic-link', { email: 'a@example.com', redirectTo: '//evil.com/x' })
    const verify = await api('POST', '/auth/magic-link/verify', { token: tokenFromOutbox() })
    expect(verify.body.redirectTo).toBeNull()
  })

  it('rate limits per email, counting the client IP from X-Forwarded-For', async () => {
    await seedSettings()
    const send = (ip: string) =>
      api('POST', '/auth/magic-link', { email: 'a@example.com' }, { headers: { 'x-forwarded-for': `1.1.1.1, ${ip}` } })
    for (let i = 0; i < 3; i++) expect((await send(`10.0.0.${i}`)).status).toBe(204)
    expect((await send('10.0.0.9')).status).toBe(429)
  })

  it('logout destroys the session', async () => {
    await seedSettings()
    await seedUser({ email: 'a@example.com' })
    await api('POST', '/auth/magic-link', { email: 'a@example.com' })
    const verify = await api('POST', '/auth/magic-link/verify', { token: tokenFromOutbox() })
    const cookie = cookieFrom(verify.headers)
    expect((await api('POST', '/auth/logout', undefined, { cookie })).status).toBe(204)
    expect(await Sessions.countDocuments()).toBe(0)
    expect((await api('GET', '/auth/me', undefined, { cookie })).body).toBeNull()
  })
})

describe('request guard', () => {
  it('rejects non-JSON POSTs (forces a CORS preflight)', async () => {
    await seedSettings()
    const { app } = await import('./helpers.js')
    const res = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' }
    })
    expect(res.status).toBe(415)
  })

  it('rejects state-changing requests from foreign origins', async () => {
    const res = await api('POST', '/auth/magic-link', { email: 'a@example.com' }, { origin: 'https://evil.com' })
    expect(res.status).toBe(403)
  })

  it('allows the shop origin with credentials', async () => {
    await seedSettings()
    const { app } = await import('./helpers.js')
    const res = await app.request('/api/v1/auth/me', { headers: { origin: 'https://shop.test' } })
    expect(res.headers.get('access-control-allow-origin')).toBe('https://shop.test')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })
})

describe('/me', () => {
  it('updates only whitelisted fields; email is not writable', async () => {
    await seedSettings()
    const userId = await seedUser({ email: 'a@example.com' })
    const { login } = await import('./helpers.js')
    const cookie = await login(userId)
    const ok = await api('PATCH', '/me', { firstName: 'Mieke', telephone: ['0470'] }, { cookie })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ firstName: 'Mieke', fullName: 'Mieke Peeters', telephone: ['0470'] })
    expect((await api('PATCH', '/me', { email: 'victim@example.com' }, { cookie })).status).toBe(400)
    expect((await api('PATCH', '/me', { credit: 1000 }, { cookie })).status).toBe(400)
  })

  it('requires login', async () => {
    expect((await api('GET', '/me')).status).toBe(401)
  })
})
