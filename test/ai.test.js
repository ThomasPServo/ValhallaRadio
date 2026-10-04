import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './helpers.js';
import { store } from '../server/store.js';

// ---- a stand-in LM Studio server (OpenAI-compatible)
let server; let base; const seen = [];
let rejectFormat = false;
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'qwen3-8b' }, { id: 'text-embedding-nomic' }] }));
      const b = JSON.parse(body);
      seen.push(b);
      if (rejectFormat && b.response_format) { res.statusCode = 400; return res.end('{"error":"response_format not supported"}'); }
      if (/Song lookup tool/.test(b.messages[0].content)) {
        // a model that doesn't know this week's music: it looks the song up first, then answers from the facts
        const facts = b.messages[1].content.match(/Lookup results[^\n]*\n(.*)/);
        const content = facts ? JSON.stringify({ lookups: [], pick: facts[1].includes('#1 Hot 100') ? 'Boston' : 'unknown' }) : JSON.stringify({ lookups: [{ artist: 'Stella Lefty', title: 'Boston' }], pick: '' });
        return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
      }
      const content = b.response_format || /JSON Schema/.test(b.messages[0].content)
        ? '<think>pick something upbeat</think>```json\n{"pick":"Mr. Brightside"}\n```'
        : '<think>hmm</think>Twenty past seven on the station.';
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => server.close());

