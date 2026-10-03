import Anthropic from '@anthropic-ai/sdk';
import { store } from '../store.js';

let client = null;
let clientKey = null;

export function claudeAvailable() {
  return Boolean(store.settings.anthropicApiKey);
}

function getClient() {
  const key = store.settings.anthropicApiKey;
  if (!key) throw new Error('Anthropic API key is not configured (Settings → AI).');
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key, timeout: 120_000, maxRetries: 2 });
    clientKey = key;
  }
  return client;
}

/**
 * Single Claude request. Uses server-side refusal fallbacks so an over-cautious
 * classifier decline is retried on Anthropic's recommended fallback model.
 */
// Models that accept the `effort` control and the server-side `fallbacks: "default"` form.
const EFFORT_MODELS = /^claude-(opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|fable-5|mythos)/;
const FALLBACK_MODELS = /^claude-(opus-5|sonnet-5-5|fable-5-1|mythos-5-1)/;

async function request({ system, prompt, maxTokens = 4000, effort = 'low', schema = null, model }) {
  const m = model || store.settings.claudeModel || 'claude-opus-5-5';
  const outputConfig = {};
  if (EFFORT_MODELS.test(m)) outputConfig.effort = effort;
  if (schema) outputConfig.format = { type: 'json_schema', schema };
  const params = {
    model: m,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
  };
  if (FALLBACK_MODELS.test(m)) {
    // a classifier decline is re-run on Anthropic's recommended fallback model instead of failing the break
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const stream = getClient().beta.messages.stream(params);
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') {
    throw new Error(`Claude declined the request${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ''}`);
  }
  if (msg.stop_reason === 'max_tokens') throw new Error('Claude response was cut off (max_tokens)');
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

export async function claudeText(opts) {
  return request(opts);
}

/** Request JSON constrained by a JSON schema (structured outputs). */
export async function claudeJson(opts) {
  const text = await request({ ...opts, schema: opts.schema });
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Claude returned invalid JSON');
  }
}
