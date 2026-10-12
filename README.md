# sb-ecomm-starter

A Windows-friendly Shop platform design with MVP monorepo for a storefront, BFF, and commerce API.

## Components
 
- `backend/`: Spring Boot 4 commerce API (Java 25, with Kotlin 2.3 interop), Spring Security, JDBC, PostgreSQL and Flyway.
- `bff/`: Node.js 22 and Fastify reverse proxy with request IDs, rate limiting and private Prometheus metrics.
- `frontend/`: Angular 22 storefront with NgRx 22 cart state, Vitest unit tests and the esbuild/Vite toolchain. Angular was upgraded from the original version 17 target after the CI dependency scan found multiple high-severity advisories in the unsupported version line.
- `compose.devtools.yml`: PostgreSQL, Redis, MongoDB, Kafka, pgAdmin, SonarQube, Prometheus, Grafana and an opt-in Trivy scanner.
- `compose.application.yml`: API, BFF and Nginx-hosted Angular application.

## Service language choices

Use the language that best fits each service and its team; avoid mixing languages inside a service without a concrete benefit:

| Service | Default language | Practical rationale |
| --- | --- | --- |
| `backend/` Spring Boot commerce API | Java 25 | The API is Java-centric, has a broad and evolving commerce domain, and relies on Spring/JVM libraries. Modern Java keeps implementation productive and low-risk; use virtual threads for suitable blocking I/O rather than choosing another language solely for concurrency. |
| Kotlin within `backend/` | Kotlin 2.3 only where justified | Choose Kotlin for a backend component when the team is comfortable with it and concise code, null safety, or coroutine-based asynchronous work provides a clear advantage. Keep Java as the default for domain and integration code, and preserve straightforward Java/Kotlin interoperability. |
| `bff/` Fastify reverse proxy | JavaScript on Node.js 22 | Fits the existing Fastify service and its lightweight HTTP-proxy role; use the established runtime and libraries rather than adding a second backend stack. |
| `frontend/` Angular storefront | TypeScript | Aligns with Angular's typed component, template, and tooling ecosystem. |

## Run on Windows / Docker Desktop

From PowerShell in this directory:

1. Create the local environment file (Compose reads `.env` from the current directory):

   ```powershell
   if (-not (Test-Path .env)) { Copy-Item .env.example .env }
   ```

   If `.env` already exists, keep it and check that these required values are present and non-empty: `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `MONGO_ROOT_PASSWORD`, `PGADMIN_PASSWORD`, and `GRAFANA_ADMIN_PASSWORD`. The example values are for local development only; replace them as appropriate and keep `.env` out of source control.
2. Start the local development stack from this directory:

   ```powershell
   docker compose -f compose.devtools.yml up -d --wait
   if ($?) { docker compose -f compose.application.yml up --build -d --wait }
   ```

   The infrastructure stack must be healthy before starting the API, BFF, and frontend. Open `http://localhost:4200`. The API health endpoint is `http://localhost:8081/actuator/health` (management port, loopback-bound by default).
3. Stop the app and infrastructure with `docker compose -f compose.application.yml down` and `docker compose -f compose.devtools.yml down`.

Start pgAdmin and SonarQube only when needed: `docker compose -f compose.devtools.yml --profile tools up -d`.

The infrastructure stack owns the `shop-platform` Docker network; start it before the application stack. Local development ports and credentials are controlled by `.env`. Mailpit captures identity email at `http://localhost:8025`. pgAdmin is available at `http://localhost:5050`, SonarQube at `http://localhost:9000`, and Kafka/PostgreSQL/Redis/MongoDB ports are documented in the compose file.

To run the Trivy filesystem scan: `docker compose -f compose.devtools.yml --profile scan run --rm trivy`.

## PostgreSQL disaster recovery

