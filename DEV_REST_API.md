# Client REST API specification

A REST equivalent of everything the **client** front-end (`/client`) needs from the server.
Scope: only endpoints reachable from the public booking flow. All admin/manager-only
functionality (camp/location/organization CRUD, user administration, settings mutations,
CSV exports, admin registration lists, Google Places proxy) is deliberately excluded.

**NOTE: this is a REST API design based on the current implementation, it might change when implemented.**

---

## 1. Conventions

| Topic | Rule |
|---|---|
| Base path | `/api/v1` |
| Format | JSON request and response bodies (`Content-Type: application/json`) |
| IDs | Mongo ObjectId strings, exposed as `id` (never `_id`) |
| Dates | ISO-8601 UTC strings (`2026-07-06T11:00:00.000Z`). `Student.dob` stays a plain string, as today |
| Money | Numbers in EUR, 2 decimals |
| Auth | Session cookie (`express-session` + passport). Send `credentials: 'include'` cross-origin. A token/JWT variant is a drop-in replacement — the endpoint list does not change |
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

### Important behavioural note

Today **every list endpoint is implicitly scoped to the logged-in user**: a non-admin only
ever sees their own students, registrations and orders. The REST API must keep that —
ownership filtering happens server-side, never via a client-supplied `userId`.

---

## 2. Authentication & account

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/register` | public | Create account and log in |
| `POST` | `/api/auth/login` | public | Email + password login |
| `POST` | `/api/auth/logout` | user | Destroy session |
| `GET` | `/api/auth/me` | public | Current user or `null` |
| `POST` | `/api/auth/password/forgot` | public | Send reset mail |
| `POST` | `/api/auth/password/reset` | public | Set new password using token, logs in |
| `GET` | `/api/auth/google` | public | Start Google OAuth (browser redirect) |
| `GET` | `/api/auth/google/callback` | public | OAuth callback |
| `GET` | `/api/auth/facebook` | public | Start Facebook OAuth (browser redirect) |
| `GET` | `/api/auth/facebook/callback` | public | OAuth callback |

**`POST /api/auth/register`**

```json
{
  "email": "jan@example.com",
  "password": "secret123",
  "repeatPassword": "secret123",
  "agreeToTerms": ["agrees"]
}
```

`201` → the `User` object (session established). `409` when the email already exists —
the current implementation redirects to `/register?failed=true`; REST should return
`{ "error": { "code": "EMAIL_TAKEN" } }`. Registration triggers the `register` welcome mail.

**`POST /api/auth/login`** → `{ "email": "...", "password": "..." }`, `200` → `User`, `401` on bad credentials.

**`POST /api/auth/password/forgot`** → `{ "email": "..." }`. Always `204` (do not leak whether
the account exists). Generates `resetToken` and mails `BASE_URL/wachtwoord-vergeten/<token>`.

**`POST /api/auth/password/reset`** → `{ "token": "...", "password": "..." }`. `200` → `User`
(session established, token cleared), `400` on unknown/expired token.

**OAuth note:** the two OAuth entry points stay full browser redirects; they cannot be
fetch/XHR calls. After the callback the server redirects to the client root with a session
cookie set, and the new client should then call `GET /api/auth/me`.

---

## 3. Current user

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/me` | user | Current user profile (alias of `/api/auth/me`) |
| `PATCH` | `/api/me` | user | Update own profile |

`PATCH` body — only these fields are writable by the client (server-side whitelist, as in
`updateCurrentUser`):

```json
{
  "firstName": "Jan",
  "lastName": "Peeters",
  "email": "jan@example.com",
  "secondEmail": "",
  "telephone": ["0470123456"],
  "address": { "postcode": "2000", "streetAddress": "", "city": "", "district": "",
               "province": "", "formatted": "", "lat": 0, "lng": 0, "placeId": "" }
}
```

`role`, `credit`, `organizationIds` and `resetToken` are **not** client-writable.

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
| `GET` | `/api/students` | user | Own students |
| `POST` | `/api/students` | user | Create (caller becomes owner) |
| `GET` | `/api/students/{id}` | owner | Single student |
| `PATCH` | `/api/students/{id}` | owner | Update |
| `DELETE` | `/api/students/{id}` | owner | Delete → `204` |

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
| `GET` | `/api/locations` | public | All visible locations |
| `GET` | `/api/locations/{id}` | public | By id |
| `GET` | `/api/locations/by-path/{path}` | public | By slug — used for `/{locationPath}` routes |
| `GET` | `/api/locations/{id}/camps` | public | Camps at this location |

`GET /api/locations` query parameters: `visibility=VISIBLE` (client default), `organizationId`,
`q` (text search), `page`, `perPage`, `sort`, `order`.

`GET /api/locations/{id}/camps` query parameters: `year`, `excludePast=true`, `period`.
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
| `GET` | `/api/camps` | public | List / filter camps |
| `GET` | `/api/camps/{id}` | public | Single camp |
| `GET` | `/api/camps/available` | public | Bookable subset of a list of ids — cart revalidation |

`GET /api/camps` query parameters: `locationId`, `organizationId`, `period`, `year`,
`excludePast=true`, `ids=a,b,c`, `q`, `page`, `perPage`, `sort`, `order`.

