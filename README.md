# Spooner House — Gap Offer Bot

Runs every evening and proactively fills single-night gaps across all upcoming reservations — up to 30 days out. For every 1-night gap between consecutive bookings, it messages both the outgoing guest (extend your stay) and the incoming guest (arrive a night early), each at 20% off. A last-minute layer also catches any same-night vacancies not already handled.

## How it works

1. Fetches all properties from Hospitable
2. For each property, fetches all reservations over the next 30 days and finds consecutive pairs with exactly one vacant night between them
3. For each gap, sends two warm personal messages at 20% off — one to the outgoing guest offering to extend, one to the incoming guest offering to arrive early
4. As a last-minute layer, checks tomorrow's checkouts — any room not already handled by the gap scan gets a last-minute extension offer
5. Checks conversation history before sending — skips guests who already have an unreplied offer or have declined; sends a warm follow-up only if they showed interest
6. Applies a timing rule: extension offers only go to guests who have already been there at least one night (or are checking out tomorrow — their only window)

Claude uses the [Hospitable MCP server](https://mcp.hospitable.com/mcp) to read reservations, check calendars, and send messages across two agentic phases: data gathering (discarded after) and message sending (starts fresh with a compact summary). This keeps token usage low.

---

## Prerequisites

- Node.js 18 or later
- An [Anthropic API key](https://console.anthropic.com)
- A [Hospitable MCP Fallback Bearer token](https://my.hospitable.com/integrations/mcp)

### Environment variables

| Variable | Where to find it |
|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API Keys |
| `HOSPITABLE_API_TOKEN` | Hospitable → Settings → Integrations → MCP Fallback Bearer Tokens |

---

## Dry run / testing mode

Set `DRY_RUN=true` in your environment to run the full workflow without sending any messages. Claude will still fetch all properties, find gaps, and check calendars — but instead of calling the send-message tool it will write out exactly what it would have sent. Check the Railway logs after each run to verify the logic looks right.

When you're satisfied, go to Railway → **Variables**, delete `DRY_RUN` (or set it to `false`), and the bot goes live on the next scheduled run.

---

## Deploying to Railway

The bot is designed to run as a **Railway Cron service** — it spins up, runs the workflow, and shuts itself down. You only pay for the ~30 seconds it actually runs.

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
gh repo create spooner-house-vacancy-bot --private --push
```

> Make sure `.env` is in `.gitignore` — never commit real keys.

### 2. Create a new Railway project

1. Go to [railway.app](https://railway.app) and click **New Project**
2. Choose **Deploy from GitHub repo** and select your repo
3. In the service settings, set the service type to **Cron**
4. Railway will read the schedule from `railway.toml` (`0 23 * * *` UTC — approximately 7 PM Eastern)

### 3. Set environment variables in Railway

In your Railway project → **Variables** tab, add:

```
ANTHROPIC_API_KEY=sk-ant-...
HOSPITABLE_API_TOKEN=your_hospitable_token
```

### 4. Verify it's running

Railway's **Logs** tab will show timestamped output like:

```
[2025-05-11T23:00:01.123Z] Spooner House — Evening Gap-Offer Workflow
[2025-05-11T23:00:01.124Z] Today: 2025-05-11  |  Scanning gaps through: 2025-06-10 (30 days)
[2025-05-11T23:00:01.125Z] Fetching Hospitable MCP tools …

── Phase 1: Data gathering ──────────────────────────────────────────
[2025-05-11T23:00:02.001Z] [phase1] API call #1 …
[2025-05-11T23:00:05.312Z] [phase1] stop:tool_use  in:2847  out:312  cache_write:2103  cache_read:0
  → MCP: get-properties  {}
[2025-05-11T23:00:06.891Z] [phase1] API call #2 …
...
[2025-05-11T23:00:18.001Z] Phase 1 complete — gaps found: 1  last-minute: 0

── Phase 2: Message sending ─────────────────────────────────────────
[2025-05-11T23:00:18.002Z] [phase2] API call #1 …
[2025-05-11T23:00:22.441Z] [phase2] stop:end_turn  in:821  out:243  cache_write:612  cache_read:0

─── Workflow summary ────────────────────────────────────────────────
Gap night May 21 — Gates Room
  → Outgoing offer sent to Gabriela De Lima ✓
  → Incoming offer sent to Riccardo Gulia ✓
[2025-05-11T23:00:22.442Z] Vacancy offer workflow completed successfully.
```

### 5. Force a manual run

In the Railway dashboard → **Deploy** tab → click **Deploy**, or use the Railway CLI:

```bash
node index.js
```

---

## Scheduling notes

The schedule is defined in `railway.toml` as `0 23 * * *` UTC. This is approximately 7 PM Eastern — exactly 7 PM during EDT (summer) and 6 PM during EST (winter). For a once-a-night offer workflow the one-hour seasonal shift doesn't matter much. If you want to adjust it, edit `railway.toml`.

---

## Model

The bot uses `claude-sonnet-4-20250514`. To upgrade to the latest Sonnet release, change the `model` field in `index.js`.

---

## Troubleshooting

| Error | Fix |
|---|---|
| `HTTP 401` | Verify `ANTHROPIC_API_KEY` and `HOSPITABLE_API_TOKEN` are set correctly |
| Phase 1 returns no JSON | Check Railway logs for a raw Claude response — usually means the prompt hit an edge case; run with `DRY_RUN=true` to debug |
| Offers sent to wrong guests | Run with `DRY_RUN=true` and review the Phase 1 JSON output in the logs |
| Workflow hits iteration limit | Increase `maxIterations` in the `runAgenticLoop()` call inside `runVacancyOfferWorkflow()` (default: 20) |