`compose.dr.yml` is an opt-in overlay for a PostgreSQL 17 physical hot standby. It does not change the default single-database development stack. Configure a unique `POSTGRES_REPLICATION_PASSWORD` in `.env` (use a random hexadecimal value so it is safe in PostgreSQL's password file), then enable the replica with:

```powershell
docker compose -f compose.devtools.yml -f compose.dr.yml up -d --wait postgres
.\scripts\dr-failover.ps1 -NoApplicationSwitch -ConfirmFailover
```

The script is a controlled failover drill: it provisions the replication role/slot, waits until the standby is synchronous, commits a probe, fences the primary, promotes the standby, and verifies the acknowledged probe and a new write. It intentionally leaves the former primary stopped. For an isolated rehearsal, use a separate Compose project and network, then remove only that rehearsal's named volumes when finished:

```powershell
$env:DR_NETWORK_NAME = 'shop-dr-rehearsal'
.\scripts\dr-failover.ps1 -ProjectName shop-dr-rehearsal -NoApplicationSwitch -ConfirmFailover
docker compose -p shop-dr-rehearsal -f compose.devtools.yml -f compose.dr.yml down --volumes
Remove-Item Env:DR_NETWORK_NAME
```

The drill reports **RPO 0 for acknowledged commits** after it verifies the primary reports the standby as `streaming|sync`; PostgreSQL waits for the standby to flush WAL. This guarantee depends on the standby remaining available, and writes block if it is lost. The local **end-to-end RTO target is 300 seconds**, including API readiness when application switching is enabled. The isolated Docker validation completed database promotion and API readiness in 27.8 seconds; this measures one local run and is not a production guarantee. To cut over the local API as part of a planned operator-approved incident, run the script without `-NoApplicationSwitch`; it stops the old primary, updates `DATABASE_HOST=postgres-dr` in `.env`, recreates the API, and waits for readiness. Never start or reattach the old primary after promotion: it may be divergent. Rebuild/reseed it as a standby from the promoted primary before any failback.

The DR overlay is for local verification, not a cross-region deployment template. A production Azure PostgreSQL Flexible Server geo-replica is asynchronous, so use a business-approved non-zero RPO, monitor replica lag, and test forced promotion plus application cutover in the target subscription. The Azure deployment currently accepts an externally provisioned PostgreSQL JDBC endpoint; it does not provision a regional replica, backup/PITR policy, traffic switch, or automatic failover. Replication is not a substitute for backups because deletes and corruption replicate too. Production RPO/RTO remain unvalidated until backup-restore and real regional failover exercises have been completed.

## Integration tests, CI and observability

Run the full-stack identity, waiting-room admission, customer/guest checkout idempotency, ownership, short-link lifecycle, SEO discovery and metrics smoke test from PowerShell after starting the devtools and application Compose stacks:

```powershell
node tests/e2e/p0-smoke.mjs
```

The script uses BFF `http://localhost:3000`, management `http://localhost:8081`, and Mailpit `http://localhost:8025` by default; override `API_BASE_URL`, `MANAGEMENT_BASE_URL`, or `MAILPIT_BASE_URL` if using alternate host ports. CI runs this smoke test against ephemeral Compose services alongside backend Maven tests, BFF tests, Angular tests/production build, Trivy dependency/configuration scanning, and CodeQL analysis.

## Persistence, cache, events and local performance baseline

Active product list and detail reads use a 30-second Redis JSON cache (`CATALOG_CACHE_TTL` is configurable); cache read/write/serialization errors are metered and logged while catalog reads fall back to PostgreSQL. The order transaction inserts an `OrderPlaced.v1` JSON event into `event_outbox` in the same commit as the order, items, stock reservation and idempotency result. A leased, `SKIP LOCKED` publisher sends pending events to `shop.order-events.v1` in Kafka with idempotent producer settings, retries using bounded exponential backoff, and provides at-least-once delivery (consumers must deduplicate by `eventId`). PostgreSQL pagination/query indexes and batch product lookup are applied by Flyway migration V3.

The local reference workload is **1 catalog request/second for 60 seconds** against the API, with p95 <= 250 ms and error rate <= 1%; this is a reproducible development baseline, not a production capacity claim or an agreed business SLO. Run after starting devtools and the application:

```powershell
$env:API_BASE_URL = 'http://localhost:18080'
$env:PERF_RPS = '1'
$env:PERF_DURATION_SECONDS = '60'
node tests/performance/catalog-load.mjs
```

Latest local run: **60/60 requests**, 0 failures, p50 **13.02 ms**, p95 **26.23 ms**, and p99 **52.94 ms**. A rolled-back 10,000-row order-history diagnostic used `orders_customer_created_id_idx` with an index-only scan (20 rows, 0.147 ms execution time). Both measurements are specific to the current host/container setup and are not production capacity claims.

Tune RPS only after adjusting per-subject/API and BFF rate-limit policies for the agreed target. Results include p50/p95/p99 and failures; record host/container resource settings alongside results before using them for capacity planning.

## Storefront experience, waiting room, discovery and links

The NgRx cart is restored from browser `localStorage` and persisted after cart changes. It is device-local convenience data, not an authoritative price, stock, identity, or order record; access/refresh tokens are not written there.

Registration and anonymous guest checkout use separate FIFO waiting rooms backed by Redis sorted sets and atomic Lua admission. Queue tickets are UUIDs, positions are polled every three seconds, the queue is capped, and admitted tickets expire after a configurable lease. `/api/v1/auth/register` and guest-token `/api/v1/orders` requests require an active `X-Waiting-Room-Ticket`; the API validates that ticket rather than trusting the browser. Authenticated customer checkouts skip the guest checkout queue. Set `WAITING_ROOM_REGISTRATION_CAPACITY`, `WAITING_ROOM_CHECKOUT_CAPACITY`, `WAITING_ROOM_MAXIMUM_QUEUED_TICKETS`, and `WAITING_ROOM_ADMISSION_LEASE` to fit a tested database/email throughput budget. Redis failure remains fail-closed.

Product routes (`/products/{id}`) set canonical/Open Graph metadata and `Product` JSON-LD; the storefront publishes FAQ markup with `FAQPage` JSON-LD. `/robots.txt` and `/sitemap.xml` are served from the API using active catalog records. Metadata is updated by the Angular client, not server-rendered; crawlers that do not execute JavaScript will not see per-product metadata yet.

Signed-in customers can create a short link from a product card; service clients must be explicitly granted the `short-links:write` scope. Guest tokens and catalog-read scopes cannot create links. Links resolve only to an active product on the configured storefront origin, default to a 30-day expiry (allowed range 60 seconds–365 days), and can be revoked by their creator with `DELETE /api/v1/short-links/{code}`. Redirects are temporary and `no-store`; aggregate create/redirect/revocation metrics avoid per-link metric cardinality.

Nginx gives fingerprinted frontend assets a one-year immutable cache lifetime and keeps the application shell/API/short-link redirects uncached. Azure Front Door Premium is configured as the CDN endpoint with HTTPS redirect, compression, Microsoft managed WAF and Bot Manager rules. The Front Door origin is an externally reachable Container App in this template; restrict origin bypass (for example, private origin connectivity or an approved Front Door-only ingress control) before production traffic.

## Azure deployment

`.github/workflows/deploy-azure.yml` is a manual build-and-deploy workflow. It builds the three images into an existing ACR, then deploys `infra/azure/main.bicep`: Container Apps, a log-analytics workspace, a user-assigned API identity with Key Vault secret-read access, a separate ACR-pull identity, and Front Door Premium/CDN/WAF.

Before running it:

1. Provision a TLS-enabled PostgreSQL database, TLS Redis, Kafka-compatible broker/topic (`shop.order-events.v1`), and SMTP service. Their DNS/network paths must be reachable from Azure Container Apps. This template intentionally does not create those billable/data-bearing services.
2. Create an ACR in the selected resource group. The GitHub OIDC principal needs permission to build/push images, deploy resources, and create the template's ACR-pull and Key Vault role assignments (for example, Contributor plus narrowly scoped role-assignment rights).
3. In GitHub, create a protected `production` environment and configure OIDC federation for `repo:<owner>/<repo>:environment:production`. Add repository/environment variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`. Add secrets `SHOP_DATABASE_URL` (JDBC URL with `sslmode=require`, no credentials), `SHOP_DATABASE_USERNAME`, `SHOP_DATABASE_PASSWORD`, `SHOP_REDIS_HOST`, `SHOP_REDIS_PASSWORD`, `SHOP_BFF_REDIS_URL` (`rediss://`), `SHOP_JWT_SECRET`, `SHOP_KAFKA_BOOTSTRAP_SERVERS`, `SHOP_KAFKA_SASL_JAAS_CONFIG`, `SHOP_MAIL_HOST`, `SHOP_MAIL_PASSWORD`; optionally configure `SHOP_API_CLIENTS_JSON` and `SHOP_MAIL_USERNAME`. Variables can override `SHOP_REDIS_PORT`, Kafka security/mechanism, SMTP port/auth/TLS/from address, and extra allowed origins.
4. Run **Actions → Deploy to Azure** and select the existing resource group, location, ACR, and resource prefix. The deployment outputs the Front Door URL.

The Bicep template compiled successfully with the official Bicep compiler. No Azure subscription credentials are available in this workspace, so cloud provisioning, managed-identity access, external-service connectivity and cost/scale behavior have not been exercised here. Front Door Premium and WAF incur Azure charges; review the target-region pricing before deploying. Configure a custom domain/certificate and origin lockdown before production.

Prometheus and Grafana are opt-in. Kafka must also be running for order event publication. Start the infrastructure stack first, then run:

```powershell
docker compose -f compose.devtools.yml --profile observability up -d prometheus grafana
```

Prometheus is at `http://localhost:9090`; Grafana is at `http://localhost:3001` (credentials from `.env`, defaults only in `.env.example`). The BFF's private scrape endpoint is loopback-mapped to `http://localhost:13001/metrics`; it is served on a separate container port from public BFF traffic. The provisioned dashboard charts API/BFF request rates, p95 latency, 5xx ratio and process memory. Prometheus evaluates availability and API 5xx alerts. API Actuator and BFF metrics endpoints are intended for monitoring-network access only; their local host ports bind to loopback and must not be exposed through a production ingress. Set up a production alert receiver, retention, access control and an external log/trace backend before relying on these local defaults.

## API quick start

### Local test identities

The local stack does not seed human customer accounts. Use these sample identities to exercise each supported account type; all sample credentials are for local development only.

| Account type | Sample / setup | What to test |
| --- | --- | --- |
| Anonymous shopper | No sign-in. Open `http://localhost:4200`; the storefront obtains an anonymous token automatically. | Browse the catalog and add products to the cart. |
| Guest shopper | At checkout, enter `guest@example.local` (or another test email); no password or customer registration is needed. This is an order-contact email, not a guest login or customer account. | Complete checkout as a guest. To view the guest profile or order history later, request an email code from the guest-history section in the storefront and enter the code from Mailpit. |
| Customer | In the storefront, choose **สมัครสมาชิก** and register `customer@example.local` with a test password such as `EverydayTest!2026`. Check Mailpit at `http://localhost:8025`, enter the email verification token in the storefront, then log in. | Verify email, sign in to view/update the customer display name and order history, place customer orders, and create/revoke product share links. Register the sample email only once; use another email if it is already registered. |
| Mobile service client | Client ID `local-mobile-app`; sample secret `change-me-local-mobile-secret`; scopes `catalog:read orders:read orders:write`. | Call catalog and order APIs with a client-credentials token. |
| Read-only partner client | Client ID `sample-third-party`; sample secret `change-me-local-third-party-secret`; scope `catalog:read`. | Read the catalog; order APIs are not granted to this client. |

The two service-client examples come from `.env.example`. If `API_CLIENTS_JSON` in your `.env` has been changed, use the matching client ID, secret, and scopes from that configuration instead. To request a sample partner token in PowerShell:

```powershell
$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes('sample-third-party:change-me-local-third-party-secret'))
$partnerToken = (Invoke-RestMethod -Method Post -Uri http://localhost:4200/api/v1/oauth/token `
  -Headers @{ Authorization = "Basic $basic" } `
  -ContentType 'application/x-www-form-urlencoded' `
  -Body @{ grant_type = 'client_credentials'; scope = 'catalog:read' }).accessToken