`GET /api/camps/available?ids=a,b,c` returns only camps with `status = OPEN` **and**
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
| `GET` | `/api/camps/{id}/available-students` | user | Own students who can still be booked into this camp |
| `GET` | `/api/camps/{id}/registered-students` | user | Own students already registered (status open, payment_pending, confirmed or deposited) |
| `GET` | `/api/camps/{id}/registrations` | user | Own registrations for this camp |

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
4. **Re-validate on load** via `GET /api/camps/available?ids=…` and `GET /api/students`,
   dropping items whose camp or student has disappeared.
5. Totals shown in the cart are `sum(costDetail.total)` and `sum(costDetail.depositTotal)`.

---

## 8. Orders

An "order" is a group of registrations sharing an `orderId` (format `YYYYMMDD-######`).

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/orders` | user | Checkout: create registrations, optionally start payment |
| `GET` | `/api/orders` | user | Own orders |
| `GET` | `/api/orders/{orderId}` | user | Single order |
| `POST` | `/api/orders/{orderId}/payment` | user | (Re)start payment for an outstanding order |

`GET /api/orders` query parameters: `outstanding=true` returns only orders with status
`open` or `deposited` for camps that have not ended yet — that is the banner on the
dashboard.

**`POST /api/orders`** (replaces the `createOrder` mutation):

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

Behaviour to preserve:
- `409` if a non-cancelled registration already exists for that student/camp pair.
- `409` if the registrations span more than one organization.
- Store credit is applied first; if credit covers the whole amount, `payUrl` is `null` and
  the registrations are marked paid immediately.
- A confirmation mail (`orderConfirmed`) and the conversion webhook fire on success.
- `tracking` is the optional attribution blob collected client-side (UTM params, `gclid`,
  `wbraid`, `gbraid`, `fbclid`, `fbp`, `fbc`, `landing_page`, `referrer`, `device_type`,
  `first_source`, `last_source`, `browser_simple`, `session_id`).
- When `payUrl` is returned the client redirects the browser to it. Mollie returns the user
  to `BASE_URL/bestellingen/{orderId}`, so that route must exist in the new client.

**`POST /api/orders/{orderId}/payment`** (replaces `payOrder`) returns the same
`{ order, payUrl, credit }` shape for an order that is still open or deposit-only.

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
| `GET` | `/api/registrations` | user | Own registrations |
| `GET` | `/api/registrations/{id}` | owner | Single registration |
| `POST` | `/api/registrations/{id}/cancel` | owner | Cancel, refunding to store credit |

`GET /api/registrations` query parameters: `campId`, `studentId`, `status`, `orderId`,
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

`canCancel` is server-computed: `true` only for `open`, `confirmed` and `deposited`, and
only while the camp start is further away than `Settings.cancelDays`. The client must use
this flag rather than deriving it.

**`POST /api/registrations/{id}/cancel`** → `200`:

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
| `GET` | `/api/organizations/{id}` | public | By id — used at checkout to show whose terms apply |
| `GET` | `/api/organizations/by-path/{path}` | public | By slug |
| `GET` | `/api/terms` | public | Global terms HTML |
| `GET` | `/api/organizations/{path}/terms` | public | Organization-specific terms HTML |
| `GET` | `/api/settings` | public | Public settings subset |

The client routes `/algemene_voorwaarden` and `/algemene_voorwaarden_{path}` map onto the
two terms endpoints; both return raw HTML inside `{ "terms": "<html>" }`.

Organization object: `{ "id": "…", "name": "…", "path": "v", "url": "https://shop.voetbalstages.be/v" }`.

`GET /api/settings` must expose only what the public site needs — currently
`{ "earlyBirdToInc": "2026-05-01T00:00:00.000Z" }`. Deposit/cancel/force-pay day counts stay
server-side; their effect is already baked into `costDetail` and `canCancel`.

---

## 11. Payments (not called by the client)

Listed for completeness because the checkout flow depends on it:

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/payments/webhook` | Mollie | Payment status callback; flips registrations to `confirmed`/`deposited` |

The client never calls this. It only redirects to `payUrl` and later lands on
`/bestellingen/{orderId}`, where it re-fetches the order. Because the webhook may not have
arrived yet, that page should tolerate a still-`payment_pending` order and re-poll.

---

## 12. Endpoint summary

```
POST   /api/auth/register
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me
POST   /api/auth/password/forgot
POST   /api/auth/password/reset
GET    /api/auth/google            (+ /callback)
GET    /api/auth/facebook          (+ /callback)

GET    /api/me
PATCH  /api/me

GET    /api/students
POST   /api/students
GET    /api/students/{id}
PATCH  /api/students/{id}
DELETE /api/students/{id}

GET    /api/locations
GET    /api/locations/{id}
GET    /api/locations/by-path/{path}
GET    /api/locations/{id}/camps

GET    /api/camps
GET    /api/camps/available
GET    /api/camps/{id}
GET    /api/camps/{id}/available-students
GET    /api/camps/{id}/registered-students
GET    /api/camps/{id}/registrations

POST   /api/orders
GET    /api/orders
GET    /api/orders/{id}
POST   /api/orders/{id}/payment

GET    /api/registrations
GET    /api/registrations/{id}
POST   /api/registrations/{id}/cancel

GET    /api/organizations/{id}
GET    /api/organizations/by-path/{path}
GET    /api/organizations/{path}/terms
GET    /api/terms
GET    /api/settings

POST   /api/payments/webhook       (Mollie only)
```
