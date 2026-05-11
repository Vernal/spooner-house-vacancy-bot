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

// ─── Agentic loop ─────────────────────────────────────────────────────────────
// Reusable helper that runs one complete agentic loop.
// Applies prompt caching to the system prompt and tool schemas so they are not
// billed at full price on every subsequent call within the same phase.
// Returns the final text output from the end_turn response.

async function runAgenticLoop({ systemPrompt, userPrompt, tools, label, maxIterations = 20 }) {
  const messages = [{ role: 'user', content: userPrompt }];

  // Cache the system prompt — it is identical on every iteration
  const system = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];

  // Cache the tool schemas — mark the last tool so everything up to it is cached
  const cachedTools = tools.length === 0 ? [] : [
    ...tools.slice(0, -1),
    { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } },
  ];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    log(`[${label}] API call #${iteration} …`);

    const response = await createMessageWithRetry({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system,
      ...(cachedTools.length > 0 ? { tools: cachedTools } : {}),
      messages,
    });

    const {
      input_tokens: i = '?',
      output_tokens: o = '?',
      cache_creation_input_tokens: cw = 0,
      cache_read_input_tokens: cr = 0,
    } = response.usage ?? {};
    log(`[${label}] stop:${response.stop_reason}  in:${i}  out:${o}  cache_write:${cw}  cache_read:${cr}`);

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      return response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        let content;
        try {
          content = await callHospitableTool(block.name, block.input);
        } catch (err) {
          content = `Error calling ${block.name}: ${err.message}`;
          log(`[${label}] Tool error: ${err.message}`);
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    log(`[${label}] WARNING: Unexpected stop reason "${response.stop_reason}"`);
    break;
  }

  log(`[${label}] WARNING: Reached max iterations (${maxIterations}).`);
  return null;
}

// ─── JSON extraction ─────────────────────────────────────────────────────────
// Extracts JSON from Claude's output, handling optional ```json``` code fences.

function extractJSON(text) {
  if (!text) return null;
  // Handle ```json ... ``` or ``` ... ``` code blocks
  const block = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (block) { try { return JSON.parse(block[1]); } catch {} }
  // Try the whole string as-is
  try { return JSON.parse(text.trim()); } catch {}
  // Find the first {...} object in the string
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch {} }
  return null;
}

// ─── Workflow ─────────────────────────────────────────────────────────────────

