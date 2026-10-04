// Claude access with two interchangeable back ends:
//
//  - "claude-code": your own Claude Code installation and login (Pro/Max subscription or whatever
//    `claude` is signed in with). Each request runs `claude -p` headless and isolated: --safe-mode
//    (no CLAUDE.md, hooks, plugins or MCP), no tools, no saved session, JSON output, optional
//    --json-schema for validated structured output. No API key needed.
//  - "api": the Anthropic API with an API key (official SDK), with server-side refusal fallbacks.
//
// 'auto' prefers Claude Code when the CLI is installed and logged in, then an API key.
// If the subscription hits its usage limit, requests cool down and fall back to the API key when
// one is configured; the DJ falls back to template scripts when neither is available.

import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { store } from '../store.js';

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

function run(args, { input, timeoutMs = 20000, env } = {}) {
  return new Promise((resolve) => {
    let out = ''; let err = '';
    let p;
    try {
      p = spawn(cliPath(), args, { cwd: WORKDIR, env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
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

/** Detect the CLI and its login without spending any usage. Cached for 10 minutes; concurrent callers share one check. */
export function checkClaudeCode(force = false) {
  if (checking) return checking;
  if (!force && Date.now() - cli.checkedAt < 600_000) return Promise.resolve(cli);
  checking = detect().finally(() => { checking = null; });
  return checking;
}

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

// ------------------------------------------------------------------ Anthropic API (API key)

let client = null;
let clientKey = null;
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

/** Which back end will serve the next request: 'claude-code' | 'api' | null. */
export function claudeProvider() {
  const s = store.settings;
  const pref = s.claudeProvider || 'auto';
  const codeOk = cli.found && cli.loggedIn && Date.now() > cli.cooldownUntil;
  const apiOk = Boolean(s.anthropicApiKey);
  if (pref === 'claude-code') return codeOk ? 'claude-code' : apiOk && Date.now() <= cli.cooldownUntil ? 'api' : null;
  if (pref === 'api') return apiOk ? 'api' : null;
  return codeOk ? 'claude-code' : apiOk ? 'api' : null;
}

export function claudeAvailable() {
  return claudeProvider() !== null;
}

export function claudeStatus() {
  return {
    provider: claudeProvider(),
    preference: store.settings.claudeProvider || 'auto',
    model: store.settings.claudeModel || 'claude-opus-5-5',
    apiKey: Boolean(store.settings.anthropicApiKey),
    claudeCode: { found: cli.found, version: cli.version, loggedIn: cli.loggedIn, authMethod: cli.authMethod, error: cli.error, calls: cli.calls, failures: cli.failures, lastMs: cli.lastMs, lastError: cli.lastError, coolingDown: Date.now() < cli.cooldownUntil },
  };
}

async function request(opts) {
  const model = opts.model || store.settings.claudeModel || 'claude-opus-5-5';
  await checkClaudeCode();
  const provider = claudeProvider();
  if (!provider) throw new Error('Claude is not available: sign in to Claude Code on this machine, or add an Anthropic API key (Settings → AI).');
  if (provider === 'claude-code') {
    try {
      return await claudeCodeRequest({ ...opts, model });
    } catch (err) {
      if (store.settings.anthropicApiKey && store.settings.claudeProvider !== 'claude-code') {
        log(`Claude Code request failed (${err.message}); using the API key instead`);
        return apiRequest({ ...opts, model });
      }
      throw err;
    }
  }
  return apiRequest({ ...opts, model });
}

export async function claudeText(opts) {
  return request({ ...opts, schema: null });
}

/** Request JSON constrained by a JSON schema (structured outputs). */
export async function claudeJson(opts) {
  return request(opts);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Claude returned invalid JSON');
  }
}

checkClaudeCode().then((s) => log(s.found ? `Claude Code ${s.version}: ${s.loggedIn ? `logged in (${s.authMethod})` : 'not logged in'}` : 'Claude Code CLI not found')).catch(() => {});
