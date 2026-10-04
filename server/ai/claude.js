// AI access for the music director, DJ, imaging writer and programmer, with interchangeable back ends:
//
//  - "claude-code": your Claude Code installation and login (Pro/Max subscription). Each request runs
//    `claude -p` headless and isolated: --safe-mode (no CLAUDE.md, hooks, plugins or MCP), no tools,
//    no saved session, JSON output, --json-schema for validated structured output. No API key.
//  - "api": the Anthropic API with an API key (official SDK), with server-side refusal fallbacks.
//  - "codex": ChatGPT through the Codex CLI and its ChatGPT login (`codex exec`, read-only sandbox,
//    ephemeral, --output-schema for structured output). No API key.
//  - "openai": the OpenAI API with an API key (chat completions, structured outputs).
//  - "lmstudio": a local LM Studio server (OpenAI-compatible, http://localhost:1234/v1). Free and offline.
//
// 'auto' uses the first one that's ready, in that order. A provider that fails or hits a usage limit
// cools down and the next ready one takes the request; the DJ falls back to template scripts when
// none is available.

import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { store } from '../store.js';
import { chatRequest, listModels } from './openaiCompat.js';

const log = (...a) => console.log('[claude]', ...a);
const WORKDIR = path.join(os.tmpdir(), 'valhalla-claude');
fs.mkdirSync(WORKDIR, { recursive: true });

// ------------------------------------------------------------------ Claude Code CLI

const cli = {
  checkedAt: 0, found: false, version: null, loggedIn: false, authMethod: null, error: null,
  calls: 0, failures: 0, lastMs: null, lastError: null, cooldownUntil: 0, running: 0,
};
const queue = [];

const cliPath = () => store.settings.claudeCliPath || 'claude';

