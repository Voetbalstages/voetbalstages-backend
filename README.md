# voetbalstages-backend

REST API for the voetbalstages shop client. It runs side by side with the old Express +
GraphQL backend on the **same MongoDB**. See [REFACTOR.md](REFACTOR.md) for the migration plan
and [DEV_REST_API.md](DEV_REST_API.md) for the API contract. Live docs: `/api/v1/docs`.

Stack: Bun, TypeScript, [Hono](https://hono.dev) + `@hono/zod-openapi`, Mongoose 8,
Mollie (REST), AWS SES via `email-templates` (pug), `bun test` + a throwaway `mongod`.

## Develop

```sh
cp .env.example .env          # defaults point at a local Mongo, mails are logged not sent
docker run -d -p 27017:27017 --name vs-mongo mongo:8.0.17   # or use the old repo's compose Mongo
bun install
bun run dev                   # http://localhost:3000/api/v1/docs
bun run test                  # spawns a throwaway mongod, no network needed after first run
bun run typecheck
```

The session cookie is `__Host-` prefixed (Secure), so use `http://localhost` (browsers treat it
as secure) or HTTPS.

### Local stack with Docker (MongoDB + seed data + API)

```sh
docker compose up --build     # API on http://localhost:3000/api/v1/docs, MongoDB on :27017
```

A one-shot `seed` service fills an empty database with mock data (skipped if data exists):
2 organizations, 6 locations (visible, auto, hidden), 13 camps (open, early bird, force-pay window,
past, hidden, canceled, every option type), 5 users and registrations in every status.

| Login (magic link)              | What it is                                                 |
|---------------------------------|------------------------------------------------------------|
| `ouder@voetbalstages.test`      | Parent with 3 students, 9 registrations, EUR 25 credit      |
| `ouder2@voetbalstages.test`     | Second parent (ownership checks), 2 registrations           |
| `nieuw@voetbalstages.test`      | Fresh account: no students, no orders                       |
| `manager@…` / `admin@…`         | MANAGER / ADMIN roles                                       |

Any other email also works and creates a new account (terms must be accepted).

`DEV_TOOLS=true` (set in the compose file, never set it in production) makes two things work
without outside services:

- **Login links:** mail is not sent; request a link, then read the URL from `docker compose logs api`
  (`docker compose logs api | grep token=`). Send the token to `POST /auth/magic-link/verify`.
- **Payments:** Mollie is replaced by a fake checkout page at `/api/v1/dev/checkout/<id>` where you
  choose paid / pending / failed / canceled / expired; it then runs the real webhook handler and
  redirects to `SHOP_URL/bestellingen/<orderId>`. Fake payments live in memory (lost on restart).

```sh
docker compose run --rm seed bun scripts/seed.ts --reset   # wipe the dev database and re-seed
docker compose down -v                                     # remove everything incl. the data volume
bun run seed                                               # seed a local mongod without Docker
```

`seed` refuses to run against a non-local `MONGO_URI` (override with `SEED_FORCE=true`). Seeded dates
are relative to the seed time, so re-seed when the camps are in the past. If `mongo:8.0` crashes
with a kernel error (Docker VM kernel 6.19 to 7.0.13), the stack uses `mongo:8.2`; override with
`MONGO_IMAGE=...`.

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

## Environments

| | local | staging | production |
|---|---|---|---|
| Compose file | `docker-compose.yml` | `docker-compose.staging.yml` | none (Coolify *Docker Image* app) |
| `APP_ENV` | `local` | `staging` | `production` (default) |
| MongoDB | container, port published | container, authenticated, internal only, persistent volume | the existing database |
| Seed data | on first start | on first start, refreshed once all camps are past | never |
| `DEV_TOOLS` (fake Mollie, login links in logs) | on | on | refused at startup |
| Image | built locally | `ghcr.io/…:staging` (branch `staging`) | `ghcr.io/…:latest` (branch `main`) |

`APP_ENV` defaults to `production`, and the API refuses to start with `DEV_TOOLS=true` in that case,
so a forgotten variable can never turn on fake payments in production.

### Staging (Coolify)

Same stack as local (MongoDB + seed + API) as one Docker Compose application, deployed from the
`staging` branch. The seed only fills an empty database, so staging keeps its data (and any accounts
testers create) across deploys. Because seeded dates are relative to the seed time, the seed wipes and
re-seeds on a deploy once no camp starts in the future any more (`SEED_REFRESH_STALE`). Force it any
time with `docker compose exec api bun scripts/seed.ts --reset` (or the Coolify terminal).

One-time setup:

1. **GitHub:** create the `staging` branch and push it once, so the `:staging` image exists in GHCR.
   Add repo secret `COOLIFY_STAGING_WEBHOOK_URL` (`COOLIFY_TOKEN` is shared with production).
   Pushing to `staging` then runs the tests, publishes the image and calls the webhook.
2. **Coolify:** new resource, *Docker Compose* (empty/raw or from this repo), compose file
   `docker-compose.staging.yml`. Give the `api` service a domain on port `3000`, e.g.
   `https://api-staging.voetbalstages.be:3000`. If the GHCR package is private, the server needs the
   same registry login as production. Copy the deploy webhook URL from the resource into the secret above.
3. **Environment variables** (Coolify generates `SERVICE_USER_MONGO` / `SERVICE_PASSWORD_MONGO` itself):

| Variable | Value |
|---|---|
| `API_URL` | the public URL of the `api` domain (Mollie redirects and fake checkout links use it) |
| `SHOP_URL` | staging shop origin (magic links, order redirects) |
| `CORS_ORIGINS` | the same staging shop origin |
| `TRUSTED_PROXY_COUNT` | optional, default `1` (Traefik); `2` with Cloudflare in front |
| `API_IMAGE`, `MONGO_VERSION`, `LOG_LEVEL` | optional overrides |

Use it like local: request a magic link, read the URL from the `api` logs in Coolify, and pay through
the fake checkout at `$API_URL/api/v1/dev/checkout/<id>`. Mail is not sent in staging. The mock logins
are listed in the local section above. Staging login links sit in the logs, so only give Coolify
access to people who may use staging.

## Deploy (Coolify)

On every push to `main`, GitHub Actions runs typecheck + tests, then builds and pushes
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
