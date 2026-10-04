// OpenAI-compatible chat completions: the OpenAI API (ChatGPT models with an API key) and local
// servers that speak the same protocol, such as LM Studio (http://localhost:1234/v1).

/** List the models a server offers (LM Studio lists the ones that are downloaded/loaded). */
export async function listModels(baseUrl, apiKey = '', timeoutMs = 2500) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  return (d.data || []).map((m) => m.id).filter((id) => !/embed/i.test(id));
}

const schemaHint = (schema) => `\n\nReply with only a JSON object (no markdown, no commentary) that matches this JSON Schema:\n${JSON.stringify(schema)}`;

/**
 * One chat completion. With a schema, asks for structured JSON output and falls back to
 * instructing the model when a server doesn't support response_format.
 */
export async function chatRequest({ baseUrl, apiKey = '', model, system, prompt, schema = null, maxTokens = 4000, effort = null, local = false, timeoutMs = 240_000 }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const send = async (withFormat) => {
    const body = {
      model,
      messages: [{ role: 'system', content: system + (schema && !withFormat ? schemaHint(schema) : '') }, { role: 'user', content: prompt }],
    };
    if (local) body.max_tokens = maxTokens; else body.max_completion_tokens = maxTokens;
    if (effort && !local && /^(gpt-5|o\d)/.test(model)) body.reasoning_effort = effort === 'medium' ? 'medium' : 'low';
    if (schema && withFormat) body.response_format = { type: 'json_schema', json_schema: { name: 'response', schema, strict: false } };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`), { status: res.status, body: text });
    return JSON.parse(text);
  };
  let d;
  try {
    d = await send(true);
  } catch (err) {
    if (!schema || err.status !== 400) throw err;
    d = await send(false); // server without structured outputs: ask for JSON in the prompt instead
  }
  const choice = d.choices?.[0];
  if (!choice) throw new Error('empty response');
  if (choice.finish_reason === 'length') throw new Error('response was cut off (max tokens)');
  if (choice.message?.refusal) throw new Error(`the model declined: ${choice.message.refusal.slice(0, 200)}`);
  // reasoning models served locally may wrap their thinking in <think> tags
  const content = String(choice.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return content;
}
