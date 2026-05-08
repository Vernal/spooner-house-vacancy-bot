import Anthropic from '@anthropic-ai/sdk';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─── Logging ────────────────────────────────────────────────────────────────

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getTomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

// ─── Workflow ─────────────────────────────────────────────────────────────────

async function runVacancyOfferWorkflow() {
  const tomorrow = getTomorrow();

  log('================================================================');
  log('  Spooner House — Evening Vacancy Offer Workflow');
  log(`  Checking checkouts for: ${tomorrow}`);
  log('================================================================');

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

**Step 4 — Send extension offers**
For every room that IS vacant on ${tomorrow}, send the current guest a warm, personal message offering \
them the chance to stay one additional night at a 15% discount off their current nightly rate.

The message must:
- Feel warm and genuine — not automated or templated
- Mention "Spooner House" by name
- Express authentic delight that they're staying with us
- Frame the discount as a special treat just for them, not a hard sell
- State clearly: one more night, 15% off their current nightly rate
- Invite them to reply if they're interested — no pressure

**Step 5 — Summary log**
After completing all steps, provide a clear summary:
- List each guest who received an offer (guest name, property/room, their checkout date)
- List each room that was already booked for ${tomorrow} (no offer sent, already occupied)
- Note any errors or unexpected results`;

  const messages = [{ role: 'user', content: userPrompt }];

  let iteration = 0;
  const MAX_ITERATIONS = 15;

  try {
    while (iteration < MAX_ITERATIONS) {
      iteration++;
      log(`API call #${iteration} …`);

      const response = await client.beta.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        betas: ['mcp-client-2025-04-04'],
        mcp_servers: [
          {
            type: 'url',
            url: 'https://mcp.hospitable.com/mcp',
            name: 'hospitable',
            authorization_token: process.env.HOSPITABLE_API_TOKEN,
          },
        ],
        tools: [
          {
            type: 'mcp_toolset',
            mcp_server_name: 'hospitable',
          },
        ],
        messages,
      });

      const inputTokens = response.usage?.input_tokens ?? '?';
      const outputTokens = response.usage?.output_tokens ?? '?';
      log(`Stop reason: ${response.stop_reason}  |  tokens in: ${inputTokens}  out: ${outputTokens}`);

      // Always append the assistant turn so the loop state is coherent
      messages.push({ role: 'assistant', content: response.content });

      // ── Natural completion ────────────────────────────────────────────────
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

      // ── Server-side tools need another turn (pause_turn) ──────────────────
      if (response.stop_reason === 'pause_turn') {
        log('Workflow paused by server — continuing …');
        continue;
      }

      // ── Client-side tool calls (unexpected with server-side MCP but handled) ─
      if (response.stop_reason === 'tool_use') {
        const toolResults = [];
        for (const block of response.content) {
          if (block.type === 'tool_use') {
            const inputPreview = JSON.stringify(block.input).slice(0, 120);
            log(`  Tool called: ${block.name}  input: ${inputPreview}`);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: 'Executed via Hospitable MCP server.',
            });
          }
        }
        if (toolResults.length > 0) {
          messages.push({ role: 'user', content: toolResults });
        }
        continue;
      }

      // ── Safety valve ──────────────────────────────────────────────────────
      log(`WARNING: Unexpected stop reason "${response.stop_reason}" — stopping loop`);
      break;
    }

    if (iteration >= MAX_ITERATIONS) {
      log('WARNING: Reached maximum iteration limit. Workflow may be incomplete.');
    }
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      log(`API Error  HTTP ${error.status}: ${error.message}`);
      if (error.status === 400) {
        log('Hint: Verify model ID, beta header "mcp-client-2025-04-04", and MCP server URL.');
      } else if (error.status === 401) {
        log('Hint: Check ANTHROPIC_API_KEY and HOSPITABLE_API_TOKEN values.');
      } else if (error.status === 429) {
        log('Hint: Rate limited — consider running the cron job less frequently.');
      }
    } else {
      log(`Unexpected error: ${error.message}`);
    }
    throw error;
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

// Runs every day at 7:00 PM Eastern Time
cron.schedule(
  '0 19 * * *',
  () => {
    log('Cron fired — starting vacancy offer workflow …');
    runVacancyOfferWorkflow().catch((err) => {
      log(`Workflow failed: ${err.message}`);
    });
  },
  { timezone: 'America/New_York' },
);

log('Spooner House vacancy bot is running.');
log('Scheduled: daily at 7:00 PM Eastern (America/New_York).');

// ─── Manual run ──────────────────────────────────────────────────────────────

if (process.argv.includes('--run-now')) {
  log('--run-now flag detected — executing workflow immediately …');
  runVacancyOfferWorkflow().catch((err) => {
    log(`Workflow failed: ${err.message}`);
    process.exit(1);
  });
}
