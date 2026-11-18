import { describe, expect, it } from 'bun:test'

const base = {
  PATH: process.env.PATH ?? '',
  MONGO_URI: 'mongodb://localhost/x',
  API_URL: 'https://api.test',
  SHOP_URL: 'https://shop.test',
  CORS_ORIGINS: 'https://shop.test'
}

const load = (extra: Record<string, string>) =>
  Bun.spawnSync(['bun', '-e', "await import('./src/env.ts')"], { env: { ...base, ...extra }, stderr: 'pipe' })

describe('environment guard', () => {
  it('refuses DEV_TOOLS in production, and when APP_ENV is left unset', () => {
    const explicit = load({ DEV_TOOLS: 'true', APP_ENV: 'production' })
    expect(explicit.exitCode).toBe(1)
    expect(explicit.stderr.toString()).toContain('DEV_TOOLS')
    expect(load({ DEV_TOOLS: 'true' }).exitCode).toBe(1)
  })

  it('allows DEV_TOOLS on local and staging, and production without it', () => {
    expect(load({ DEV_TOOLS: 'true', APP_ENV: 'local' }).exitCode).toBe(0)
    expect(load({ DEV_TOOLS: 'true', APP_ENV: 'staging' }).exitCode).toBe(0)
    expect(load({ APP_ENV: 'production' }).exitCode).toBe(0)
    expect(load({}).exitCode).toBe(0)
  })
})
