# voetbalstages-backend

REST API for the voetbalstages shop client. It runs side by side with the old Express +
GraphQL backend on the **same MongoDB**. See [REFACTOR.md](REFACTOR.md) for the migration plan
and [DEV_REST_API.md](DEV_REST_API.md) for the API contract. Live docs: `/api/v1/docs`.

Stack: Node 24, TypeScript, [Hono](https://hono.dev) + `@hono/zod-openapi`, Mongoose 8,
Mollie (REST), AWS SES via `email-templates` (pug), vitest + mongodb-memory-server.

## Develop

```sh
cp .env.example .env          # defaults point at a local Mongo, mails are logged not sent
docker run -d -p 27017:27017 --name vs-mongo mongo:8.0.17   # or use the old repo's compose Mongo
npm install
npm run dev                   # http://localhost:3000/api/v1/docs
npm test                      # in-memory Mongo, no network needed after first run
npm run typecheck
```

The session cookie is `__Host-` prefixed (Secure), so use `http://localhost` (browsers treat it
as secure) or HTTPS.

## Rules for working on the shared database

The old backend and admin read and write the same collections. Until step 3 of the refactor:

- Legacy models in `src/db/models` mirror the old schemas exactly. Don't add fields, change types
  or rename models (the model name decides the collection, e.g. `activity` → `activities`).
- Legacy models have `autoIndex`/`autoCreate` off. Only `login_tokens` and `rest_sessions` are
  owned (and indexed) by this service.
- Never touch `users.hash` / `users.salt` / `users.resetToken`. The old admin still logs in with them.
- Money-moving code (orders, credit, cancel, webhook) uses guarded updates and a per-user lock.
  Keep it that way. `test/orders.test.ts`, `payments.test.ts` and `cancel.test.ts` cover it.
- No cron jobs here; the old backend runs the nightly payment check.

## Deploy (Coolify)

On every push to `master`, GitHub Actions runs typecheck + tests, then builds and pushes
`ghcr.io/voetbalstages/voetbalstages-backend:{latest,<sha>}`, then calls the Coolify deploy webhook.

One-time setup:

1. **GitHub repo secrets:** `COOLIFY_WEBHOOK_URL` (the app's deploy webhook URL from Coolify) and
   `COOLIFY_TOKEN` (a Coolify API token with deploy permission). Without them the deploy job is skipped.
2. **Coolify app:** type *Docker Image*, image `ghcr.io/voetbalstages/voetbalstages-backend:latest`,
   port `3000`, health check path `/health`. If the GHCR package is private, add a registry
   credential (GitHub PAT with `read:packages`) in Coolify.
3. **Environment variables** (see `.env.example`):

| Variable | Example / notes |
|---|---|
| `MONGO_URI` | same database as the old backend (step 2) |
| `API_URL` | `https://api.voetbalstages.be` (Mollie webhook base) |
| `SHOP_URL` | new client origin: magic links, Mollie redirect, mail links |
| `CORS_ORIGINS` | comma-separated exact origins, e.g. `https://nieuw.voetbalstages.be` |
| `TRUSTED_PROXY_COUNT` | `1` behind Coolify's Traefik, `2` with Cloudflare in front |
| `MAIL_DISABLED` | `false` in production |
| `AWS_SES_REGION`, `AWS_SES_USER_KEY`, `AWS_SES_USER_SECRET` | same SES user as the old backend |
| `MOLLIE_CLIENT_ID`, `MOLLIE_CLIENT_SECRET`, `MOLLIE_REFRESH_TOKEN` | same Mollie OAuth app |
| `MOLLIE_TESTMODE` | `false` in production |
| `APPLICATION_FEE` | platform fee per registration in EUR |
| `N8N_WEBHOOK_URL`, `BUGSNAG_API_KEY` | optional |
