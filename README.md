# Spooner House — Gap Offer Bot

Runs every evening at 7:00 PM Eastern and proactively fills single-night gaps across all upcoming reservations — up to 30 days out. For every 1-night gap between consecutive bookings, it messages both the outgoing guest (extend your stay) and the incoming guest (arrive a night early), each at a 20% discount. A last-minute layer also catches any same-night vacancies that weren't already handled.

## How it works

1. Fetches all properties from Hospitable
2. For each property, fetches all reservations over the next 90 days and finds consecutive pairs with exactly one vacant night between them
3. For each gap, sends two warm personal messages at 20% off — one to the outgoing guest offering to extend, one to the incoming guest offering to arrive early; both include a `%guest_portal%` link so guests can take action directly in the Hospitable portal
4. As a last-minute layer, checks tomorrow's checkouts — any room not already handled by the gap scan gets a last-minute extension offer with a `%SmartUpsell%` link for early/late checkout options
5. Logs a full summary of every gap found, every message sent, and any rooms that were already occupied

Claude uses the [Hospitable MCP server](https://mcp.hospitable.com/mcp) to read reservations, check calendars, and send messages — all in a single agentic loop.

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

Set `DRY_RUN=true` in your environment to run the full workflow every evening without sending any messages. Claude will still fetch all properties, find checkouts, and check calendars — but instead of calling the send-message tool it will write out exactly what it would have sent. Check the Railway logs each morning to verify the logic looks right.

When you're satisfied after a week or two, go to Railway → **Variables**, delete `DRY_RUN` (or set it to `false`), and the bot goes live on the next 7 PM run.

---

## Deploying to Railway

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
3. Railway will detect the `Procfile` and deploy a **worker** (no web port needed)

### 3. Set environment variables in Railway

In your Railway project → **Variables** tab, add:

```
ANTHROPIC_API_KEY=sk-ant-...
HOSPITABLE_API_TOKEN=your_hospitable_token
```

### 4. Verify it's running

Railway's **Logs** tab will show timestamped output like:

```
[2025-05-08T23:00:00.000Z] Cron fired — starting vacancy offer workflow …
[2025-05-08T23:00:01.123Z] API call #1 …
[2025-05-08T23:00:12.345Z] Stop reason: end_turn  |  tokens in: 3241  out: 891
[2025-05-08T23:00:12.346Z] ─── Workflow summary ───────────────────────────────────────────
Gaps found (90-day scan):
  May 12 — The Oak Room: gap night between Chen checkout (May 12) and Patel check-in (May 13)
    → Outgoing offer sent to Sarah & Tom Chen ✓
    → Incoming offer sent to Raj Patel ✓
  May 19 — The Garden Suite: gap night between Lopez checkout (May 19) and Kim check-in (May 20)
    → Outgoing offer sent to Maria Lopez ✓
    → Incoming offer sent to Jin Kim ✓
Last-minute layer (tomorrow May 9):
  The Birch Room — already booked tomorrow, no offer sent
[2025-05-08T23:00:12.347Z] Vacancy offer workflow completed successfully.
```

### 5. Force a manual run on Railway

In the Railway dashboard → **Deploy** tab → click the **Run** button, or use the Railway CLI:

```bash
railway run node index.js --run-now
```

---

## Scheduling notes

The cron expression `0 19 * * *` fires at exactly **7:00 PM** in the `America/New_York` timezone (Eastern — handles EST/EDT automatically). Railway runs the worker process continuously, so the cron job inside Node fires on time.

---

## Model

The bot uses `claude-sonnet-4-20250514`. To upgrade to the latest Sonnet release, change the `model` field in `index.js` to `claude-sonnet-4-6`.

---

## Troubleshooting

| Error | Fix |
|---|---|
| `HTTP 401` | Verify `ANTHROPIC_API_KEY` and `HOSPITABLE_API_TOKEN` are set correctly |
| `HTTP 400` with MCP error | Check that the `mcp-client-2025-04-04` beta header is still current — Anthropic occasionally updates beta identifiers |
| Offers sent to guests in wrong timezone | The "tomorrow" calculation uses UTC midnight; review `getTomorrow()` if your guests' checkouts span midnight in your local time |
| Workflow hits iteration limit | Increase `MAX_ITERATIONS` in `index.js` (default: 30) |
