# Backend refactor plan

Moving voetbalstages from the monolithic Express + GraphQL server (`voetbalstages` repo) to
this standalone REST backend, without a big-bang cutover. During the move both backends run
side by side on the same MongoDB.

## Step 1: Standalone REST backend ✅ (this repo)

Build the client-facing REST API described in [DEV_REST_API.md](DEV_REST_API.md).

- Hono + TypeScript on Node 24, Mongoose models that mirror the old schemas exactly (same
  model and collection names, no index builds on existing collections).
- Passwordless login (magic link) on the existing `users` collection. The old
  `hash`/`salt` password fields are never touched, so the old admin keeps working.
- Own sessions in a new `rest_sessions` collection, plus a new `login_tokens` collection.
- No cron jobs. The old backend keeps running its 03:00 payment check.
- Deployed as a Docker image: GitHub Actions → GHCR → Coolify deploy webhook.
- Runs against a local/dev MongoDB only. Nothing points at prod yet.

Fixes over the old business logic, already built into this backend:

- Order creation is validated up front: the student belongs to the caller, the camp is
  bookable, camp options are filled in, no duplicates, one organization. It is rolled back on any failure.
- Store credit is applied atomically, and only to registrations that still need paying.
- Paying an order checks it belongs to the caller and reuses an open Mollie checkout instead of
  creating a second one.
- Cancel is atomic, enforces `cancelDays`, and is refused while a payment is in progress.
- The Mollie webhook never downgrades a `deposited` registration and sends mails only when a status actually changes.

## Step 2: Connect to prod DB, new shop client uses it

**Before pointing this backend at prod:**

1. Run these read-only checks on the prod DB:
   - `db.users.getIndexes()`: is there a unique index on `email`? (There probably isn't.)
   - How many users have a `facebookId` and no usable email? Those can't use magic-link login.
   - How many emails collide case-insensitively? The new login picks the oldest account.
2. Patch the old backend, which stays live for the old client and admin:
   - `services/crons.js` `checkPayments`: only consider `status: 'payment_pending'`
     registrations and skip deposit payments. Today it turns `refunded`/`canceled`
     registrations back into `confirmed`.
   - `services/payment.js` `updatePayment`: non-paid Mollie statuses must only touch
     `payment_pending` registrations, never downgrade `deposited` to `open`.
   - `services/payment.js` `useCredit` + `resolvers/order.js` `payOrder`: only credit
     payable registrations, and add to `paid` instead of overwriting it. Add an ownership check
     to `payOrder`.
   - `resolvers/registration.js` `cancelAndRefund`: atomic status guard before crediting,
     enforce `cancelDays`, refuse while a Mollie payment is open or pending for the order.
3. Hostnames: API on `api.voetbalstages.be`; new shop client on its own host (e.g.
   `nieuw.voetbalstages.be`) until DNS cutover from the old client on `shop.voetbalstages.be`.
4. Configure the Coolify app (env vars, see README), point `MONGO_URI` at prod, deploy.
5. New shop client connects (building the client is out of scope here).

## Step 3: Admin app on the new backend (API built ✅, admin app not switched yet)

The admin needs no routes of its own: the shared resources are role-aware (see Part B of [DEV_REST_API.md](DEV_REST_API.md)); still to do:
login decision, rewriting the admin app against REST, retiring the old server.

Add the admin/manager endpoints (camp, location, organization CRUD, users, settings, CSV
exports, registration lists, Google Places proxy) to this backend. Then point the admin app
at it and retire the old Express/GraphQL server and its cron, moving the payment check here if
it's still needed.

Admin login needs a decision: magic link for admins too, or a separate admin auth.

## Step 4: Migrate MongoDB to Postgres (TBD)

Once only this backend talks to the database, replace the Mongoose models with a Postgres
schema plus a data migration. The REST contract stays the same, so the clients don't change.