// ---- a stand-in Codex CLI
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valhalla-codex-'));
const fakeCodex = path.join(dir, 'codex');
fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('codex-cli 9.9.9'); process.exit(0); }
if (a[0] === 'login') { console.log(process.env.FAKE_CODEX_LOGGED_OUT ? 'Not logged in' : 'Logged in using ChatGPT'); process.exit(process.env.FAKE_CODEX_LOGGED_OUT ? 1 : 0); }
if (process.env.FAKE_CODEX_FAIL) { console.error('usage limit reached'); process.exit(1); }
let input = ''; process.stdin.on('data', (c) => input += c).on('end', () => {
  fs.writeFileSync(${JSON.stringify(path.join(dir, 'last-args.json'))}, JSON.stringify({ args: a, input }));
  const out = a[a.indexOf('-o') + 1];
  fs.writeFileSync(out, a.includes('--output-schema') ? '{"pick":"Dreams"}' : 'Hey, it is Codex on the air.');
});
`);
fs.chmodSync(fakeCodex, 0o755);

const ai = () => import('../server/ai/claude.js');
function settings(o) {
  Object.assign(store.data.settings, { claudeCliPath: path.join(dir, 'no-claude'), codexCliPath: fakeCodex, anthropicApiKey: '', openaiApiKey: '', lmstudioModel: '', aiFallback: true, ...o });
}

test('Sonnet is the default Claude model', async () => {
  const { DEFAULT_CLAUDE_MODEL } = await ai();
  assert.equal(DEFAULT_CLAUDE_MODEL, 'claude-sonnet-5-5');
  assert.equal(store.data.settings.claudeModel, 'claude-sonnet-5-5');
});

test('LM Studio: detects loaded models, structured output, <think> stripped', async () => {
  settings({ claudeProvider: 'lmstudio', lmstudioUrl: base });
  const { checkAi, claudeStatus, claudeJson, claudeText } = await ai();
  await checkAi(true);
  const st = claudeStatus();
  assert.equal(st.provider, 'lmstudio');
  assert.deepEqual(st.lmstudio.models, ['qwen3-8b'], 'embedding models are not chat models');
  const j = await claudeJson({ system: 'You are a music director.', prompt: 'Pick a song.', schema: { type: 'object', properties: { pick: { type: 'string' } }, required: ['pick'] } });
  assert.deepEqual(j, { pick: 'Mr. Brightside' });
  assert.equal(seen.at(-1).model, 'qwen3-8b');
  assert.equal(seen.at(-1).response_format.type, 'json_schema');
  assert.equal(await claudeText({ system: 'DJ', prompt: 'Time check' }), 'Twenty past seven on the station.');
});

test('a server without structured outputs gets the schema in the prompt instead', async () => {
  settings({ claudeProvider: 'lmstudio', lmstudioUrl: base });
  const { claudeJson } = await ai();
  rejectFormat = true;
  try {
    const j = await claudeJson({ system: 'MD', prompt: 'Pick.', schema: { type: 'object', properties: { pick: { type: 'string' } } } });
    assert.deepEqual(j, { pick: 'Mr. Brightside' });
    assert.ok(!seen.at(-1).response_format && /JSON Schema/.test(seen.at(-1).messages[0].content));
  } finally { rejectFormat = false; }
});

test('ChatGPT via Codex: signed-in check, isolated headless run, schema file', async () => {
  settings({ claudeProvider: 'codex', codexModel: 'gpt-5-codex' });
  const { checkAi, claudeStatus, claudeJson, claudeText } = await ai();
  await checkAi(true);
  const st = claudeStatus();
  assert.equal(st.provider, 'codex');
  assert.equal(st.label, 'ChatGPT (Codex)');
  assert.deepEqual([st.codex.version, st.codex.method], ['9.9.9', 'ChatGPT']);
  assert.equal(await claudeText({ system: 'You are a DJ.', prompt: 'Say hi.', effort: 'low' }), 'Hey, it is Codex on the air.');
  const { args, input } = JSON.parse(fs.readFileSync(path.join(dir, 'last-args.json'), 'utf8'));
  for (const f of ['exec', '--skip-git-repo-check', '--ephemeral', 'read-only', '-o']) assert.ok(args.includes(f), f);
  assert.deepEqual(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2), ['-m', 'gpt-5-codex']);
  assert.ok(args.includes('model_reasoning_effort="low"'));
  assert.ok(input.startsWith('You are a DJ.') && input.endsWith('Say hi.'));
  assert.deepEqual(await claudeJson({ system: 'MD', prompt: 'Pick.', schema: { type: 'object' } }), { pick: 'Dreams' });
});

test('when the chosen AI fails, the next ready one takes the request', async () => {
  settings({ claudeProvider: 'codex', lmstudioUrl: base });
  const { checkAi, claudeText, providerChain } = await ai();
  await checkAi(true);
  assert.deepEqual(providerChain(), ['codex', 'lmstudio']);
  process.env.FAKE_CODEX_FAIL = '1';
  try {
    assert.equal(await claudeText({ system: 'DJ', prompt: 'Time check' }), 'Twenty past seven on the station.');
    store.data.settings.aiFallback = false;
    assert.deepEqual(providerChain(), [], 'codex is cooling down after the usage limit and fallback is off');
  } finally { delete process.env.FAKE_CODEX_FAIL; }
});

test('auto picks the first ready provider; signed-out CLIs are skipped', async () => {
  process.env.FAKE_CODEX_LOGGED_OUT = '1';
  try {
    settings({ claudeProvider: 'auto', lmstudioUrl: base });
    const { checkAi, claudeStatus } = await ai();
    await checkAi(true);
    const st = claudeStatus();
    assert.equal(st.codex.loggedIn, false);
    assert.equal(st.provider, 'lmstudio');
    settings({ claudeProvider: 'auto', lmstudioUrl: 'http://127.0.0.1:9/v1' });
    await checkAi(true);
    assert.equal(claudeStatus().provider, null);
  } finally { delete process.env.FAKE_CODEX_LOGGED_OUT; }
});

test('lookup tool: any model can ask for song facts before answering', async () => {
  settings({ claudeProvider: 'lmstudio', lmstudioUrl: base });
  const { checkAi, claudeJsonWithLookups } = await ai();
  await checkAi(true);
  const asked = [];
  const out = await claudeJsonWithLookups({
    system: 'You are a music director.',
    prompt: 'Which song is the biggest hit right now?',
    schema: { type: 'object', properties: { pick: { type: 'string' } }, required: ['pick'], additionalProperties: false },
    lookup: async (a) => { asked.push(a); return `${a.artist} - ${a.title}: 2026, country pop, #1 Hot 100`; },
  });
  assert.deepEqual(asked, [{ artist: 'Stella Lefty', title: 'Boston' }]);
  assert.deepEqual(out, { pick: 'Boston' }, 'answered from the looked-up facts, lookups field removed');
  const req = seen.at(-1);
  assert.ok(req.response_format.json_schema.schema.required.includes('lookups'), 'the lookup field is part of the schema (strict providers need it required)');
});