Invoke-RestMethod -Uri http://localhost:4200/api/v1/products `
  -Headers @{ Authorization = "Bearer $partnerToken" }
```

Never reuse the example client secrets or sample customer password outside a local development environment.

Public catalog reads require a bearer token. Issue an anonymous token:

```powershell
$anonymous = (Invoke-RestMethod -Method Post -Uri http://localhost:4200/api/v1/auth/anonymous `
  -ContentType 'application/json' -Body '{}').accessToken
Invoke-RestMethod -Uri http://localhost:4200/api/v1/products `
  -Headers @{ Authorization = "Bearer $anonymous" }
```

Guest checkout requires email verification. Request an OTP with `POST /api/v1/guest-access/checkout/request` (`email`), read it from the guest checkout verification message in Mailpit, and exchange it with `POST /api/v1/guest-access/checkout/verify` (`email`, `token`). Use the returned bearer token with `POST /api/v1/orders`, an admitted checkout waiting-room ticket, and a unique `Idempotency-Key` header (16-128 characters). Reuse the same key for retries of the exact same order body. Guest checkout codes are one-use and expire after 10 minutes; `POST /api/v1/auth/guest` is no longer available.

Registering a customer starts with `POST /api/v1/auth/register` (`email`, `password`, minimum 12 characters). Open Mailpit, copy the one-time token and POST it to `/api/v1/auth/verify-email`. Then use `/api/v1/auth/login`; access tokens last 15 minutes and refresh tokens rotate on `/api/v1/auth/refresh`. Revoke refresh sessions with `/api/v1/auth/logout`. Forgot/reset password use `/api/v1/auth/password/forgot` and `/api/v1/auth/password/reset`; tokens are one-use and expire after 30 minutes.

Customer profile data is available to the signed-in account at `GET /api/v1/profile`; update the display name with `PUT /api/v1/profile` and a `displayName` field. `GET /api/v1/orders/history` returns that account's order history and item snapshots. Guest history is protected separately: request a one-time code with `POST /api/v1/guest-access/request` and an email that has guest orders, then exchange the code with `POST /api/v1/guest-access/verify`. Use the returned short-lived bearer token for `GET`/`PUT /api/v1/profile` and `GET /api/v1/orders/history`. The response to the code request does not reveal whether orders exist; in local development, retrieve the email from Mailpit. Checkout OTP tokens allow order creation only and cannot read profiles or order history.

Configured mobile and partner clients use OAuth client credentials (`POST /api/v1/oauth/token`, Basic client authentication, `grant_type=client_credentials`, requested `scope`). Client IDs, secrets and allow-listed scopes are configured in `API_CLIENTS_JSON`; the example defines a mobile client and a catalog-read-only partner client. Never use the sample values outside local development.

Create an order body:

```json
{
  "items": [
    { "productId": "11111111-1111-4111-8111-111111111111", "quantity": 1 }
  ]
}
```

Before registration or guest checkout, join the matching waiting room with a client-generated UUID:

```powershell
$flow = 'registration' # Use 'checkout' for an anonymous order
$ticketId = [guid]::NewGuid().ToString()
$ticket = Invoke-RestMethod -Method Post `
  -Uri "http://localhost:4200/api/v1/waiting-room/$flow/tickets" `
  -ContentType 'application/json' -Body (@{ ticketId = $ticketId } | ConvertTo-Json)
