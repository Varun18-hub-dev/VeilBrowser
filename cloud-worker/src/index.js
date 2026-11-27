/**
 * VeilBrowse cloud reasoning server (Cloudflare Worker + Workers AI).
 *
 * The extension sends ONLY sanitized context (personal data already removed or masked by
 * the in-browser privacy firewall). This Worker:
 *   - accepts requests only from the VeilBrowse extension origin(s) in ALLOWED_ORIGINS,
 *   - limits each install (X-VeilBrowse-Install header) per minute and per day,
 *   - runs the configured Workers AI models (no API key ever ships in the extension),
 *   - never logs or stores prompts, images or answers.
 *
 * POST /v1/chat  { kind: "text" | "vision", messages: [...], format?: <JSON schema>, image?: <base64 jpeg> }
 *   -> { ok: true, content: "<model reply>" } | { ok: false, error: "..." }
 * GET  /health   -> { ok: true }
 */

const MAX_BODY_BYTES = 2_000_000; // ~1.4 MB image after base64
const MAX_MESSAGES = 6;
const MAX_TEXT_CHARS = 16_000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = allowedOrigins(env);
    const originOk = allowed.length === 0 ? false : allowed.includes(origin) || allowed.includes('*');
    const cors = originOk
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type, X-VeilBrowse-Install', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', Vary: 'Origin' }
      : {};

    if (request.method === 'OPTIONS') return new Response(null, { status: originOk ? 204 : 403, headers: cors });
    if (url.pathname === '/health') return json({ ok: true }, 200, cors);
    if (url.pathname !== '/v1/chat' || request.method !== 'POST') return json({ ok: false, error: 'Not found' }, 404, cors);
    if (!originOk) return json({ ok: false, error: 'Origin not allowed' }, 403, cors);

    const install = request.headers.get('X-VeilBrowse-Install') || '';
    if (!/^[a-f0-9-]{16,64}$/i.test(install)) return json({ ok: false, error: 'Missing install id' }, 400, cors);

    const len = Number(request.headers.get('Content-Length') || '0');
    if (len > MAX_BODY_BYTES) return json({ ok: false, error: 'Request too large' }, 413, cors);
    let body;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return json({ ok: false, error: 'Request too large' }, 413, cors);
      body = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: 'Invalid JSON' }, 400, cors);
    }

    const problem = validate(body, env);
    if (problem) return json({ ok: false, error: problem }, 400, cors);

    const limited = await checkLimits(env, install, body.kind);
    if (limited) return json({ ok: false, error: limited }, 429, cors);

    try {
      const content = await runModel(env, body);
      return json({ ok: true, content }, 200, cors);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      // Daily free allocation exhausted, or the model is unavailable on this plan.
      if (/4006|neuron|quota|limit/i.test(msg)) return json({ ok: false, error: 'The free cloud quota for today is used up. Try again after 00:00 UTC, or switch to Local mode.' }, 503, cors);
      return json({ ok: false, error: 'Cloud model error' }, 502, cors);
    }
  },
};

export function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function validate(body, env) {
  if (!body || typeof body !== 'object') return 'Invalid body';
  if (body.kind !== 'text' && body.kind !== 'vision') return 'kind must be text or vision';
  if (body.kind === 'vision' && String(env.ALLOW_VISION || 'true') !== 'true') return 'Cloud vision is disabled on this server';
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES) return 'Invalid messages';
  for (const m of body.messages) {
    if (!m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') return 'Invalid message';
    if (m.content.length > MAX_TEXT_CHARS) return 'Message too long';
  }
  if (body.kind === 'vision' && (typeof body.image !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(body.image.slice(0, 200)))) return 'Vision requests need a base64 image';
  if (body.format !== undefined && (typeof body.format !== 'object' || JSON.stringify(body.format).length > 4000)) return 'Invalid format';
  return null;
}

/** Per-minute (Rate Limiting binding) and per-day (KV) limits per install. Both optional. */
async function checkLimits(env, install, kind) {
  if (env.RATE_LIMITER) {
    const { success } = await env.RATE_LIMITER.limit({ key: install });
    if (!success) return 'Too many requests. Wait a minute.';
  }
  if (env.USAGE) {
    const day = new Date().toISOString().slice(0, 10);
    const key = `${day}:${install}`;
    const used = Number((await env.USAGE.get(key)) || '0');
    const cost = kind === 'vision' ? 5 : 1; // images use far more of the shared free quota
    const cap = Number(env.DAILY_LIMIT_PER_INSTALL || '40');
    if (used + cost > cap) return `Daily cloud limit reached (${cap} units). Switch to Local mode or try tomorrow.`;
    await env.USAGE.put(key, String(used + cost), { expirationTtl: 60 * 60 * 48 });
  }
  return null;
}

async function runModel(env, body) {
  const model = body.kind === 'vision' ? env.VISION_MODEL || '@cf/google/gemma-4-26b-a4b-it' : env.TEXT_MODEL || '@cf/google/gemma-4-26b-a4b-it';
  let messages = body.messages;
  if (body.kind === 'vision') {
    // Attach the (already redacted) screenshot to the last user message as an image part.
    const last = messages[messages.length - 1];
    messages = [
      ...messages.slice(0, -1),
      { role: last.role, content: [{ type: 'text', text: last.content }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${body.image}` } }] },
    ];
  }
  const input = { messages, max_tokens: body.kind === 'vision' ? 400 : 300, temperature: 0.1 };
  if (body.format) input.response_format = { type: 'json_schema', json_schema: body.format };

  let result;
  try {
    result = await env.AI.run(model, input);
  } catch (err) {
    if (/agree|license/i.test(String(err && err.message))) {
      await env.AI.run(model, { prompt: 'agree' }); // one-time model license acceptance (e.g. Meta Llama)
      result = await env.AI.run(model, input);
    } else if (input.response_format) {
      delete input.response_format; // model without structured-output support: plain JSON request
      result = await env.AI.run(model, input);
    } else {
      throw err;
    }
  }
  return extractText(result);
}

export function extractText(result) {
  if (!result) throw new Error('Empty model response');
  if (typeof result === 'string') return result;
  if (typeof result.response === 'string') return result.response;
  if (result.response && typeof result.response === 'object') return JSON.stringify(result.response);
  const choice = result.choices && result.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content === 'string') return content;
  throw new Error('Unrecognized model response');
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
