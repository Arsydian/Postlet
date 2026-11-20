# Postlet ![Version](https://img.shields.io/badge/version-0.1.2-indigo)

Self-hosted, single-owner email client and AI-agent mail gateway running on **Cloudflare Workers** and **Resend** — designed to deploy directly from a synced GitHub repository and run comfortably inside Cloudflare's Free Tier.

## Features

- **Full-Featured Web Inbox** (`/`): Clean, responsive 3-pane UI with folder navigation, search (SQLite FTS5), sandboxed sanitized HTML email viewing, plain-text fallback, R2 attachment uploads/downloads, Markdown/HTML composer, Reply / Reply All / Forward, and live delivery status tracking (`sent`, `delivered`, `delayed`, `bounced`, `complained`).
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
4. After first deploy, verify your Worker bindings under **Settings → Bindings**:
   - `DB` → D1 database `postlet-db`
   - `ATTACHMENTS` → R2 bucket `postlet-attachments`
   - `AI` → Workers AI

### 3. Configure Secrets on Cloudflare Dashboard
In **Worker → Settings → Variables and Secrets**, add the following **Secrets** (do **not** set `DEV_BYPASS_ACCESS` in production):

| Name | Description |
|---|---|
| `RESEND_API_KEY` | Resend API key with Sending + Receiving permissions |
| `RESEND_WEBHOOK_SECRET` | Resend webhook signing secret (`whsec_...`) |
| `CF_ACCESS_TEAM_DOMAIN` | Your Zero Trust team domain (e.g., `myteam.cloudflareaccess.com`) |
| `CF_ACCESS_AUD` | Application Audience (AUD) tag from Cloudflare Access |
| `MAIL_DOMAIN` | Your verified Resend domain (e.g., `mail.yourdomain.com`) |

### 4. Configure Cloudflare Zero Trust Access
1. In **Cloudflare Zero Trust → Access → Applications → Add an application → Self-hosted**, protect your Worker domain (e.g., `mail.yourdomain.com`) with an **Allow** policy restricted to your email address.
2. Copy the generated **Application Audience (AUD) Tag** into `CF_ACCESS_AUD`.
3. Create **Bypass** Access applications/policies for the non-browser machine endpoints so Resend webhooks and external AI agents can reach them with their own cryptographic auth (`svix-signature` / `Bearer plt_...`):
   - `mail.yourdomain.com/api/webhooks/resend` → Action: **Bypass** (Everyone)
   - `mail.yourdomain.com/api/v1/*` → Action: **Bypass** (Everyone)
   - `mail.yourdomain.com/mcp` → Action: **Bypass** (Everyone)
   - `mail.yourdomain.com/api/health` → Action: **Bypass** (Everyone)

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
4. Copy the Signing Secret (`whsec_...`) into Cloudflare Worker Secret `RESEND_WEBHOOK_SECRET`.

### 6. First Login & Optional AI Activation
1. Visit `https://mail.yourdomain.com` and sign in via Cloudflare Zero Trust.
2. Open **Settings → Addresses & Domain** to add your default sender address (e.g., `me@yourdomain.com`).
3. *(Optional)* Open **Settings → AI Agent (Cloudflare AI)** to toggle on the built-in Cloudflare AI agent, Daily Inbox Summaries (To-Dos & Reminders), and Important Email Auto-Reply.
4. Open **Settings → Agent Keys & MCP** to generate `read_only`, `read_draft`, or `read_write` tokens with ready-to-copy MCP JSON and `curl` snippets.