while ($ticket.state -eq 'queued') {
  Start-Sleep -Seconds $ticket.retryAfterSeconds
  $ticket = Invoke-RestMethod `
    -Uri "http://localhost:4200/api/v1/waiting-room/$flow/tickets/$ticketId"
}
$waitingHeaders = @{ 'X-Waiting-Room-Ticket' = $ticketId }
```

Include `$waitingHeaders` on `POST /api/v1/auth/register`, or on guest-token `POST /api/v1/orders` together with the bearer token and idempotency key. The storefront handles ticket polling and these headers automatically. Customer-token order requests do not require a checkout ticket.

## Local development and tests

- API: install JDK 25 and Maven 3.9+, then run `mvn test` in `backend`.
- BFF: install Node.js 22, then run `npm ci` and `npm test` in `bff`.
- Frontend: install Node.js 22.22.3+, then run `npm ci`, `npm run test:ci`, and `npm run build` in `frontend`. Vitest runs tests in jsdom and does not require Chrome. Run individual BFF-backed flows with `npm run test:customer-registration`, `npm run test:customer-verification`, `npm run test:customer-login`, `npm run test:customer-full-flow`, `npm run test:customer-cart-checkout`, `npm run test:customer-order-history`, `npm run test:guest-cart-checkout`, or `npm run test:guest-order-history`. The customer full-flow test includes registration, verification, login, customer checkout and history, and guest checkout and verified history. Run all BFF-backed frontend integration tests with `npm run test:integration`. These tests start a real local BFF process and use an in-process backend contract harness, so they do not require Docker, PostgreSQL, or Mailpit.

The API uses environment-backed properties for local development. For any non-local `APP_ENV`, `AZURE_KEYVAULT_URL` is required and the API loads `database-password`, `jwt-secret`, `redis-password`, `mail-password`, and `api-clients-json` using Azure `DefaultAzureCredential` (Managed Identity in Azure). During JWT/client-secret rotation, put the outgoing values in optional `jwt-previous-secret` and `api-clients-json-previous`, deploy the new active secrets, wait beyond token expiry, then remove the previous values. Grant the workload identity only Key Vault secret-read access. `.env.example` and Mailpit are local development facilities, not production secret management or email delivery.

## Scope and architecture notes

The API now supports local customer registration with email verification, password login/reset, rotating refresh sessions, guest/anonymous/customer JWTs, and multiple configured client-credential identities with scoped access. API and BFF rate limits use shared Redis counters; the BFF additionally limits requests per IP/token or email. Order creation is transactional, inventory is reserved atomically, idempotency keys replay the original response for the same body and reject conflicting reuse, and customers can only read orders under their own token subject.

This remains a development foundation rather than a production certification. The single configured storefront client list is deployment configuration, not a self-service client-registration/consent system. Production must still configure HTTPS at a trusted ingress, lock down direct API/BFF exposure and forwarded-header trust, populate Azure Key Vault and a real SMTP provider, validate operational rate limits, and run security/load tests. Payments, fulfillment, MFA, customer-session revocation of already-issued access JWTs (bounded by the 15-minute expiry), and AES-encrypted payload envelopes are not implemented. Local synchronous PostgreSQL replication and a controlled failover drill are available through the opt-in Compose overlay; regional Azure replication, backup/restore validation, production RPO/RTO evidence, and automatic traffic failover remain outstanding. Kafka is integrated for order events; MongoDB remains provisioned without a defined business use case.

The local Compose P0 smoke check has exercised registration/email verification, login, refresh rotation and old-token rejection, logout, password reset, and rejection of the old password. Checkout replayed the original order for the same idempotency key/body, returned `409` when that key was reused with a different body, and hid an order from another authenticated customer. Both API and BFF Redis limits returned `429` at their configured thresholds. These checks do not replace automated integration/concurrency tests or a Redis-outage test.

Audit/request logs carry the request ID, timestamp, session ID, remote/forwarded address metadata, authorization presence (never the token), environment, app name, pod name, level and thread. Never put credentials or full bearer values into logs. Forwarded headers must only be trusted behind a correctly configured proxy.
