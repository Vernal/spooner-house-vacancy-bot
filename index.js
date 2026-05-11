import Anthropic from '@anthropic-ai/sdk';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DRY_RUN = process.env.DRY_RUN === 'true';

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getToday() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

function getTomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

function getDaysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

// ─── MCP Client ──────────────────────────────────────────────────────────────
// Implements the Streamable HTTP MCP transport used by mcp.hospitable.com.
// Each call POSTs a JSON-RPC 2.0 request and handles either a plain JSON
// response or a text/event-stream (SSE) response.

const MCP_URL = 'https://mcp.hospitable.com/mcp';

async function mcpRequest(method, params = {}) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${process.env.HOSPITABLE_API_TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${method}-${Date.now()}`,
      method,
      params,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MCP HTTP ${res.status}: ${body}`);
  }

  const contentType = res.headers.get('content-type') ?? '';

  if (contentType.includes('text/event-stream')) {
    // Parse SSE stream — find the first data line that contains a result
    const text = await res.text();
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const parsed = JSON.parse(line.slice(6));
        if (parsed.error) throw new Error(`MCP error: ${JSON.stringify(parsed.error)}`);
        if (parsed.result !== undefined) return parsed.result;
      } catch (e) {
        if (e.message.startsWith('MCP error:')) throw e;
        // skip non-JSON data lines (comments, pings, etc.)
      }
    }
    throw new Error('No result found in MCP SSE stream');
  }

  const data = await res.json();
  if (data.error) throw new Error(`MCP error: ${JSON.stringify(data.error)}`);
  return data.result;
}

// Convert MCP tool list → Anthropic custom tool definitions
async function getHospitableTools() {
  const result = await mcpRequest('tools/list');
  return (result.tools ?? []).map(tool => ({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
  }));
}

// Execute a single MCP tool call and return the text result
async function callHospitableTool(name, input) {
  log(`  → MCP: ${name}  ${JSON.stringify(input).slice(0, 160)}`);
  const result = await mcpRequest('tools/call', { name, arguments: input });
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .map(c => (c.type === 'text' ? c.text : JSON.stringify(c)))
    .join('\n') || 'Done.';
}

// ─── API helpers ─────────────────────────────────────────────────────────────

// Wraps client.messages.create with retry logic for 429 rate-limit errors.
// Waits 65 s per attempt (slightly more than Anthropic's 1-minute window).
async function createMessageWithRetry(params, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (err) {
      if (err instanceof Anthropic.APIError && err.status === 429 && attempt < maxRetries) {
        const waitSec = 65 * (attempt + 1); // 65 s, 130 s, 195 s
        log(`Rate limit (429) — waiting ${waitSec}s before retry ${attempt + 1}/${maxRetries} …`);
        await new Promise(resolve => setTimeout(resolve, waitSec * 1000));
        continue;
      }
      throw err;
    }
  }
}

// ─── Workflow ─────────────────────────────────────────────────────────────────