function run(args, { input, timeoutMs = 20000, env, bin = cliPath() } = {}) {
  return new Promise((resolve) => {
    let out = ''; let err = '';
    let p;
    try {
      p = spawn(bin, args, { cwd: WORKDIR, env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { resolve({ code: -1, out, err: e.message }); return; }
    const timer = setTimeout(() => { p.kill('SIGKILL'); err += '\ntimed out'; }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    p.stdin.on('error', () => {});
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}

let checking = null;

/**
 * Detect every provider (CLIs and their logins, LM Studio) without spending any usage.
 * Cached for 10 minutes; concurrent callers share one check.
 */
export function checkClaudeCode(force = false) {
  // a forced re-check (settings just changed) must not reuse a check that started with the old settings
  if (checking) return force ? checking.then(() => checkClaudeCode(true)) : checking;
  if (!force && Date.now() - cli.checkedAt < 600_000) return Promise.resolve(cli);
  checking = Promise.all([detect(), detectCodex(), probeLmStudio(true)]).then(() => cli).finally(() => { checking = null; });
  return checking;
}
export const checkAi = checkClaudeCode;

async function detect() {
  const v = await run(['--version'], { timeoutMs: 15000 });
  cli.found = v.code === 0;
  cli.version = cli.found ? v.out.trim().split('\n')[0] : null;
  cli.error = cli.found ? null : 'Claude Code CLI not found (install it, or set its path in Settings)';
  if (cli.found) {
    const s = await run(['auth', 'status', '--json'], { timeoutMs: 15000, env: childEnv() });
    try {
      const j = JSON.parse(s.out);
      cli.loggedIn = Boolean(j.loggedIn);
      cli.authMethod = j.authMethod || null;
      if (!cli.loggedIn) cli.error = 'Claude Code is installed but not logged in: run `claude` once to sign in, or `claude setup-token` for servers';
    } catch {
      cli.loggedIn = false;
      cli.error = `could not read login status: ${(s.err || s.out).trim().slice(0, 160)}`;
    }
  }
  cli.checkedAt = Date.now();
  return cli;
}

function childEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // use the Claude Code login (subscription), not a stray API key
  return env;
}

async function claudeCodeRequest({ system, prompt, schema, model, effort, timeoutMs = 240_000 }) {
  if (cli.running >= 2) await new Promise((r) => queue.push(r));
  cli.running++;
  const t0 = Date.now();
  try {
    const args = ['-p', '--output-format', 'json', '--safe-mode', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
      '--system-prompt', system, '--model', model];
    if (effort && !/haiku/.test(model)) args.push('--effort', effort);
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    const r = await run(args, { input: prompt, timeoutMs, env: childEnv() });
    const line = r.out.trim().split('\n').reverse().find((l) => l.startsWith('{'));
    let j = null;
    try { j = line ? JSON.parse(line) : null; } catch { /* handled below */ }
    if (!j) throw new Error(`Claude Code failed (${r.code}): ${(r.err || r.out).trim().slice(-300) || 'no output'}`);
    if (j.is_error || j.subtype !== 'success') {
      const msg = String(j.result || j.api_error_status || j.subtype || 'error');
      if (/limit|429|rate|quota|overloaded/i.test(msg) || j.api_error_status === 429) cli.cooldownUntil = Date.now() + 15 * 60_000;
      throw new Error(`Claude Code: ${msg.slice(0, 300)}`);
    }
    cli.calls++;
    cli.lastMs = Date.now() - t0;
    cli.lastError = null;
    if (schema) {
      if (j.structured_output) return j.structured_output;
      return parseJson(j.result);
    }
    return String(j.result || '').trim();
  } catch (err) {
    cli.failures++;
    cli.lastError = err.message;
    throw err;
  } finally {
    cli.running--;
    queue.shift()?.();
  }
}

let client = null;
let clientKey = null;
// ------------------------------------------------------------------ Codex CLI (ChatGPT login)

const codex = { found: false, version: null, loggedIn: false, method: null, error: null, calls: 0, failures: 0, lastMs: null, lastError: null, cooldownUntil: 0, running: 0 };
const codexQueue = [];
const codexPath = () => store.settings.codexCliPath || 'codex';

async function detectCodex() {
  const v = await run(['--version'], { timeoutMs: 15000, bin: codexPath() });
  codex.found = v.code === 0;
  codex.version = codex.found ? v.out.trim().split('\n')[0].replace(/^codex-cli\s*/, '') : null;
  codex.error = null;
  if (!codex.found) { codex.loggedIn = false; return codex; }
  const s = await run(['login', 'status'], { timeoutMs: 15000, bin: codexPath() });
  const text = `${s.out}\n${s.err}`.trim();
  codex.loggedIn = s.code === 0 && !/not logged in/i.test(text);
  codex.method = codex.loggedIn ? (/chatgpt/i.test(text) ? 'ChatGPT' : /api key/i.test(text) ? 'API key' : 'signed in') : null;
  if (!codex.loggedIn) codex.error = 'Codex is installed but not signed in: run `codex login` once (ChatGPT account)';
  return codex;
}

async function codexRequest({ system, prompt, schema, effort, timeoutMs = 300_000 }) {
  if (codex.running >= 2) await new Promise((r) => codexQueue.push(r));
  codex.running++;
  const t0 = Date.now();
  const tag = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outFile = path.join(WORKDIR, `codex_${tag}.txt`);
  const schemaFile = path.join(WORKDIR, `codex_${tag}.schema.json`);
  try {
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--color', 'never', '-C', WORKDIR, '-o', outFile];
    const model = store.settings.codexModel;
    if (model) args.push('-m', model);
    if (effort) args.push('-c', `model_reasoning_effort="${effort === 'medium' ? 'medium' : 'low'}"`);
    if (schema) { fs.writeFileSync(schemaFile, JSON.stringify(schema)); args.push('--output-schema', schemaFile); }
    args.push('-');
    const input = `${system}\n\nAnswer directly in your final message. Do not run commands or edit files.\n\n---\n\n${prompt}`;
    const r = await run(args, { input, timeoutMs, bin: codexPath() });
    const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '';
    if (!text) {
      const msg = (r.err || r.out).trim().slice(-300) || `exit ${r.code}`;
      if (/limit|429|rate|quota|usage/i.test(msg)) codex.cooldownUntil = Date.now() + 15 * 60_000;
      throw new Error(`Codex failed: ${msg}`);
    }
    codex.calls++;
    codex.lastMs = Date.now() - t0;
    codex.lastError = null;
    return schema ? parseJson(text) : text;
  } catch (err) {
    codex.failures++;
    codex.lastError = err.message;
    throw err;
  } finally {
    for (const f of [outFile, schemaFile]) fs.rmSync(f, { force: true });
    codex.running--;
    codexQueue.shift()?.();
  }
}

// ------------------------------------------------------------------ OpenAI API & LM Studio

export const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';
const openai = { calls: 0, failures: 0, lastMs: null, lastError: null, cooldownUntil: 0 };
const lm = { url: '', reachable: false, models: [], checkedAt: 0, calls: 0, failures: 0, lastMs: null, lastError: null, cooldownUntil: 0 };
const lmUrl = () => (store.settings.lmstudioUrl || 'http://localhost:1234/v1').replace(/\/+$/, '');

async function probeLmStudio(force = false) {
  if (!force && Date.now() - lm.checkedAt < 60_000 && lm.url === lmUrl()) return lm;
  lm.url = lmUrl();
  try { lm.models = await listModels(lm.url, '', 2000); lm.reachable = true; } catch { lm.models = []; lm.reachable = false; }
  lm.checkedAt = Date.now();
  return lm;
}

async function compatRequest(which, { system, prompt, schema, maxTokens = 4000, effort }) {
  const st = which === 'openai' ? openai : lm;
  const t0 = Date.now();
  try {
    let text;
    if (which === 'openai') {
      text = await chatRequest({ baseUrl: 'https://api.openai.com/v1', apiKey: store.settings.openaiApiKey, model: store.settings.openaiModel || DEFAULT_OPENAI_MODEL, system, prompt, schema, maxTokens, effort });
    } else {
      await probeLmStudio();
      const model = store.settings.lmstudioModel || lm.models[0];
      if (!model) throw new Error('LM Studio has no model loaded');
      // local models think out loud; give them room
      text = await chatRequest({ baseUrl: lm.url, model, system, prompt, schema, maxTokens: Math.max(maxTokens, 8000), local: true });
    }
    st.calls++; st.lastMs = Date.now() - t0; st.lastError = null;
    return schema ? parseJson(text) : text;
  } catch (err) {
    st.failures++; st.lastError = err.message;
    if (/429|rate|quota|insufficient/i.test(err.message)) st.cooldownUntil = Date.now() + 15 * 60_000;
    throw err;
  }
}

// ------------------------------------------------------------------ Anthropic API

const EFFORT_MODELS = /^claude-(opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|fable-5|mythos)/;
const FALLBACK_MODELS = /^claude-(opus-5|sonnet-5-5|fable-5-1|mythos-5-1)/;

function getClient() {
  const key = store.settings.anthropicApiKey;
  if (!key) throw new Error('Anthropic API key is not configured (Settings → AI).');
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key, timeout: 120_000, maxRetries: 2 });
    clientKey = key;
  }
  return client;
}

async function apiRequest({ system, prompt, maxTokens = 4000, effort = 'low', schema = null, model }) {
  const outputConfig = {};
  if (EFFORT_MODELS.test(model)) outputConfig.effort = effort;
  if (schema) outputConfig.format = { type: 'json_schema', schema };
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
  };
  if (FALLBACK_MODELS.test(model)) {
    // a classifier decline is re-run on Anthropic's recommended fallback model instead of failing the break
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const msg = await getClient().beta.messages.stream(params).finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error(`Claude declined the request${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ''}`);
  if (msg.stop_reason === 'max_tokens') throw new Error('Claude response was cut off (max_tokens)');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return schema ? parseJson(text) : text;
}

// ------------------------------------------------------------------ routing

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';
export const PROVIDERS = ['claude-code', 'api', 'codex', 'openai', 'lmstudio'];
export const PROVIDER_LABEL = { 'claude-code': 'Claude Code', api: 'Claude API', codex: 'ChatGPT (Codex)', openai: 'OpenAI API', lmstudio: 'LM Studio' };

function ready(p, now = Date.now()) {
  const s = store.settings;
  switch (p) {
    case 'claude-code': return cli.found && cli.loggedIn && now > cli.cooldownUntil;
    case 'api': return Boolean(s.anthropicApiKey);
    case 'codex': return codex.found && codex.loggedIn && now > codex.cooldownUntil;
    case 'openai': return Boolean(s.openaiApiKey) && now > openai.cooldownUntil;
    case 'lmstudio': return lm.reachable && (Boolean(s.lmstudioModel) || lm.models.length > 0) && now > lm.cooldownUntil;
    default: return false;
  }
}

/** The providers to try, in order: the chosen one first, then (unless turned off) every other ready one. */
export function providerChain() {
  const pref = PROVIDERS.includes(store.settings.claudeProvider) ? store.settings.claudeProvider : 'auto';
  const order = pref === 'auto' ? PROVIDERS : [pref, ...PROVIDERS.filter((p) => p !== pref)];
  const fallback = pref === 'auto' || store.settings.aiFallback !== false;
  return order.filter((p, i) => ready(p) && (fallback || i === 0));
}

/** Which back end will serve the next request, or null. */
export function claudeProvider() {
  return providerChain()[0] || null;
}

export function claudeAvailable() {
  return claudeProvider() !== null;
}
export const aiAvailable = claudeAvailable;

function modelFor(p) {
  const s = store.settings;
  if (p === 'claude-code' || p === 'api') return s.claudeModel || DEFAULT_CLAUDE_MODEL;
  if (p === 'codex') return s.codexModel || 'Codex default';
  if (p === 'openai') return s.openaiModel || DEFAULT_OPENAI_MODEL;
  return s.lmstudioModel || lm.models[0] || null;
}

export function claudeStatus() {
  const s = store.settings;
  const provider = claudeProvider();
  return {
    provider,
    label: provider ? PROVIDER_LABEL[provider] : null,
    preference: PROVIDERS.includes(s.claudeProvider) ? s.claudeProvider : 'auto',
    model: provider ? modelFor(provider) : s.claudeModel || DEFAULT_CLAUDE_MODEL,
    chain: providerChain(),
    apiKey: Boolean(s.anthropicApiKey),
    claudeCode: { found: cli.found, version: cli.version, loggedIn: cli.loggedIn, authMethod: cli.authMethod, error: cli.error, calls: cli.calls, failures: cli.failures, lastMs: cli.lastMs, lastError: cli.lastError, coolingDown: Date.now() < cli.cooldownUntil },
    codex: { ...codex, coolingDown: Date.now() < codex.cooldownUntil, model: s.codexModel || null },
    openai: { apiKey: Boolean(s.openaiApiKey), model: s.openaiModel || DEFAULT_OPENAI_MODEL, calls: openai.calls, failures: openai.failures, lastMs: openai.lastMs, lastError: openai.lastError, coolingDown: Date.now() < openai.cooldownUntil },
    lmstudio: { url: lm.url || lmUrl(), reachable: lm.reachable, models: lm.models, model: s.lmstudioModel || lm.models[0] || null, calls: lm.calls, failures: lm.failures, lastMs: lm.lastMs, lastError: lm.lastError },
  };
}

function send(p, opts) {
  if (p === 'claude-code') return claudeCodeRequest({ ...opts, model: opts.model || modelFor(p) });
  if (p === 'api') return apiRequest({ ...opts, model: opts.model || modelFor(p) });
  if (p === 'codex') return codexRequest(opts);
  return compatRequest(p, opts);
}

async function request(opts) {
  await checkClaudeCode();
  if (ready('lmstudio') || store.settings.claudeProvider === 'lmstudio') await probeLmStudio();
  const chain = providerChain();
  if (!chain.length) throw new Error('No AI is connected: sign in to Claude Code or Codex (ChatGPT), start an LM Studio server, or add an Anthropic or OpenAI API key (Settings → AI).');
  let last;
  for (const p of chain) {
    try {
      // a model id chosen for Claude only applies to Claude back ends
      return await send(p, p === 'claude-code' || p === 'api' ? opts : { ...opts, model: undefined });
    } catch (err) {
      last = err;
      if (chain.length > 1) log(`${PROVIDER_LABEL[p]} request failed (${err.message.slice(0, 160)}); trying the next provider`);
    }
  }
  throw last;
}

export async function claudeText(opts) {
  return request({ ...opts, schema: null });
}

/** Request JSON constrained by a JSON schema (structured outputs). */
export async function claudeJson(opts) {
  return request(opts);
}
export const aiText = claudeText;
export const aiJson = claudeJson;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).replace(/```(?:json)?/g, '').match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('the model returned invalid JSON');
  }
}

checkClaudeCode().then(() => {
  log(cli.found ? `Claude Code ${cli.version}: ${cli.loggedIn ? `logged in (${cli.authMethod})` : 'not logged in'}` : 'Claude Code CLI not found');
  if (codex.found) log(`Codex ${codex.version}: ${codex.loggedIn ? `signed in (${codex.method})` : 'not signed in'}`);
  if (lm.reachable) log(`LM Studio at ${lm.url}: ${lm.models.length} model(s)`);
}).catch(() => {});
