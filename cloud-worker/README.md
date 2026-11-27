# VeilBrowse cloud server (Cloudflare Worker)

Optional, faster reasoning for the extension's **Cloud** mode, on Cloudflare Workers AI's free daily allocation (10,000 Neurons/day, resets 00:00 UTC). Only sanitized context reaches it: personal data is removed in the browser first. Prompts, images and answers are not logged or stored.

## Deploy (about 5 minutes)

```bash
cd cloud-worker
npx wrangler login                                   # opens Cloudflare in the browser
npx wrangler kv namespace create USAGE               # per-user daily limit; paste the id into wrangler.toml and uncomment
# edit wrangler.toml: ALLOWED_ORIGINS = "chrome-extension://<your extension id>"
npx wrangler deploy                                  # prints https://veilbrowse-cloud.<you>.workers.dev
```

The extension id is on `chrome://extensions` (unpacked) and, after publishing, on the Web Store page. List both, comma-separated.

Then in the extension: Settings → AI engine → **Cloud**, and paste the workers.dev URL. To ship it as the default, build with:

```bash
# PowerShell: $env:VEILBROWSE_CLOUD_URL="https://veilbrowse-cloud.<you>.workers.dev"; npm run package:extension
VEILBROWSE_CLOUD_URL=https://veilbrowse-cloud.<you>.workers.dev npm run package:extension
```

## What it enforces

| | |
|---|---|
| Who can call it | only origins in `ALLOWED_ORIGINS` (your extension); others get 403. Note: a non-browser client can fake an Origin header, so the limits below are the real protection for the free quota. |
| Per-user limits | `X-VeilBrowse-Install` (random id per install): 8 requests/minute (Rate Limiting binding) and `DAILY_LIMIT_PER_INSTALL` units/day (KV; a vision call costs 5). |
| Models | `TEXT_MODEL` / `VISION_MODEL` (default `@cf/google/gemma-4-26b-a4b-it`, text + vision, available on the Workers Free plan as of Nov 2026). Structured JSON output is requested; falls back to plain JSON if a model does not support it. |
| Quota | when the daily free Neurons run out, users get a clear message to switch to Local mode. |
| Privacy | no logging of request bodies; nothing stored except the per-install daily counter (expires after 48 h). |

## Test

```bash
node test.mjs        # offline, mocked Workers AI
npx wrangler dev     # local server on http://localhost:8787 (set Cloud URL to it for development)
```

Budget: 10,000 Neurons is roughly 100-200 short LLM responses a day across all users; a task takes 3-6 calls, and a vision call costs much more. Fine for a demo; beyond that, Workers Paid is $0.011 per 1,000 Neurons.
