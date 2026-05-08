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

function getTomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
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

// ─── Workflow ─────────────────────────────────────────────────────────────────

async function runVacancyOfferWorkflow() {
  const tomorrow = getTomorrow();

  log('================================================================');
  log('  Spooner House — Evening Vacancy Offer Workflow');
  log(`  Checking checkouts for: ${tomorrow}`);
  if (DRY_RUN) log('  ⚠️  DRY RUN — no messages will be sent');
  log('================================================================');

  // Pull all available tools from the Hospitable MCP server
  log('Fetching Hospitable MCP tools …');
  const allTools = await getHospitableTools();
  log(`Found ${allTools.length} tool(s): ${allTools.map(t => t.name).join(', ')}`);

  // In dry-run mode, block any tool whose name suggests it sends messages.
  // Claude literally cannot call them — they don't appear in its tool list.
  const SEND_PATTERN = /send|message|post|reply|notify/i;
  const tools = DRY_RUN
    ? allTools.filter(t => !SEND_PATTERN.test(t.name))
    : allTools;

  if (DRY_RUN) {
    const blocked = allTools.filter(t => SEND_PATTERN.test(t.name));
    if (blocked.length) {
      log(`DRY RUN: blocked send tool(s): ${blocked.map(t => t.name).join(', ')}`);
    }
  }

  const systemPrompt = `You are the hospitality assistant for Spooner House, a warm and welcoming bed \
and breakfast. You genuinely care about every guest. When writing messages to guests, write with real \
warmth — as if you personally know them and are delighted they chose Spooner House.`;

  const userPrompt = `Please complete the following vacancy offer workflow for Spooner House B&B:

**Step 1 — Get properties**
Fetch all properties/rooms from Hospitable.

**Step 2 — Find tonight's checkouts**
Find all reservations that are checking out on ${tomorrow}. These are the guests currently staying.

**Step 3 — Check tomorrow's vacancy**
For each property that has a checkout on ${tomorrow}, check that property's Hospitable calendar for \
${tomorrow} to see whether that night is vacant (no reservation occupying it).

**Step 4 — ${DRY_RUN ? 'Preview extension offers (DRY RUN — do NOT send anything)' : 'Send extension offers'}**
For every room that IS vacant on ${tomorrow}, ${DRY_RUN
  ? `write out the exact message you WOULD send to the guest, but do not call any send or message tool. \
This is a dry run — output the full message text so it can be reviewed, but take no action.`
  : `send the current guest a warm, personal message offering them the chance to stay an additional night \
at a 20% discount off their current nightly rate.`}

The message must:
- Feel warm and genuine — not automated or templated
- Mention "Spooner House" by name
- Express authentic delight that they're staying with us
- Frame the discount as a special treat just for them, not a hard sell
- State clearly: one more night, 20% off their current nightly rate
- Invite them to reply if they're interested — no pressure

**Step 5 — Summary log**
After completing all steps, provide a clear summary:
- ${DRY_RUN
    ? 'List each guest who WOULD have received an offer and show the exact message text'
    : 'List each guest who received an offer'} (guest name, property/room, checkout date)
- List each room already booked for ${tomorrow} (no offer sent, already occupied)
- Note any errors or unexpected results
${DRY_RUN ? '- Clearly state at the top: THIS WAS A DRY RUN — no messages were sent' : ''}`;

  const messages = [{ role: 'user', content: userPrompt }];
  let iteration = 0;
  const MAX_ITERATIONS = 20;

  try {
    while (iteration < MAX_ITERATIONS) {
      iteration++;
      log(`API call #${iteration} …`);

      const response = await client.messages.create({
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
