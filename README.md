# Postlet ![Version](https://img.shields.io/badge/version-0.3.0-indigo)

Self-hosted, single-owner email client and AI-agent mail gateway running on **Cloudflare Workers** and **Resend** — designed to deploy directly from a synced GitHub repository and run comfortably inside Cloudflare's Free Tier.

## Features

- **Full-Featured Web Inbox** (`/`): Clean, responsive 3-pane UI with folder navigation, search (SQLite FTS5), sandboxed sanitized HTML email viewing, plain-text fallback, R2 attachment uploads/downloads, Rich Text (Bold, Italic, Underline, Strikethrough, Code, Headings, Lists, Blockquotes, Links), Markdown, and Plain Text composer, saved draft editing/discarding, Reply / Reply All / Forward, optional Resend open & link tracking checkbox, and live delivery + engagement status tracking (`sent`, `delivered`, `delayed`, `bounced`, `complained`, `email.opened`, `email.clicked`).
- **Catch-All & Address Manager**: Accept mail for `*@yourdomain.com` via Resend inbound webhooks, configure sender aliases in **Settings → Addresses & Domain**, and filter inbox threads per address.
- **Cloudflare Zero Trust Access Authentication**: Protects the Web UI and `/api/admin/*` with cryptographic RS256 JWKS verification of `Cf-Access-Jwt-Assertion` tokens.
- **Built-In Cloudflare Workers AI Agent (`postlet-ai`)** *(Disabled by default)*: Uses your native Cloudflare `AI` binding (10,000 free Neurons/day). Toggle on in **Settings → AI Agent** to unlock:
  - **Auto-Triage & Cached Thread Summaries**: Priority (`high`/`normal`/`low`) and category classification cached in D1.
  - **Daily Inbox Summary (To-Dos & Reminders)**: Scheduled via hourly Worker Cron trigger at your chosen hour/timezone (or run on-demand) with interactive To-Do checklists and optional email delivery.
  - **Important Email Auto-Reply**: Drafts (Pending Approval) or sends automatic replies to urgent human emails with strict RFC 3834 loop protection (`Auto-Submitted`, `List-Unsubscribe`, `noreply@`, own-domain block, and per-sender cooldown).
- **AI Agent Gateway (`/mcp` & `/api/v1/*`)**: Issue scoped API keys (`read_only`, `read_draft`, `read_write`) with optional alias locks, recipient domain allowlists, hourly rate limits, allowed built-in AI functions, one-click MCP/cURL snippets, and a unified Audit Log.

---

## Architecture & Free-Tier Optimization

- **Single Worker + Static Assets**: Built with Vite + `@cloudflare/vite-plugin` (`run_worker_first: ["/api/*", "/mcp"]` so UI assets serve directly at the edge).
- **Cloudflare D1**: Stores threads, messages, FTS5 search index, hashed API keys, settings, AI digests, and audit logs using targeted composite indexes to minimize row reads.
- **Cloudflare R2**: Streams attachment uploads/downloads directly and serves downloads with `Cache-Control: private, max-age=31536000, immutable` to minimize Class B reads.
- **Cloudflare Workers AI**: Caches summaries/triage in D1 and enforces a configurable daily call cap (`50/day` default) to stay safely inside the 10,000 free Neurons/day allowance.

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Copy local environment templates
cp .env.example .env
cp .dev.vars.example .dev.vars

# 3. Apply D1 migrations locally
npm run db:migrate:local