async function runVacancyOfferWorkflow() {
  const today    = getToday();
  const tomorrow = getTomorrow();
  const horizon  = getDaysFromNow(30); // 30-day window keeps context manageable

  log('================================================================');
  log('  Spooner House — Evening Gap-Offer Workflow');
  log(`  Today: ${today}  |  Scanning gaps through: ${horizon} (30 days)`);
  log(`  Last-minute layer: ${tomorrow}`);
  if (DRY_RUN) log('  ⚠️  DRY RUN — no messages will be sent');
  log('================================================================');

  // Pull only the tools this workflow actually needs.
  // Passing all 48 Hospitable tool schemas on every API call is the single
  // biggest driver of token cost — this cuts it by ~85%.
  const NEEDED_TOOLS = new Set([
    'get-properties',
    'get-reservations',
    'get-reservation',
    'get-property-calendar',
    'send-reservation-message',
  ]);

  log('Fetching Hospitable MCP tools …');
  const allTools = await getHospitableTools();
  const workflowTools = allTools.filter(t => NEEDED_TOOLS.has(t.name));
  log(`Using ${workflowTools.length}/${allTools.length} tool(s): ${workflowTools.map(t => t.name).join(', ')}`);

  // In dry-run mode, strip the send tool so Claude literally cannot call it.
  const tools = DRY_RUN
    ? workflowTools.filter(t => t.name !== 'send-reservation-message')
    : workflowTools;

  if (DRY_RUN) {
    log('DRY RUN: blocked send-reservation-message');
  }

  const systemPrompt = `You are the hospitality assistant for Spooner House, a warm and welcoming bed \
and breakfast. You genuinely care about every guest. When writing messages to guests, write with real \
warmth — as if you personally know them and are delighted they chose Spooner House.`;

  const userPrompt = `Please complete the following gap-offer workflow for Spooner House B&B:

**Step 1 — Get properties**
Fetch all properties/rooms from Hospitable.

**Step 2 — 90-day gap scan**
For EACH property, fetch all reservations with check-in dates between ${today} and ${horizon}. \
Sort them by check-in date. Identify every consecutive pair (A, B) where reservation A's \
checkout_date is exactly one night before reservation B's check_in_date — meaning there is \
exactly one vacant night between them.

Build a gap list: { property, gapNight, outgoingReservation (A), incomingReservation (B) }

**Step 3 — ${DRY_RUN ? 'Preview two-sided offers (DRY RUN — do NOT send anything)' : 'Send two-sided offers for every gap'}**
For each gap found in Step 2, ${DRY_RUN
  ? `write out the exact messages you WOULD send, but do not call any send or message tool. \
Output the full message text for both guests so they can be reviewed.`
  : `send two messages:`}

  a) Message reservation A's guest (outgoing): a warm offer to extend their stay one more night \
(the gap night) at 20% off their current nightly rate. Include the shortcode %guest_portal% as \
a clickable link so they can easily take action through the Spooner House guest portal.

  b) Message reservation B's guest (incoming): a warm offer to arrive one night early (the gap \
night) at 20% off their current nightly rate. Include the shortcode %guest_portal% as a clickable \
link so they can easily take action through the Spooner House guest portal.

Only ever offer the guest their exact same room — never suggest a different property.

**Step 4 — Last-minute layer (tomorrow's checkouts)**
Find all reservations checking out on ${tomorrow}. For each one:
- If that reservation was ALREADY messaged in Step 3 (it was the outgoing side of a detected gap), \
skip it — the guest has already been contacted.
- Otherwise, check that property's Hospitable calendar for ${tomorrow}. If the night is vacant, \
${DRY_RUN
  ? `write out the last-minute message you WOULD send but do not call any send tool.`
  : `send a last-minute extension offer.`} Include the shortcode %SmartUpsell% in the message \
so the guest can self-serve early check-out, a late check-out, or an extra night directly through \
the Hospitable guest portal.

**Message guidelines (all messages)**
Every message must:
- Feel warm and genuine — never automated or templated
- Be a short and simple as possible while still being warm
- State clearly: one extra night, 20% off their current nightly rate
- Be written as casual and person-to-person, avoiding sales and marketing speech like "low offer", "for just", "limited time", "peacful", "lovely opportunity"
- Invite the guest to reply if they are interested, do not send them to the guest portal
- Invite them to reply if interested
- Outgoing guests: frame as "extend your stay a little bit more"
- Incoming guests: frame as "we have an unexpected night avaialable if you want to come early"

**Step 5 — Summary log**
${DRY_RUN ? '**THIS WAS A DRY RUN — no messages were sent**\n\n' : ''}\
Provide a clear summary:
- All gaps found (property, gap night, outgoing guest name, incoming guest name)
- For each gap: the two messages ${DRY_RUN ? 'that WOULD have been sent' : 'sent'} (outgoing + incoming)
- Last-minute results: sent / skipped-already-handled / room-occupied — one line per checkout
- Any errors or unexpected results`;

  const messages = [{ role: 'user', content: userPrompt }];
  let iteration = 0;
  const MAX_ITERATIONS = 30;

  try {
    while (iteration < MAX_ITERATIONS) {
      iteration++;
      log(`API call #${iteration} …`);

      const response = await createMessageWithRetry({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        tools,
        messages,
      });

      const { input_tokens: i = '?', output_tokens: o = '?' } = response.usage ?? {};
      log(`Stop reason: ${response.stop_reason}  |  tokens in: ${i}  out: ${o}`);

      // Always append the full assistant turn before looping
      messages.push({ role: 'assistant', content: response.content });

      // ── Done ─────────────────────────────────────────────────────────────
      if (response.stop_reason === 'end_turn') {
        for (const block of response.content) {
          if (block.type === 'text') {
            log('\n─── Workflow summary ───────────────────────────────────────────');
            console.log(block.text);
            log('────────────────────────────────────────────────────────────────');
          }
        }
        log('Vacancy offer workflow completed successfully.');
        return;
      }

      // ── Tool calls ───────────────────────────────────────────────────────
      if (response.stop_reason === 'tool_use') {
        const toolResults = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          let content;
          try {
            content = await callHospitableTool(block.name, block.input);
          } catch (err) {
            content = `Error calling ${block.name}: ${err.message}`;
            log(`  Tool error: ${err.message}`);
          }
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
        }
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      log(`WARNING: Unexpected stop reason "${response.stop_reason}" — stopping loop`);
      break;
    }

    if (iteration >= MAX_ITERATIONS) {
      log('WARNING: Reached maximum iteration limit. Workflow may be incomplete.');
    }
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      log(`API Error  HTTP ${error.status}: ${error.message}`);
      if (error.status === 401) log('Hint: Check ANTHROPIC_API_KEY.');
      if (error.status === 400) log('Hint: Check model ID and request shape.');
    } else {
      log(`Error: ${error.message}`);
    }
    throw error;
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

cron.schedule(
  '0 19 * * *',
  () => {
    log('Cron fired — starting vacancy offer workflow …');
    runVacancyOfferWorkflow().catch(err => log(`Workflow failed: ${err.message}`));
  },
  { timezone: 'America/New_York' },
);

log('Spooner House vacancy bot is running.');
log('Scheduled: daily at 7:00 PM Eastern (America/New_York).');

// ─── Manual run ──────────────────────────────────────────────────────────────

if (process.argv.includes('--run-now') || process.env.RUN_NOW === 'true') {
  log(process.env.RUN_NOW === 'true'
    ? 'RUN_NOW env var detected — executing workflow immediately …'
    : '--run-now flag detected — executing workflow immediately …'
  );
  runVacancyOfferWorkflow().catch(err => {
    log(`Workflow failed: ${err.message}`);
    process.exit(1);
  });
}
