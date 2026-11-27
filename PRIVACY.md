# VeilBrowse Privacy Policy

VeilBrowse does not collect, store on a server, sell, or share any personal data.

**What the extension reads.** When you run a task, VeilBrowse reads the structure of the current page (element types, roles, labels, positions) and its visible text. It never reads the values typed into form fields. In visual mode it also takes a screenshot of the visible tab.

**What it sends, and where.** It sends a sanitized description of the page (opaque element ids, roles, masked labels) and your task text to the reasoning model you choose:
- **Local LLM (default):** Ollama on your own computer at `127.0.0.1:11434`. Nothing leaves your machine.
- **Rule-based:** runs inside the extension. Nothing is sent anywhere.

Before anything is sent, personal values in the page text ("Name: …", "Phone: …", profile tables) are replaced with `[REDACTED]`, and emails, phone numbers, card and ID numbers and greeting names are replaced with placeholders such as `[EMAIL]`. In visual mode the same areas, and every sensitive form field, are filled black in the screenshot before it goes to the local vision model, and the vision model's description is cleaned the same way.

**What it stores.** The latest scan summary (counts and element types, no values) is kept in Chrome session storage and cleared when the browser closes. Your reasoning choice is kept in the side panel's local storage.

**Permissions.**
- `activeTab`, `tabs`, `scripting`: read the page you are on and run the agent there.
- Site access is optional and requested per site, the first time you run a task on that site.
- `storage`: the scan summary and your settings.
- `sidePanel`: the agent UI.
- Access to `127.0.0.1:11434` / `localhost:11434`: your local Ollama.
- All-sites access (optional): requested only if you turn on visual mode, because Chrome allows screenshots only with it.

**No analytics, no remote servers, no third parties.**