# 4. Start Vite dev server (runs frontend + Worker with local Miniflare D1/R2)
npm run dev
```

Run checks and tests:

```bash
npm run typecheck
npm test
npm run build
```

---

## Deployment via GitHub → Cloudflare Workers Git Sync

### 1. Automatic D1 & R2 Provisioning (Zero Manual DB Setup)
`wrangler.jsonc` uses **Wrangler Automatic Resource Provisioning** (no `database_id` hardcoded in Git):
- On first deployment, Cloudflare automatically creates the `postlet-db` D1 database and `postlet-attachments` R2 bucket and binds them to `DB` and `ATTACHMENTS` (and reuses them automatically on all future deploys).
- On first Worker execution (HTTP request or scheduled Cron), Postlet's runtime schema bootstrapper automatically creates any missing D1 tables, FTS5 search indexes, triggers, and safe default settings (`ai_enabled = 'false'`).

#### Two One-Time Cloudflare Dashboard Prerequisites
Before your first Git-triggered deploy:
1. **Enable R2 Object Storage**: Open **Cloudflare Dashboard → R2 Object Storage** and activate R2 once on your account (10 GB/month Free Tier).
2. **Grant `D1: Edit` to Workers Builds**: In **Cloudflare Dashboard → My Profile → API Tokens**, edit the Workers Builds API token and add **Account → D1 → Edit** (Cloudflare's default auto-generated build token omits `D1: Edit`, which is needed to auto-create `postlet-db` and apply migrations).

### 2. Connect GitHub Repo in Cloudflare Dashboard
1. Open **Cloudflare Dashboard → Workers & Pages → Create → Import a repository**.
2. Select your Postlet GitHub repository.
3. Set:
   - **Build command**: `npm run build`
   - **Deploy command**:
     - Zero-config option (schema self-bootstraps at runtime): `npx wrangler deploy`
     - Or with formal `d1_migrations` tracking: `npm run deploy:ci` (runs `wrangler deploy` to provision `postlet-db` first, then applies `migrations/` remotely)
4. Attach your custom domain under **Worker → Settings → Domains & Routes → Add → Custom Domain** (e.g., `mail.yourdomain.com`).
5. After first deploy, verify your Worker bindings under **Settings → Bindings**:
   - `DB` → D1 database `postlet-db`
   - `ATTACHMENTS` → R2 bucket `postlet-attachments`
   - `AI` → Workers AI

### 3. Configure Environment Variables & Secrets on Cloudflare Dashboard
Open **Worker → Settings → Variables and Secrets** and add the 5 variables below.

**Should they be `Text` or `Secret`?**
To your running Worker code (`env.VARIABLE`), **`Text` and `Secret` behave identically**. The difference is purely about security and convenience in the Cloudflare Dashboard:
- **Always use `Secret`** for actual credentials (`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`). Secrets are encrypted at rest and hidden permanently after saving.
- **`Text` or `Secret` both work** for non-secret config values (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `MAIL_DOMAIN`). Choosing `Text` lets you view and double-check them later in the Dashboard; choosing `Secret` masks them if you prefer not to leave config values readable in Dashboard screens.
- **Safe across GitHub deploys**: `wrangler.jsonc` sets `"keep_vars": true`, so any `Text` variables you configure in the Cloudflare Dashboard are preserved across future GitHub pushes instead of being overwritten by `wrangler deploy`.
- **Managed automatically**: `APP_NAME`, `APP_VERSION`, and `DEFAULT_AI_MODEL` are already configured in `wrangler.jsonc` — do not duplicate them in the Dashboard.
- **Production safety**: Do **not** set `DEV_BYPASS_ACCESS` in production.

| Name | Recommended Type | Example / Where to Find It | Purpose |
|---|---|---|---|
| `RESEND_API_KEY` | **Secret** *(Required)* | `re_...` from Resend Dashboard → API Keys | Resend API key with **Sending** + **Receiving** permissions. Never store as `Text`. |
| `RESEND_WEBHOOK_SECRET` | **Secret** *(Required)* | `whsec_...` from Resend Dashboard → Webhooks | Svix signing secret used to verify every inbound webhook cryptographically. Never store as `Text`. |
| `CF_ACCESS_TEAM_DOMAIN` | **Text** or **Secret** *(Required)* | `myteam.cloudflareaccess.com` (from Zero Trust → Settings) | Your Zero Trust team domain (`https://` optional; normalized automatically). |
| `CF_ACCESS_AUD` | **Text** or **Secret** *(Required)* | 64-char hex AUD tag on your main Access App | Application Audience (AUD) tag used to verify the user's Access JWT signature and audience. |
| `MAIL_DOMAIN` | **Text** or **Secret** *(Recommended)* | `mail.yourdomain.com` | Verified Resend sending/receiving domain used as fallback before configuring in Web UI Settings. |

