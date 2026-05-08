# Spooner House — Vacancy Offer Bot

Runs every evening at 7:00 PM Eastern and automatically offers guests who check out tomorrow the chance to extend their stay one more night at a discount — but only if their room is actually vacant the next day.

## How it works

1. Asks Claude to fetch all properties from Hospitable
2. Claude finds reservations checking out tomorrow
3. For each checkout, Claude checks the Hospitable calendar to see if that room is empty tomorrow night
4. If vacant, Claude sends the current guest a warm, personal message with the extension offer
5. Logs a summary of who was messaged and which rooms were already booked

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
[2025-05-08T23:00:04.567Z] Stop reason: end_turn  |  tokens in: 1842  out: 612
[2025-05-08T23:00:04.568Z] ─── Workflow summary ───────────────────────────────────────────
Room 2 (The Oak Room) — Sarah & Tom Chen: offer sent ✓
Room 3 (The Garden Suite) — already booked tomorrow, no offer sent
[2025-05-08T23:00:04.569Z] Vacancy offer workflow completed successfully.
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
| Workflow hits iteration limit | Increase `MAX_ITERATIONS` in `index.js` (default: 15) |
