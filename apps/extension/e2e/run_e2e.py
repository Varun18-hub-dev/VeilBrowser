"""
End-to-end test: loads the built extension into Chrome and drives it from the side panel.

Needs: `npm run build` first, Python `playwright`, and a Chrome that still accepts
--load-extension (Chrome for Testing or Chromium; branded Chrome 137+ ignores the flag).

    python e2e/run_e2e.py --chrome /path/to/chrome

It serves the demo page on two origins (3000 = demo, 3001 = an "ordinary" site that only
gets the content script on demand) and runs a stand-in for Ollama on 127.0.0.1:11434 that
returns scripted replies and logs every prompt, so the test can check what the model saw.
Stop a real Ollama first, or the port will be taken.
"""
import argparse, json, os, shutil, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "..", "dist")
DEMO = os.path.join(HERE, "..", "..", "demo-site", "public")
ap = argparse.ArgumentParser(); ap.add_argument("--chrome", default=None); args = ap.parse_args()
WORK = tempfile.mkdtemp(prefix="veil-e2e-")
EXT = os.path.join(WORK, "ext")
PROMPTS = os.path.join(WORK, "prompts.log")
procs = [subprocess.Popen([sys.executable, "-m", "http.server", port, "--bind", "127.0.0.1", "-d", DEMO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for port in ("3000", "3001")]
procs.append(subprocess.Popen([sys.executable, os.path.join(HERE, "fake_ollama.py"), PROMPTS], stderr=subprocess.DEVNULL))
time.sleep(1.5)
# Test copy: pre-grant the test site, which a real user grants from the side panel prompt.
shutil.rmtree(EXT, ignore_errors=True); shutil.copytree(DIST, EXT)
m = json.load(open(f"{EXT}/manifest.json")); m["host_permissions"].append("http://127.0.0.1:3001/*")
json.dump(m, open(f"{EXT}/manifest.json", "w"))


R = {}
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(os.path.join(WORK, "profile"), executable_path=args.chrome, headless=False,
        args=["--headless=new", f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--no-sandbox"])
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
    ext_id = sw.url.split("/")[2]
    panel = ctx.new_page(); panel.goto(f"chrome-extension://{ext_id}/sidepanel.html")
    panel.evaluate("window.__msgs = []; chrome.runtime.onMessage.addListener(m => { window.__msgs.push(m); });")

    def wait_msg(kind, timeout=30):
        end = time.time() + timeout
        while time.time() < end:
            if panel.evaluate(f"window.__msgs.some(m => m.type === '{kind}')"): return
            time.sleep(0.2)
        raise TimeoutError(kind + " | seen: " + json.dumps(panel.evaluate("window.__msgs.map(m => [m.type, m.status, m.currentStep])")))

    def tab_id(pattern):
        return sw.evaluate(f"async () => (await chrome.tabs.query({{url: '{pattern}'}}))[0].id")

    def run(tid, task, provider, confirm=None):
        panel.evaluate("window.__msgs = []")
        start = panel.evaluate(f"chrome.runtime.sendMessage({{type:'RUN_AGENT_TASK_FROM_PANEL', targetTabId:{tid}, payload:{{task:{json.dumps(task)}, provider:'{provider}'}}}})")
        if not start.get("ok"):
            return {"start": start}
        if confirm is not None:
            wait_msg('CONFIRM_ACTION_REQUEST')
            req = panel.evaluate("window.__msgs.find(m => m.type === 'CONFIRM_ACTION_REQUEST')")
            panel.evaluate(f"chrome.runtime.sendMessage({{type:'CONFIRM_ACTION_RESPONSE', confirmationId:'{req['confirmationId']}', approved:{str(confirm).lower()}, targetTabId:{tid}}})")
        wait_msg('AGENT_TASK_COMPLETED')
        d = panel.evaluate("window.__msgs.find(m => m.type === 'AGENT_TASK_COMPLETED').payload")
        out = {"status": d["status"], "provider": d["providerId"], "result": d["finalResult"],
               "steps": [f"{s['action']} '{s.get('targetLabel')}' -> {s['outcome']}" for s in d["steps"]],
               "piiMaskedInLabels": d["summary"]["piiMaskedInLabels"], "outboundPii": d["summary"]["outboundPii"]}
        if confirm is not None: out["confirm_prompt"] = req["description"]
        return out

    # 1. Demo site (dev build auto-loads the content script there), rule-based provider.
    demo = ctx.new_page(); demo.goto("http://localhost:3000/"); demo.wait_for_timeout(1200)
    R["1_demo_mock"] = run(tab_id("http://localhost:3000/*"), "Open notification settings and enable email notifications", "mock")
    R["1_demo_toggle_on"] = demo.is_checked("#email-notif-toggle")

    # 2. Ordinary site: injected on demand; local LLM path through the background proxy.
    site = ctx.new_page(); site.goto("http://127.0.0.1:3001/"); site.wait_for_timeout(800)
    site.evaluate("document.title = 'Account - ajay.mehra@example.com'")
    tid = tab_id("http://127.0.0.1:3001/*")
    R["2_ordinary_site_llm"] = run(tid, "Enable email notifications", "qwen")
    R["2_toggle_on"] = site.is_checked("#email-notif-toggle")
    prompts = open(PROMPTS).read()
    R["2_pii_in_prompts"] = {k: (k in prompts) for k in ["ajay.mehra@example.com", "recovery.ajay@example.com", "Ajay Mehra", "VB-7729", "Lotus Lane"]}

    # 3. Destructive click: declined, then approved.
    site.evaluate("""(() => { const b = document.createElement('button'); b.textContent = 'Delete account'; b.id = 'del';
        b.onclick = () => { window.__deleted = true; }; document.body.prepend(b); })()""")
    site.wait_for_timeout(800)
    R["3_destructive_declined"] = run(tid, "Delete my account", "qwen", confirm=False)
    R["3_deleted_after_decline"] = site.evaluate("!!window.__deleted")
    R["3_destructive_approved"] = run(tid, "Delete my account", "qwen", confirm=True)
    R["3_deleted_after_approve"] = site.evaluate("!!window.__deleted")

    # 4. Hostile page tries to drive the agent and listen for its messages.
    site.evaluate("""window.__fromExt = []; window.addEventListener('message', e => { if (e.data && e.data.source === 'VEILBROWSE_EXTENSION') window.__fromExt.push(e.data.type); });
        document.getElementById('email-notif-toggle').checked = false;
        window.postMessage({source:'VEILBROWSE_PAGE', type:'RUN_AGENT_TASK', payload:{task:'Enable email notifications', provider:'mock'}}, '*');
        window.postMessage({source:'VEILBROWSE_PAGE', type:'GET_FIREWALL_STATUS'}, '*');""")
    site.wait_for_timeout(2500)
    R["4_hostile_page_toggle_changed"] = site.is_checked("#email-notif-toggle")
    R["4_messages_seen_by_page"] = site.evaluate("window.__fromExt")

    # 5. chrome:// pages are refused.
    t2 = sw.evaluate("async () => (await chrome.tabs.create({url: 'chrome://version'})).id"); time.sleep(1)
    R["5_chrome_page"] = run(t2, "x", "mock")

    ctx.close()
for pr in procs: pr.terminate()
print(json.dumps(R, indent=2))

checks = {
    "demo task turned the toggle on": R["1_demo_toggle_on"],
    "ordinary site: injected on demand and completed": R["2_ordinary_site_llm"].get("status") == "COMPLETED" and R["2_toggle_on"],
    "no page PII reached the model": not any(R["2_pii_in_prompts"].values()),
    "outbound PII is 0 in every run": all(R[k].get("outboundPii", 0) == 0 for k in R if isinstance(R[k], dict) and "status" in R[k]),
    "declined destructive click did not run": R["3_destructive_declined"].get("status") == "STOPPED" and not R["3_deleted_after_decline"],
    "approved destructive click ran": R["3_deleted_after_approve"],
    "web page cannot drive the agent": not R["4_hostile_page_toggle_changed"] and R["4_messages_seen_by_page"] == [],
    "chrome:// pages refused": R["5_chrome_page"].get("start", {}).get("ok") is False,
}
print()
for name, ok in checks.items(): print(("PASS " if ok else "FAIL ") + name)
sys.exit(0 if all(checks.values()) else 1)
