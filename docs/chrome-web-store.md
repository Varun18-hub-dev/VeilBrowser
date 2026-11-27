# Publishing VeilBrowse on the Chrome Web Store

## 1. One-time setup
1. Register at the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) (one-time US$5 fee).
2. Host the privacy policy: enable GitHub Pages for this repo (Settings → Pages → main branch) and use the URL of `PRIVACY.md`, or paste it into a Google Doc set to public.

## 2. Build the package
```bash
# with your deployed cloud server as the default Cloud URL (optional)
VEILBROWSE_CLOUD_URL=https://veilbrowse-cloud.<you>.workers.dev npm run package:extension
# -> apps/extension/veilbrowse-<version>.zip  (production build: minified, demo-only script removed)
```

## 3. Store listing
- **Name:** VeilBrowse – Private AI Browser Agent
- **Summary (132 chars max):** Tell an AI agent what to do on any website. Your personal data is removed before the AI sees the page. Local or cloud AI.
- **Category:** Productivity
- **Description:**
  > VeilBrowse is an AI agent in your side panel. Type a task, such as "find the cheapest laptop under ₹60,000" or "turn on email notifications", and it reads the page, decides each step and clicks or types for you.
  >
  > Privacy firewall: before any AI sees the page, VeilBrowse removes what you typed into forms and masks personal data such as names, emails, phone numbers, card and ID numbers. Every action is checked locally; anything that deletes, pays, sends or submits needs your approval.
  >
  > Choose the AI: Local (Ollama on your computer, nothing leaves it) or Cloud (faster; only the cleaned page is sent). Visual mode can describe the page from a screenshot with private areas blacked out.
  >
  > Open source: github.com/Varun18-hub-dev/VeilBrowser
- **Screenshots (1280×800):** side panel answering on the demo shop; activity view with privacy count; Settings with the engine choice; the blacked-out screenshot from the e2e run.
- **Small promo tile (440×280):** shield icon + "Private AI browser agent".

## 4. Privacy practices tab
- **Single purpose:** "Perform tasks the user types on the current web page with an AI agent, while removing personal data before the AI sees the page."
- **Permission justifications:**
  - `sidePanel`: the agent's user interface.
  - `activeTab`, `tabs`: read the current tab's URL and title to run the task there; follow the task across page loads.
  - `scripting`: inject the agent into a page only after the user allows that site.
  - `storage`: settings and a short-lived scan summary.
  - Host access to `127.0.0.1:11434`/`localhost:11434`: the user's local Ollama model server.
  - Optional host access (`http/https` sites, `<all_urls>`): requested per site when the user runs a task; all sites only if the user enables visual mode (Chrome requires it for screenshots).
- **Remote code:** No. All code is in the package; the cloud server only returns text.
- **Data usage:** collects *Website content* (sanitized, to perform the user's task) when the user runs a task. Not sold, not used for anything unrelated to the single purpose, not used for creditworthiness. Tick the three certification boxes.

## 5. Submit
Upload the zip, fill the tabs, submit for review (usually a few days; broad host permissions can take longer). After approval, add the Web Store extension id to `ALLOWED_ORIGINS` in `cloud-worker/wrangler.toml` and `npx wrangler deploy` again.