### 4. Configure Cloudflare Zero Trust Access

Cloudflare Access is an interactive browser login gate (redirecting unauthenticated requests to an OTP / SSO login page). Postlet uses **path-scoped Access applications** so human Web UI routes stay locked behind your email login while non-browser machine endpoints (`/api/webhooks/resend`, `/api/v1/*`, `/mcp`) can present their own cryptographic credentials directly.

> **Important:** Never add a `Bypass` policy to your root `mail.yourdomain.com` application — that would bypass Access for the entire Web UI. Always place Bypass or Service Auth policies on **separate Self-hosted applications scoped to specific sub-paths**. Cloudflare Access evaluates only the most specific matching path for a request, so `/` and `/api/admin/*` remain strictly protected.

#### 4a. Main Application (Protects Web UI `/` and `/api/admin/*`)
1. Go to **Cloudflare Zero Trust → Access controls → Applications → Add an application → Self-hosted**.
2. Set:
   - **Application domain**: `mail.yourdomain.com` (leave **Path** blank so it covers `/` and `/api/admin/*`).
3. Add an **Allow** policy:
   - **Action**: `Allow`
   - **Rule type**: `Include`
   - **Selector**: `Emails`
   - **Value**: your personal email address (e.g., `you@example.com`)
4. Save the application, then copy its **Application Audience (AUD) Tag** into `CF_ACCESS_AUD` (and confirm your team domain `<team>.cloudflareaccess.com` under **Zero Trust → Settings** for `CF_ACCESS_TEAM_DOMAIN`).

#### 4b. Non-Browser Machine Endpoints (Sub-Path Applications & Selector)
Create separate **Self-hosted** applications for the specific machine paths you need. For standard **Bypass** rules:
- **Action**: `Bypass`
- **Rule type**: `Include`
- **Selector**: `Everyone` *(Value: Everyone — Bypass disables interactive SSO/email challenges, so identity selectors like `Emails` are not used here.)*

Only create the sub-path apps you actually use:

| Sub-Path Application Domain | Policy | Required? | Why Needed |
|---|---|---|---|
| `mail.yourdomain.com/api/webhooks/resend` | `Bypass` → Include → `Everyone` | **Required** | Resend delivers inbound emails & delivery status webhooks here without a browser session. |
| `mail.yourdomain.com/api/v1/*` | `Bypass` → Include → `Everyone` *(or `Service Auth`)* | **Only if using REST API / scripts** | Lets external scripts/services (e.g. Uptimeflare) call Postlet REST APIs; `/*` covers all sub-routes. |
| `mail.yourdomain.com/mcp` | `Bypass` → Include → `Everyone` *(or `Service Auth`)* | **Only if using external MCP AI agents** | Lets Claude, Cursor, Antigravity, etc. connect via Streamable HTTP MCP. |
| `mail.yourdomain.com/api/health` | `Bypass` → Include → `Everyone` | **Optional** | Only needed if an external uptime monitor probes `/api/health` without Access auth. |

#### 4c. Why Bypass on These Paths Is Still Secure (Defense-in-Depth)
Setting a sub-path to **Bypass** disables Cloudflare's browser login redirect *only on that exact path* — the Worker still enforces strict application-layer authentication before exposing any mailbox data:

