# VeilBrowse Privacy Policy

VeilBrowse does not collect, store on a server, sell, or share any personal data.

**What the extension reads.** When you run a task, VeilBrowse reads the structure of the current page: element types, roles, labels and positions. It does not read the values typed into form fields.

**What it sends, and where.** It sends a sanitized description of the page (opaque element ids, roles, masked labels) and your task text to the reasoning model you choose:
- **Local LLM (default):** Ollama on your own computer at `127.0.0.1:11434`. Nothing leaves your machine.
- **Rule-based:** runs inside the extension. Nothing is sent anywhere.

Before anything is sent, personal data that appears in visible text (emails, phone numbers, card numbers, ID numbers) is replaced with placeholders such as `[EMAIL]`.

**What it stores.** The latest scan summary (counts and element types, no values) is kept in Chrome session storage and cleared when the browser closes. Your reasoning choice is kept in the side panel's local storage.

**Permissions.**
- `activeTab`, `tabs`, `scripting`: read the page you are on and run the agent there.
- Site access is optional and requested per site, the first time you run a task on that site.
- `storage`: the scan summary and your settings.
- `sidePanel`: the agent UI.
- Access to `127.0.0.1:11434` / `localhost:11434`: your local Ollama.

**No analytics, no remote servers, no third parties.**
