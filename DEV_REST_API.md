# Client REST API specification

A REST equivalent of everything the **client** front-end (`/client`) needs from the server.

> **One API, two audiences.** The shop and the admin panel call the *same* routes. There is no
> separate admin API: the logged-in user decides what a call returns and what it may do. A parent
> sees and changes their own data; staff (`ADMIN`, `MANAGER`) see more and an `ADMIN` can write
> catalogue data. See [Part B](#part-b-roles-and-permissions) for the full rules. Operations that
> need a role say **Requires: ADMIN** / **staff** in their Swagger description, and the few
> resources that only staff use (`/users`) are listed there too. Shop developers can ignore those.

**Implemented in this repo (step 1 of [REFACTOR.md](REFACTOR.md)). Live, always-current docs: `GET /api/v1/docs` (Swagger UI) and `GET /api/v1/openapi.json`.**

---

## 1. Conventions

| Topic | Rule |
|---|---|
| Base path | `/api/v1` |
| Format | JSON request and response bodies (`Content-Type: application/json`) |
| IDs | Mongo ObjectId strings, exposed as `id` (never `_id`) |
| Dates | ISO-8601 UTC strings (`2026-07-06T11:00:00.000Z`). `Student.dob` stays a plain string, as today |
| Money | Numbers in EUR, 2 decimals |
| Auth | Passwordless magic link → host-only session cookie `__Host-vs_session` (HttpOnly, Secure, SameSite=Lax, 30 days sliding). Send `credentials: 'include'` |
| CSRF | Every `POST` must send `Content-Type: application/json` (also when bodiless), otherwise `415`. State-changing requests from an `Origin` outside the allowlist get `403` |
| Collections | Return a JSON array; paginated collections also set `X-Total-Count` and accept `page` (0-based) and `perPage` |
| Sorting | `sort=<field>` and `order=asc|desc` where noted |
| Errors | `{ "error": { "code": "...", "message": "..." } }` with the HTTP status below |

### Status codes

| Code | Meaning |
|---|---|
| 200 | OK |
| 201 | Created |
| 204 | No content (deletes, logout) |
| 400 | Validation error |
| 401 | Not authenticated |
| 403 | Authenticated but not the owner of the resource |
| 404 | Not found |
| 409 | Conflict (e.g. duplicate registration, mixed-organization order) |
| 415 | POST without `Content-Type: application/json` |
| 429 | Rate limited (magic-link requests) |
| 502 | Payment provider (Mollie) error; nothing was charged or changed |

### Important behavioural note

Today **every list endpoint is implicitly scoped to the logged-in user**: a non-admin only
ever sees their own students, registrations and orders. The REST API must keep that —
ownership filtering happens server-side, never via a client-supplied `userId`. Staff are the
exception and see more on the same routes, see [Part B](#part-b-roles-and-permissions).

---

## 2. Authentication (magic link)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/auth/magic-link` | public | Email a one-time login link |
| `POST` | `/api/v1/auth/magic-link/verify` | public | Exchange the token for a session |
| `POST` | `/api/v1/auth/logout` | user | Destroy session → `204` |
| `GET` | `/api/v1/auth/me` | public | Current user or `null` |

Passwords, Google and Facebook login are gone. Existing accounts are matched by email
(case-insensitive), so every existing user keeps their students, orders and credit.

**`POST /api/v1/auth/magic-link`**

```json
{ "email": "jan@example.com", "agreeToTerms": true, "redirectTo": "/winkelmand" }
```

Always `204`, whether or not the account exists. `redirectTo` must be a relative path (anything
else is dropped) and is handed back by verify. `agreeToTerms` only matters when the email has no
account yet. Limited to 3 requests / 15 min per email and 20 / 15 min per IP (`429`).

The mail links to **`SHOP_URL/inloggen/verifieer?token=…`**, so the new client must implement that
route. The link is valid for 15 minutes and can be used once.

**`POST /api/v1/auth/magic-link/verify`** → `{ "token": "…", "agreeToTerms": true }`

- `200 { "user": User, "redirectTo": "/winkelmand" | null }` and the session cookie is set.
- `400 INVALID_TOKEN` when the token is unknown, used or expired.
- `409 TERMS_REQUIRED` when the email is new and terms were not accepted. The token is **not**
  consumed: show the terms checkbox and call verify again with `agreeToTerms: true`.

Client page rules: call verify with `fetch` from the page (never let the API be opened with a GET,
since mail scanners prefetch links and would burn the token). Strip `token` from the URL
(`history.replaceState`) before calling verify. The localStorage cart is lost if the link opens in
a different browser (mail apps' in-app browsers); consider asking for login before the cart fills.

---

## 3. Current user

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/me` | user | Current user profile (alias of `/api/v1/auth/me`) |
| `PATCH` | `/api/v1/me` | user | Update own profile |

`PATCH` body: only these fields are writable (strict whitelist, unknown fields → `400`):

```json
{
  "firstName": "Jan",
  "lastName": "Peeters",
  "secondEmail": "",
  "telephone": ["0470123456"],
  "address": { "postcode": "2000", "streetAddress": "", "city": "", "district": "",
               "province": "", "formatted": "", "lat": 0, "lng": 0, "placeId": "" }
}
```

`email`, `role`, `credit` and `organizationIds` are **not** client-writable. `email` is the login
identity: a self-service change would allow account takeover, so it is not offered in step 1.

### User object

```json
{
  "id": "…",
  "firstName": "Jan",
  "lastName": "Peeters",
  "fullName": "Jan Peeters",
  "email": "jan@example.com",
  "secondEmail": "",
  "telephone": ["0470123456"],
  "credit": 25.0,
  "address": { "postcode": "2000", "…": "" },
  "isAdmin": false,
  "isManager": false
}
```

`fullName` falls back to the email when both names are empty. `credit` is store credit from
refunds and is consumed automatically at checkout.

---

## 4. Students (children)

Every student is owned by one or more users; the client only ever sees its own.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/students` | user | Own students |
| `POST` | `/api/v1/students` | user | Create (caller becomes owner) |
| `GET` | `/api/v1/students/{id}` | owner | Single student |
| `PATCH` | `/api/v1/students/{id}` | owner | Update |
| `DELETE` | `/api/v1/students/{id}` | owner | Delete → `204` |

Body (create and update):

```json
{
  "name": "Lars",
  "dob": "2015-04-12",
  "food": ["vegetarisch"],
  "foodOther": "",
  "currentClub": "KFC Voorbeeld",
  "remarks": ""
}
```

Response:

```json
{
  "id": "…",
  "name": "Lars",
  "dob": "2015-04-12",
  "food": [], "foodOther": "", "currentClub": "", "remarks": "",
  "owner": [ { "id": "…", "firstName": "Jan", "lastName": "Peeters", "email": "…" } ]
}
```

---

## 5. Locations

Public — no login needed. The client renders a map of all visible locations, then a detail
page addressed by `path` (the URL slug).

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/locations` | public | All visible locations |
| `GET` | `/api/v1/locations/{id}` | public | By id |
| `GET` | `/api/v1/locations/by-path/{path}` | public | By slug — used for `/{locationPath}` routes |
| `GET` | `/api/v1/locations/{id}/camps` | public | Camps at this location |

`GET /api/v1/locations` query parameters: `visibility=VISIBLE|AUTO` (default: everything except
`HIDDEN`), `organizationId`, `q` (matches name, city, postcode), `page`, `perPage`, `sort=name|path`,
`order`. Hidden locations are never returned.

`GET /api/v1/locations/{id}/camps` query parameters: `year`, `excludePast=true`, `period`.
The client asks for `year = (today + 6 weeks).year()`. Hidden camps are never returned to
non-admins.

Location object:

```json
{
  "id": "…",
  "path": "antwerpen",
  "name": "Antwerpen",
  "logo": { "uri": "https://…", "name": "…" },
  "address": { "streetAddress": "…", "postcode": "2000", "district": "", "city": "Antwerpen",
               "lat": 51.21, "lng": 4.41 },
  "addressString": "Straat 1, 2000 Antwerpen",
  "extInfo": "<html>",
  "message": "<html>",
  "organization": { "id": "…", "name": "Voetbalstages" }
}
```

`404` when the path does not resolve — the current client redirects to `/` in that case.

---

## 6. Camps

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/camps` | public | List / filter camps |
| `GET` | `/api/v1/camps/{id}` | public | Single camp |
| `GET` | `/api/v1/camps/available` | public | Bookable subset of a list of ids — cart revalidation |

`GET /api/v1/camps` query parameters: `locationId`, `organizationId`, `period`, `year`,
`excludePast=true`, `ids=a,b,c`, `q`, `page`, `perPage`, `sort=from|period|name`, `order`.

`GET /api/v1/camps/available?ids=a,b,c` returns only camps with `status = OPEN` **and**
`from > now` (the GraphQL `availableCamps` query). The client calls this on boot to drop
stale items from the localStorage cart.

Camp object:

```json
{
  "id": "…",
  "name": "Zomerstage week 1",
  "period": "2026-zomer-1",
  "from": "2026-07-06T11:00:00.000Z",
  "to": "2026-07-10T11:00:00.000Z",
  "duration": 5,
  "status": "OPEN",
  "options": ["GADGETS", "TSHIRTSIZE"],
  "costDetail": {
    "cost": 195.0,
    "currentDiscount": 10.0,
    "currentDiscountToInc": "2026-05-01T00:00:00.000Z",
    "deposit": 50.0,
    "depositTotal": 50.0,
    "total": 185.0,
    "forcePay": false
  },
  "location": { "id": "…", "name": "Antwerpen",
                "organization": { "id": "…", "name": "Voetbalstages" } }
}
```

Notes:
- `status` is computed: a camp stored as `OPEN` but already started reports `CLOSED`.
  `HIDDEN` camps are filtered out for non-admins.
- `duration` is inclusive day count.
- `costDetail` is derived per request from the camp price plus global `Settings`
  (early-bird discount, deposit rules, force-pay window). Never recompute it client-side.
- `options` drives which extra fields the booking form must collect (see §7).

### Per-user camp sub-resources

These come back today as fields on `Camp` and are only meaningful for a logged-in user.
Expose them as sub-resources (returning `[]` when logged out):

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/camps/{id}/available-students` | user | Own students who can still be booked into this camp |
| `GET` | `/api/v1/camps/{id}/registered-students` | user | Own students already registered (status open, payment_pending, confirmed or deposited) |
| `GET` | `/api/v1/camps/{id}/registrations` | user | Own registrations for this camp |

---

## 7. Cart (client-side) and the checkout contract

There is **no cart resource on the server**. The cart lives in localStorage
(`svs__cart__items`) as `[{ campId, studentId, gadgets, tshirtSize, shortSize, shoeSize }]`
and only materialises at checkout. The rebuilt client owns this, but must respect the
server-side rules:

1. **Per-camp option fields**, required only when the camp lists the option:
   - `GADGETS` → `gadgets`: array of exactly 2 strings
   - `TSHIRTSIZE` → `tshirtSize`: string
   - `SHORTSIZE` → `shortSize`: string
   - `SHOESIZE` → `shoeSize`: number
2. **One organization per order.** All camps in a cart must belong to the same
   organization; the server rolls the whole order back and returns `409` otherwise.
3. **Force pay.** If any camp has `costDetail.forcePay`, the deposit option must be hidden —
   the order has to be paid in full.
4. **Re-validate on load** via `GET /api/v1/camps/available?ids=…` and `GET /api/v1/students`,
   dropping items whose camp or student has disappeared.
5. Totals shown in the cart are `sum(costDetail.total)` and `sum(costDetail.depositTotal)`.

---

## 8. Orders

An "order" is a group of registrations sharing an `orderId` (format `YYYYMMDD-######`).

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/orders` | user | Checkout: create registrations, optionally start payment |
| `GET` | `/api/v1/orders` | user | Own orders |
| `GET` | `/api/v1/orders/{orderId}` | user | Single order |
| `POST` | `/api/v1/orders/{orderId}/payment` | user | (Re)start payment for an outstanding order |

`GET /api/v1/orders` query parameters: `outstanding=true` returns only orders with status
`open` or `deposited` for camps that have not ended yet (the banner on the dashboard), plus
`page`, `perPage` and `order` (default `desc`, newest first). Sets `X-Total-Count`.

**`POST /api/v1/orders`** (replaces the `createOrder` mutation):

```json
{
  "registrations": [
    { "campId": "…", "studentId": "…", "gadgets": ["bal", "shirt"], "tshirtSize": "140" }
  ],
  "payNow": true,
  "deposit": false,
  "tracking": { "utm_source": "google", "gclid": "…", "landing_page": "…", "session_id": "…" }
}
```

`201`:

```json
{
  "order": { "id": "20260721-483920", "…": "" },
  "payUrl": "https://www.mollie.com/checkout/…",
  "credit": 0
}
```

Validation happens before anything is written:
- `404` if a student is not the caller's or a camp does not exist.
- `409 CAMP_NOT_BOOKABLE` unless every camp is `OPEN` and has not started.
- `409 DUPLICATE_IN_ORDER` for the same student/camp twice; `409 ALREADY_REGISTERED` if an active
  registration (open, payment_pending, confirmed, deposited) exists for the pair.
- `409 MIXED_ORGANIZATIONS` if the camps span more than one organization.
- `400 MISSING_OPTION` when a camp option (§7.1) is missing. Only fields for the camp's options are stored.
- `400 DEPOSIT_NOT_AVAILABLE` when `deposit: true` but a camp has no deposit or is in the
  force-pay window.
- `502` if Mollie fails: the whole order is rolled back, including credit.

Behaviour:
- Store credit is applied first; if credit covers the whole amount, `payUrl` is `null` and
  the registrations are marked paid immediately.
- A confirmation mail (`orderConfirmed`) and the conversion webhook fire on success.
- `tracking` is the optional attribution blob collected client-side (UTM params, `gclid`,
  `wbraid`, `gbraid`, `fbclid`, `fbp`, `fbc`, `landing_page`, `referrer`, `device_type`,
  `first_source`, `last_source`, `browser_simple`, `session_id`).
- When `payUrl` is returned the client redirects the browser to it. Mollie returns the user
  to `BASE_URL/bestellingen/{orderId}`, so that route must exist in the new client.

**`POST /api/v1/orders/{orderId}/payment`** (replaces `payOrder`) returns the same
`{ order, payUrl, credit }` shape for an order that is still open or deposit-only (`200`).
- If a Mollie checkout for this order is still open, its `payUrl` is returned again instead of
  creating a second payment.
- `409 PAYMENT_PENDING` while a payment is being processed (e.g. bank transfer).
- `409 NOTHING_TO_PAY` when the order is settled. `404` for orders that aren't the caller's.

Order object:

```json
{
  "id": "20260721-483920",
  "status": "open",
  "createdAt": "2026-07-21T09:12:00.000Z",
  "registrationCount": 2,
  "calculatedCost": { "total": 370.0, "paid": 50.0, "credit": 0, "open": 320.0 },
  "registrations": [ /* Registration objects, see §9 */ ]
}
```

`status` is aggregated over its registrations, in this precedence:
`payment_pending` → `open` → `deposited` → `confirmed` → `refunded` → `canceled`.

---

## 9. Registrations

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/registrations` | user | Own registrations |
| `GET` | `/api/v1/registrations/{id}` | owner | Single registration |
| `POST` | `/api/v1/registrations/{id}/cancel` | owner | Cancel, refunding to store credit |

`GET /api/v1/registrations` query parameters: `campId`, `studentId`, `status`, `orderId`,
`organizationId`, `page`, `perPage`, `sort`, `order`.

Registration object:

```json
{
  "id": "…",
  "status": "confirmed",
  "orderId": "20260721-483920",
  "paid": 185.0,
  "canCancel": true,
  "createdAt": "2026-07-21T09:12:00.000Z",
  "gadgets": ["bal", "shirt"],
  "tshirtSize": "140",
  "student": { "id": "…", "name": "Lars" },
  "camp": { "id": "…", "from": "…", "to": "…", "period": "…" },
  "location": { "id": "…", "name": "Antwerpen" },
  "calculatedCost": { "cost": 195.0, "currentDiscount": 10.0, "subTotal": 185.0,
                      "total": 185.0, "paid": 185.0, "toPay": 0 }
}
```

`status` ∈ `open`, `payment_pending`, `confirmed`, `deposited`, `canceled`, `refunded`.

Also included: `shortSize`, `shoeSize`, `camp.name` and `organizationId` (to look up whose
terms apply).

`canCancel` is server-computed: `true` only for `open`, `confirmed` and `deposited`, and
only while the camp start is further away than `Settings.cancelDays`. The client must use
this flag rather than deriving it.

**`POST /api/v1/registrations/{id}/cancel`** → `200`. `409 NOT_CANCELLABLE` when `canCancel` is
false, `409 PAYMENT_IN_PROGRESS` while a Mollie payment for the order is open or pending:

```json
{
  "registration": { "id": "…", "status": "refunded", "paid": 0, "canCancel": false },
  "credit": 185.0
}
```

Anything already paid is moved to the user's store credit and the status becomes `refunded`
(otherwise `canceled`); a `registrationCanceled` mail is sent. `credit` is the user's new
total and the client should refresh its cached user with it.

---

## 10. Organizations, terms and settings

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/organizations/{id}` | public | By id — used at checkout to show whose terms apply |
| `GET` | `/api/v1/organizations/by-path/{path}` | public | By slug |
| `GET` | `/api/v1/terms` | public | Global terms HTML |
| `GET` | `/api/v1/organizations/{path}/terms` | public | Organization-specific terms HTML |
| `GET` | `/api/v1/settings` | public | Public settings subset |

The client routes `/algemene_voorwaarden` and `/algemene_voorwaarden_{path}` map onto the
two terms endpoints; both return raw HTML inside `{ "terms": "<html>" }`.

Organization object: `{ "id": "…", "name": "…", "path": "v", "url": "<SHOP_URL>/v" }`.

`GET /api/v1/settings` must expose only what the public site needs — currently
`{ "earlyBirdToInc": "2026-05-01T00:00:00.000Z" }`. Deposit/cancel/force-pay day counts stay
server-side; their effect is already baked into `costDetail` and `canCancel`.

---

## 11. Payments (not called by the client)

Listed for completeness because the checkout flow depends on it:

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/payments/webhook` | Mollie | Form-encoded `id=tr_…`. The payment is re-fetched from Mollie; only payments created by this service are processed |

The client never calls this. It only redirects to `payUrl` and later lands on
`/bestellingen/{orderId}`, where it re-fetches the order. Because the webhook may not have
arrived yet, that page should tolerate a still-`payment_pending` order and re-poll.

---

## 12. Endpoint summary

All paths are under `/api/v1`.

```
POST   /auth/magic-link
POST   /auth/magic-link/verify
POST   /auth/logout
GET    /auth/me

GET    /me
PATCH  /me

GET    /users                      (staff)
GET    /users/export               (staff)
GET    /users/{id}                 (staff)
PATCH  /users/{id}                 (ADMIN)

POST   /uploads/logo               (ADMIN)
GET    /places/autocomplete        (login)
GET    /places/{placeId}           (login)

GET    /students
POST   /students
GET    /students/{id}
PATCH  /students/{id}
DELETE /students/{id}

GET    /locations
GET    /locations/{id}
GET    /locations/by-path/{path}
GET    /locations/{id}/camps
POST   /locations                  (ADMIN)
PATCH  /locations/{id}             (ADMIN)

GET    /camps
GET    /camps/available
GET    /camps/{id}
GET    /camps/{id}/available-students
GET    /camps/{id}/registered-students
GET    /camps/{id}/registrations
GET    /camps/{id}/registrations/export   (staff)
POST   /camps                      (ADMIN)
PATCH  /camps/{id}                 (ADMIN)

POST   /orders
GET    /orders
GET    /orders/{orderId}
POST   /orders/{orderId}/payment

GET    /registrations
GET    /registrations/{id}
POST   /registrations/{id}/cancel
PATCH  /registrations/{id}         (ADMIN)

GET    /organizations
POST   /organizations              (ADMIN)
PATCH  /organizations/{id}         (ADMIN)
GET    /organizations/{id}
GET    /organizations/by-path/{path}
GET    /organizations/{path}/terms
GET    /terms
GET    /settings
PATCH  /settings                   (ADMIN)

POST   /payments/webhook           (Mollie only)

GET    /docs                       (Swagger UI)
GET    /openapi.json
GET    /health                     (outside /api/v1)
```

---
---

# Part B: Roles and permissions

The admin panel uses the routes from sections 1-12. This part lists what changes with the role
of the logged-in user. Everything not listed here behaves as documented above.

## B1. Roles

| Role | Who | Can |
|---|---|---|
| *(none)* / anonymous | Parent / visitor | Public reads; manage **own** profile, children, orders, registrations |
| `MANAGER` | Staff of one or more organizations (`organizationIds`) | **Read-only.** Also sees `HIDDEN` camps/locations of their own organizations, and the extra fields below |
| `ADMIN` | Full access | Everything a manager can, plus every write below and cancelling any registration |

Login is the same magic link as the shop (open decision in [REFACTOR.md](REFACTOR.md) step 3:
whether admins later get a separate login). `GET /me` returns `role`, `organizationIds` and, for
staff, `organizations` (all of them for an admin): what the organization switcher needs. The old
`Context-Organization` header is replaced by the optional `organizationId` query on list routes.

## B2. Same route, different result

| Route | Parent / anonymous | Staff |
|---|---|---|
| `GET /students` | own children | **all children**; extra filters `name`, `ownerId`, `ids` |
| `GET /students/{id}` | own | any |
| `PATCH` / `DELETE /students/{id}` | own | **ADMIN**: any child. Manager: read-only |
| `GET /registrations` | own | **all** (MANAGER: own organizations); extra filters `userId`, `locationId`, `year`, `period`, `orderId` (prefix) |
| `GET /registrations/{id}` | own | any (MANAGER: own organizations) |
| `POST /registrations/{id}/cancel` | own, within `cancelDays`, no open payment | **ADMIN**: any registration, any time; refund goes to the owning parent |
| `GET /camps`, `GET /camps/{id}` | not `HIDDEN` | **ADMIN**: all statuses; **MANAGER**: also `HIDDEN` of own organizations. Extra filter `status` (stored status) |
| `GET /locations`, `/{id}`, `/by-path/{path}`, `/{id}/camps` | not `HIDDEN` | same rule as camps; `visibility` filter accepts `HIDDEN` |
| `GET /camps/{id}/registrations` | own registrations for the camp | **every** registration of the camp (all parents, all statuses, optional `status`) |
| `GET /organizations`, `/{id}`, `/by-path/{path}` | `id`, `name`, `path`, `url` | adds `mollieProfileId` and `terms` (ADMIN, or MANAGER of that organization) |
| `GET /settings` | `earlyBirdToInc` only | adds `earlyBirdDiscount`, `depositDays`, `forcePayDays`, `cancelDays`, `emailFrom`, `terms` |
| `GET /me` | the user | adds `organizations` |

Camp and location objects always include the extra fields `storedStatus`, `cost`, `deposit`,
`earlyBirdToInc`, `locationId`, `organizationId` (camp) and `visibility`, `organizationId`
(location): they are not secret and make the objects editable as-is. Registrations always include
`price`, the full `student` (`dob`, `food`, `foodOther`, `currentClub`, `remarks`) and the owning `user`
(names, emails, telephone): for a parent that is their own data.

## B3. Write routes that need `ADMIN`

`403 FORBIDDEN` for managers and parents (`401` when anonymous).

| Method | Path | Notes |
|---|---|---|
| `POST` | `/organizations` | `mollieProfileId` must look like `pfl_xxxx`; `path` is a unique lowercase slug (`409 PATH_TAKEN`) |
| `PATCH` | `/organizations/{id}` | Partial. Organizations cannot be deleted |
| `POST` | `/locations` | `name`, `path`, `organizationId` required; `visibility` defaults to `HIDDEN` |
| `PATCH` | `/locations/{id}` | Partial; `address` replaced as a whole; changing organization refused with `409 HAS_CAMPS` once camps exist. No delete |
| `POST` | `/camps` | `locationId`, `from`, `to`, `period`, `cost` required; organization comes from the location; dates stored at 11:00 UTC; `400 DEPOSIT_TOO_HIGH`, `400 INVALID_DATES` |
| `PATCH` | `/camps/{id}` | Partial. A price change applies to every registration that is not fully paid. Status `CANCELED` does **not** cancel registrations. `409 HAS_REGISTRATIONS` when moving to another organization. No delete |
| `PATCH` | `/registrations/{id}` | `status` (label only: no credit, no mail), `campId` (same organization; `409 DUPLICATE_REGISTRATION`, `409 ORGANIZATION_MISMATCH`), `price` (custom amount, `null` clears), `gadgets`, `tshirtSize` |
| `PATCH` | `/settings` | Partial; the settings document must already exist |
| `PATCH` | `/users/{id}` | See below |

## B4. Staff-only and login-only routes

| Method | Path | Who | Description |
|---|---|---|---|
| `GET` | `/users` | staff | Search: `firstName`, `lastName`, `email`, `postcode`, `role`, `q`, `ids`, `sort`. Like the old admin, managers can list all users |
| `GET` | `/users/export` | staff | `text/csv` marketing export; same filters as the list |
| `GET` | `/users/{id}` | staff | The user plus `students` and `organizations` |
| `PATCH` | `/users/{id}` | ADMIN | Names, emails, `telephone`, `address`, `credit` (absolute), `role` (`ADMIN`/`MANAGER`/`null`), `organizationIds`. `409 MANAGER_NEEDS_ORGANIZATION`, `409 CANNOT_DEMOTE_SELF`. Users cannot be created or deleted |
| `GET` | `/camps/{id}/registrations/export` | staff | Camp attendance list, `text/csv`, `;` separated (same columns as the old download). Includes canceled/refunded registrations |
| `POST` | `/uploads/logo` | ADMIN | Upload a location logo: JSON `{ name, dataUri }` (base64 PNG or SVG, max 90 KB). Type is checked on the content; SVGs with scripts, event handlers or external references are refused (`400 UNSAFE_SVG`). Returns `201 { uri, name }`: send that object as `logo` to `POST`/`PATCH /locations`, which only accepts URLs from our S3 bucket. `502 UPLOAD_FAILED` / `UPLOAD_NOT_CONFIGURED` |
| `GET` | `/places/autocomplete?q=` | any logged-in user | Google Places proxy → `[{ placeId, description }]` |
| `GET` | `/places/{placeId}` | any logged-in user | → address object (`502 PLACES_ERROR` / `PLACES_NOT_CONFIGURED` without `GOOGLE_PLACES_API_KEY`) |

## B5. Mapping from the old admin

| Old admin call | Now |
|---|---|
| `allOrganizations`, `Organization`, `create/updateOrganization` | `GET /organizations`, `GET /organizations/{id}`, `POST`, `PATCH` |
| `allLocations`, `Location`, `create/updateLocation` | `GET /locations`, `GET /locations/{id}`, `POST`, `PATCH` |
| `allCamps`, `Camp`, `create/updateCamp` | `GET /camps`, `GET /camps/{id}`, `POST`, `PATCH` |
| `GET /api/camp_registrations/:id`, camp CSV button | `GET /camps/{id}/registrations`, `…/registrations/export` |
| `allRegistrations`, `Registration`, `updateRegistration` | `GET /registrations`, `GET /registrations/{id}`, `PATCH /registrations/{id}` |
| `updateRegistration(adminCancel)` | `POST /registrations/{id}/cancel` as ADMIN |
| `allUsers`, `User`, `updateUser`, `GET /api/users/export` | `GET /users`, `GET /users/{id}`, `PATCH /users/{id}`, `GET /users/export` |
| `allStudents`, `Student`, `updateStudent` | `GET /students`, `GET /students/{id}`, `PATCH /students/{id}` |
| `Settings`, `updateSettings` | `GET /settings`, `PATCH /settings` |
| `currentUser` + organization switcher | `GET /me` |
| `/api/places/*` | `/places/*` |
| `createLocation(logo: Upload)` / `updateLocation(logo)` | `POST /uploads/logo`, then `logo: { uri, name }` on `POST`/`PATCH /locations` |

## B6. Conventions that differ for staff

- Errors added: `403 FORBIDDEN`, `409 PATH_TAKEN`, `HAS_CAMPS`, `HAS_REGISTRATIONS`, `DUPLICATE_REGISTRATION`,
  `ORGANIZATION_MISMATCH`, `NOT_CANCELLABLE`, `MANAGER_NEEDS_ORGANIZATION`, `CANNOT_DEMOTE_SELF`,
  `400 DEPOSIT_TOO_HIGH`, `INVALID_DATES`, `502 PLACES_ERROR`.
- Every write logs an `activity` row (topic only), like the old admin.
- Lists set `X-Total-Count` and take `page`, `perPage`, `sort`, `order`.

## B7. Known gaps vs. the old admin

- **Dashboard** has no dedicated endpoint; build it from the list routes and `X-Total-Count`.
- Orders have no admin resource; search registrations by `orderId`.