| Path | Cloudflare Access Gate | Worker-Side Cryptographic Security |
|---|---|---|
| `/` & `/api/admin/*` | **Allow (`Emails`)** — **Never bypassed** | Re-verifies the `Cf-Access-Jwt-Assertion` RS256 signature against Cloudflare's JWKS keys (`iss`, `aud`, `exp`) on every `/api/admin/*` call, plus CSRF header/Origin validation on mutations. |
| `/api/webhooks/resend` | **Bypass (`Everyone`)** | Verifies Svix **HMAC-SHA256** (`svix-id`, `svix-timestamp`, `svix-signature`) using `RESEND_WEBHOOK_SECRET` with constant-time comparison and a ±5-minute replay window. Unsigned or forged requests receive `401`. |
| `/api/v1/*` & `/mcp` | **Bypass** *(or `Service Auth`)* | Requires a scoped **`Authorization: Bearer plt_...`** API key (stored as SHA-256 hash in D1) enforcing tier (`read_only` / `read_draft` / `read_write`), optional alias locks, recipient-domain allowlists, hourly rate limits, instant revocation, and full audit logging. Missing/invalid tokens receive `401`. *(Exception: `GET /api/v1/openapi.json` is an intentional public API schema descriptor returning no mailbox data, and `GET /api/health` returns only `{ ok, service, version }`.)* |

#### 4d. Optional Extra Hardening (Locking Down Beyond `Bypass → Everyone`)
If you want defense at Cloudflare's edge *in addition to* Worker authentication:
1. **Minimize exposed paths**: Only create sub-path applications for endpoints you actually use — start with **only** `/api/webhooks/resend`, and omit `/api/health`, `/api/v1/*`, and `/mcp` until needed.
2. **Use `Service Auth` + Service Tokens for `/api/v1/*` and `/mcp`**:
   - Create a Service Token under **Zero Trust → Access controls → Service Auth → Service Tokens** (`CF-Access-Client-Id` & `CF-Access-Client-Secret`).
   - On the `/api/v1/*` (and/or `/mcp`) Access app, replace `Bypass` with **Action**: `Service Auth` | **Rule type**: `Include` | **Selector**: `Service Token` (select your token).
   - Clients must now pass **both** the Cloudflare Service Token headers at the edge **and** Postlet's `Authorization: Bearer plt_...` key inside the Worker (and Access logs every request). *Note: check whether your MCP client supports custom request headers alongside `Authorization` before enabling `Service Auth` on `/mcp`.*
   - Alternatively, if your AI agent or service runs from a fixed static IP, keep **Action**: `Bypass` but change **Selector** from `Everyone` to **IP ranges**.
3. **Resend Webhook (`/api/webhooks/resend`) edge filtering**: Resend does not attach custom Cloudflare Service Token headers and delivers via Svix IPs that can change over time, so **Bypass + Svix HMAC-SHA256 verification** is the standard pattern. You can optionally layer a **Cloudflare WAF Custom Rule** on `/api/webhooks/resend` requiring a `POST` method and a non-empty `svix-signature` header alongside Rate Limiting.

### 5. Configure Resend Domain & Webhooks
1. In **Resend Dashboard → Domains**, add and verify DNS records (SPF, DKIM, and Receiving MX record) for your domain.
2. In **Resend Dashboard → Webhooks**, add an endpoint pointing to:
   `https://mail.yourdomain.com/api/webhooks/resend`
3. Subscribe to events:
   - `email.received`
   - `email.sent`
   - `email.delivered`
   - `email.delivery_delayed`
   - `email.bounced`
   - `email.complained`
   - `email.opened` *(optional, when using Resend Open Tracking)*
   - `email.clicked` *(optional, when using Resend Click Tracking)*
4. Copy the Signing Secret (`whsec_...`) into Cloudflare Worker Secret `RESEND_WEBHOOK_SECRET`.

### 6. First Login & Optional AI Activation
1. Visit `https://mail.yourdomain.com` and sign in via Cloudflare Zero Trust.
2. Open **Settings → Addresses & Domain** to add your default sender address (e.g., `me@yourdomain.com`).
3. *(Optional)* Open **Settings → AI Agent (Cloudflare AI)** to toggle on the built-in Cloudflare AI agent, Daily Inbox Summaries (To-Dos & Reminders), and Important Email Auto-Reply.
4. Open **Settings → Agent Keys & MCP** to generate `read_only`, `read_draft`, or `read_write` tokens with ready-to-copy MCP JSON and `curl` snippets.