async function runVacancyOfferWorkflow() {
  const today    = getToday();
  const tomorrow = getTomorrow();
  const horizon  = getDaysFromNow(30); // 30-day window keeps Phase 1 context manageable

  log('================================================================');
  log('  Spooner House — Evening Gap-Offer Workflow');
  log(`  Today: ${today}  |  Scanning gaps through: ${horizon} (30 days)`);
  log(`  Last-minute layer: ${tomorrow}`);
  if (DRY_RUN) log('  ⚠️  DRY RUN — no messages will be sent');
  log('================================================================');

  // Fetch tool schemas once; split into gather vs. send sets.
  // Keeping the lists small cuts per-call schema overhead by ~85% vs. all 48 tools.
  const GATHER_TOOL_NAMES = new Set([
    'get-properties',
    'get-reservations',
    'get-reservation',
    'get-property-calendar',
  ]);
  const SEND_TOOL_NAMES = new Set(['send-reservation-message']);

  log('Fetching Hospitable MCP tools …');
  const allTools     = await getHospitableTools();
  const gatherTools  = allTools.filter(t => GATHER_TOOL_NAMES.has(t.name));
  const sendTools    = allTools.filter(t => SEND_TOOL_NAMES.has(t.name));
  log(`Gather tools (${gatherTools.length}): ${gatherTools.map(t => t.name).join(', ')}`);
  log(`Send tools   (${sendTools.length}): ${sendTools.map(t => t.name).join(', ')}`);

  const systemPrompt =
    `You are the hospitality assistant for Spooner House, a warm and welcoming bed and breakfast. ` +
    `You genuinely care about every guest. When writing messages to guests, write with real warmth — ` +
    `as if you personally know them and are delighted they chose Spooner House.`;

  // ── Phase 1: Data gathering ───────────────────────────────────────────────
  // Claude fetches all reservation data, finds 1-night gaps, checks last-minute
  // calendars, and returns a COMPACT JSON summary. We then discard this entire
  // conversation; Phase 2 starts fresh with only the small JSON object.

  const phase1Prompt =
    `Gather opportunity data for Spooner House's nightly gap-offer workflow.\n\n` +

    `EFFICIENCY: The get-reservations response includes all the fields you need ` +
    `(guest name, check-in/out dates, nightly rate). Only call get-reservation for an ` +
    `individual reservation if a specific field is genuinely absent from the list response — ` +
    `minimise extra API calls.\n\n` +

    `**Step 1 — Get properties**\n` +
    `Fetch all properties.\n\n` +

    `**Step 2 — 30-day gap scan (${today} → ${horizon})**\n` +
    `Fetch ALL reservations across all properties for this window. Use per_page:100 to maximise ` +
    `results per call. IMPORTANT: check the response for pagination metadata — if there are more ` +
    `pages, keep fetching until you have every reservation. Missing even one reservation will cause ` +
    `a gap to go undetected.\n` +
    `Once you have the complete list, sort by check-in date per property. ` +
    `Find every consecutive pair (A, B) where A's checkout_date is exactly ` +
    `one night before B's check_in_date — meaning there is exactly one vacant night between them.\n\n` +

    `**Step 3 — Last-minute check (${tomorrow})**\n` +
    `For each property that has a checkout on ${tomorrow} AND is NOT already covered by a gap ` +
    `found in Step 2, check the property calendar for ${tomorrow}. If vacant, add to lastMinute.\n\n` +

    `Return ONLY the following JSON — no other text, no markdown fences, no explanation:\n` +
    `{\n` +
    `  "gaps": [\n` +
    `    {\n` +
    `      "gapNight": "YYYY-MM-DD",\n` +
    `      "propertyName": "string",\n` +
    `      "outgoing": { "reservationId": "string", "guestName": "string", "checkoutDate": "YYYY-MM-DD", "nightlyRate": 0 },\n` +
    `      "incoming": { "reservationId": "string", "guestName": "string", "checkinDate": "YYYY-MM-DD", "nightlyRate": 0 }\n` +
    `    }\n` +
    `  ],\n` +
    `  "lastMinute": [\n` +
    `    {\n` +
    `      "propertyName": "string",\n` +
    `      "outgoing": { "reservationId": "string", "guestName": "string", "checkoutDate": "YYYY-MM-DD", "nightlyRate": 0 }\n` +
    `    }\n` +
    `  ]\n` +
    `}\n` +
    `If there are no opportunities tonight, return exactly: {"gaps":[],"lastMinute":[]}`;

  log('\n── Phase 1: Data gathering ─────────────────────────────────────────');
  let phase1Output;
  try {
    phase1Output = await runAgenticLoop({
      systemPrompt,
      userPrompt: phase1Prompt,
      tools: gatherTools,
      label: 'phase1',
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      log(`API Error  HTTP ${err.status}: ${err.message}`);
      if (err.status === 401) log('Hint: Check ANTHROPIC_API_KEY.');
    } else {
      log(`Error: ${err.message}`);
    }
    throw err;
  }

  const gapData = extractJSON(phase1Output);
  if (!gapData) {
    log('ERROR: Phase 1 did not return parseable JSON. Aborting.');
    log('Raw Phase 1 output:');
    console.log(phase1Output);
    return;
  }

  const gapCount        = gapData.gaps?.length ?? 0;
  const lastMinuteCount = gapData.lastMinute?.length ?? 0;
  log(`Phase 1 complete — gaps found: ${gapCount}  last-minute: ${lastMinuteCount}`);

  if (gapCount + lastMinuteCount === 0) {
    log('No opportunities tonight — nothing to send. All done.');
    return;
  }

  // ── Phase 2: Message sending ──────────────────────────────────────────────
  // Fresh context — Phase 1's large reservation data is gone.
  // Claude receives only the compact gap JSON and writes/sends the messages.

  const gapLines = (gapData.gaps ?? []).map(g =>
    `  • Gap night ${g.gapNight} — ${g.propertyName}\n` +
    `      Outgoing: ${g.outgoing.guestName} (reservation ${g.outgoing.reservationId}, $${g.outgoing.nightlyRate}/night, checks out ${g.outgoing.checkoutDate})\n` +
    `      Incoming: ${g.incoming.guestName} (reservation ${g.incoming.reservationId}, $${g.incoming.nightlyRate}/night, checks in ${g.incoming.checkinDate})`
  ).join('\n');

  const lastMinuteLines = (gapData.lastMinute ?? []).map(lm =>
    `  • Tomorrow ${lm.outgoing.checkoutDate} — ${lm.propertyName}\n` +
    `      Outgoing: ${lm.outgoing.guestName} (reservation ${lm.outgoing.reservationId}, $${lm.outgoing.nightlyRate}/night)`
  ).join('\n');

  const phase2Prompt =
    `Tonight's gap-offer opportunities for Spooner House:\n\n` +

    (gapLines
      ? `GAPS — 1-night vacancy between consecutive reservations (send 2 messages each):\n${gapLines}\n\n`
      : '') +

    (lastMinuteLines
      ? `LAST-MINUTE — checkout tomorrow, room vacant tomorrow night (send 1 message each):\n${lastMinuteLines}\n\n`
      : '') +

    (DRY_RUN
      ? `DRY RUN — Do NOT call send-reservation-message. Instead write out the exact text of ` +
        `every message you would send, clearly labelled by guest and reservation ID.\n\n`
      : `Please send all messages now using send-reservation-message.\n\n`) +

    `For each GAP send two messages:\n` +
    `  a) To the OUTGOING guest: warm offer to stay one more night (the gap night) at 20% off ` +
    `their nightly rate. Include the shortcode %guest_portal% naturally in the message.\n` +
    `  b) To the INCOMING guest: warm offer to arrive one night early at 20% off their nightly ` +
    `rate. Include the shortcode %guest_portal% naturally in the message.\n\n` +

    `For each LAST-MINUTE opportunity send one message:\n` +
    `  a) To the OUTGOING guest: warm last-minute offer to extend one more night at 20% off. ` +
    `Include the shortcode %SmartUpsell% naturally in the message.\n\n` +

    `Message guidelines (all messages):\n` +
    `- Warm and genuine — never templated or robotic\n` +
    `- Mention "Spooner House" by name\n` +
    `- State the discount clearly: one extra night, 20% off (= $X/night with the actual dollar amount)\n` +
    `- Weave the portal/upsell shortcode in naturally — not as a standalone bare code\n` +
    `- Invite them to reply if interested — absolutely no pressure\n` +
    `- Outgoing guests: frame as "one more night before you go"\n` +
    `- Incoming guests: frame as "arrive a night early and settle right in"\n\n` +

    `After ${DRY_RUN ? 'writing all messages' : 'sending all messages'}, provide a brief summary ` +
    `listing each guest contacted, their property, and the gap/last-minute night.\n` +
    (DRY_RUN ? `\nTHIS WAS A DRY RUN — no messages were sent.` : '');

  log('\n── Phase 2: Message sending ─────────────────────────────────────────');
  let phase2Output;
  try {
    phase2Output = await runAgenticLoop({
      systemPrompt,
      userPrompt: phase2Prompt,
      tools: DRY_RUN ? [] : sendTools, // no tools needed when just writing previews
      label: 'phase2',
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      log(`API Error  HTTP ${err.status}: ${err.message}`);
    } else {
      log(`Error: ${err.message}`);
    }
    throw err;
  }

  log('\n─── Workflow summary ───────────────────────────────────────────────');
  console.log(phase2Output);
  log('────────────────────────────────────────────────────────────────────');
  log('Vacancy offer workflow completed successfully.');
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
