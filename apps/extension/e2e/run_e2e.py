"""
End-to-end test: loads the built extension into Chrome and drives the real side panel UI.

Needs: `npm run build` first, Python `playwright` + `pillow`, and a Chrome that still accepts
--load-extension (Chrome for Testing or Chromium; branded Chrome 137+ ignores the flag).

    python e2e/run_e2e.py --chrome /path/to/chrome [--shots out_dir]

Serves the demo pages on 127.0.0.1:3000 and :3001, plus :3002 on 127.0.0.2 as a site the
user has NOT allowed yet. A stand-in for Ollama on 127.0.0.1:11434 returns scripted replies
and logs every request (text prompts and screenshots), so the test can check exactly what
the models were shown. Stop a real Ollama first, or the port will be taken.
"""
import argparse, json, os, shutil, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "..", "dist")
DEMO = os.path.join(HERE, "..", "..", "demo-site", "public")
ap = argparse.ArgumentParser()
ap.add_argument("--chrome", default=None)
ap.add_argument("--shots", default=None, help="folder for side panel screenshots")
ap.add_argument("--real-ollama", default=None, metavar="URL",
                help="use a real Ollama at URL (e.g. http://127.0.0.1:11435) instead of scripted replies; "
                     "start it with OLLAMA_HOST=127.0.0.1:11435 ollama serve")
args = ap.parse_args()

WORK = tempfile.mkdtemp(prefix="veil-e2e-")
EXT = os.path.join(WORK, "ext")
LOG = os.path.join(WORK, "requests.log")
SHOTS = args.shots or os.path.join(WORK, "shots")
os.makedirs(SHOTS, exist_ok=True)

# Test copy of the extension: pre-grant the test sites (a real user grants them from the panel).
shutil.copytree(DIST, EXT)
m = json.load(open(f"{EXT}/manifest.json"))
m["host_permissions"] += ["http://127.0.0.1/*", "http://localhost/*"]
json.dump(m, open(f"{EXT}/manifest.json", "w"))
# Second copy for visual mode: the user has granted "all sites" (needed for screenshots).
EXT_ALL = os.path.join(WORK, "ext_all")
shutil.copytree(DIST, EXT_ALL)
m["host_permissions"] += ["<all_urls>"]
json.dump(m, open(f"{EXT_ALL}/manifest.json", "w"))

import socket
_probe = socket.socket()
_in_use = _probe.connect_ex(("127.0.0.1", 11434)) == 0  # something is listening there
_probe.close()
if _in_use:
    sys.exit("Port 11434 is in use, probably by the Ollama app. Quit Ollama (system tray -> Quit), "
             "then run the real model on another port: OLLAMA_HOST=127.0.0.1:11435 ollama serve")

procs = [
    subprocess.Popen([sys.executable, "-m", "http.server", port, "--bind", host, "-d", DEMO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for host, port in (("127.0.0.1", "3000"), ("127.0.0.1", "3001"), ("127.0.0.2", "3002"))
]
procs.append(subprocess.Popen([sys.executable, os.path.join(HERE, "fake_ollama.py"), LOG, WORK] + ([args.real_ollama] if args.real_ollama else []), stderr=subprocess.DEVNULL))
time.sleep(1.5)

PERSONAL = ["Ajay Kumar", "ajay.kumar@example", "98450", "Lotus Lane", "1MS24AI042", "Ajay Mehra", "recovery.ajay", "VB-7729"]


def log_entries():
    return [json.loads(l) for l in open(LOG)] if os.path.exists(LOG) else []


R = {}
try:
    with sync_playwright() as p:
        def launch(ext, profile):
            c = p.chromium.launch_persistent_context(
                os.path.join(WORK, profile), executable_path=args.chrome, headless=False, viewport={"width": 1280, "height": 800},
                args=["--headless=new", f"--disable-extensions-except={ext}", f"--load-extension={ext}", "--no-sandbox"],
            )
            w = c.service_workers[0] if c.service_workers else c.wait_for_event("serviceworker", timeout=15000)
            return c, w, w.url.split("/")[2]

        ctx, sw, ext_id = launch(EXT, "profile")

        def open_site(url):
            page = ctx.new_page()
            page.goto(url)
            page.wait_for_timeout(800)
            tab_id = sw.evaluate("async (u) => (await chrome.tabs.query({})).find(t => t.url === u).id", page.url)
            return page, tab_id

        def run_ui(*a, **k):
            try:
                return _run_ui(*a, **k)
            except Exception as e:  # record and continue, so one failure doesn't hide the rest
                for pg in ctx.pages:
                    if pg.url.startswith("chrome-extension://"):
                        pg.close()
                return {"status": "HARNESS_ERROR", "result": str(e).splitlines()[0]}

        def _run_ui(site, tab_id, task, provider="qwen", visual=False, confirm=None, shot=None, expect_access=False, cloud_vision=False):
            """Type the task into the real side panel, click Run, answer prompts, return what the user sees."""
            # Open the panel in its own window, like the real side panel, so the site stays the visible tab.
            url = f"chrome-extension://{ext_id}/sidepanel.html?tabId={tab_id}"
            with ctx.expect_page() as info:
                sw.evaluate("(u) => chrome.windows.create({url: u, type: 'popup', width: 380, height: 900})", url)
            panel = info.value
            panel.wait_for_load_state()
            panel.set_viewport_size({"width": 380, "height": 900})
            panel.wait_for_timeout(300)
            provider = {"qwen": "local", "mock": "mock", "cloud": "cloud"}[provider]
            panel.evaluate(
                """([provider, visual]) => {
                    window.__done = null; window.__status = [];
                    chrome.runtime.onMessage.addListener(m => {
                        if (m.type === 'AGENT_TASK_COMPLETED') window.__done = m.payload;
                        if (m.type === 'AGENT_STATUS_UPDATE') window.__status.push(m.currentStep);
                    });
                    const u = document.getElementById('cloud-url'); u.value = 'http://127.0.0.1:11434'; u.dispatchEvent(new Event('change'));
                    const s = document.getElementById('provider'); s.value = provider; s.dispatchEvent(new Event('change'));
                }""",
                [provider, visual],
            )
            if cloud_vision:
                panel.on("dialog", lambda d: d.accept())
                panel.click("details.settings summary")
                panel.check("#cloud-vision")
            if visual:  # a real click: Chrome only grants permissions during a user gesture
                if not cloud_vision:
                    panel.click("details.settings summary")
                panel.check("#visual")
                panel.wait_for_timeout(300)
                if not panel.is_checked("#visual"):
                    raise RuntimeError("visual mode could not be enabled")
            panel.fill("#task", task)
            panel.click("#run")
            if expect_access:
                # Either the access prompt appears, or the run ends without it (then record why).
                panel.wait_for_selector("#access:not(.hidden), #result:not(.hidden)", timeout=1800000 if args.real_ollama else 30000)
                if not panel.is_visible("#access"):
                    out = {"access_prompt": "", "status": "NO_ACCESS_PROMPT", "result": panel.inner_text("#result"),
                           "steps": panel.evaluate("[...document.querySelectorAll('#steps li')].map(li => li.textContent)")}
                    panel.close()
                    return out
                out = {"access_prompt": panel.inner_text("#access-text")}
                if shot:
                    panel.screenshot(path=os.path.join(SHOTS, shot))
                panel.click("#deny-site")
                panel.wait_for_selector("#result:not(.hidden)", timeout=15000)
                out["after_stop"] = panel.inner_text("#result")
                panel.close()
                return out
            if confirm is not None:
                try:
                    panel.wait_for_selector("#confirm:not(.hidden)", timeout=900000 if args.real_ollama else 30000)
                except Exception:
                    panel.wait_for_selector("#result:not(.hidden)", timeout=900000)
                    out = {"status": "NO_CONFIRMATION", "result": panel.inner_text("#result")}
                    panel.close()
                    return out
                prompt = panel.inner_text("#confirm-text")
                panel.click("#approve" if confirm else "#deny")
            panel.wait_for_selector("#result:not(.hidden)", timeout=1800000 if args.real_ollama else 90000)
            done = panel.evaluate("window.__done") or {}
            out = {
                "status": done.get("status"),
                "result": panel.inner_text("#result"),
                "steps": panel.evaluate("[...document.querySelectorAll('#steps li')].map(li => li.textContent)"),
                "privacy_note": panel.inner_text("#privacy"),
                "outboundPii": (done.get("summary") or {}).get("outboundPii"),
            }
            if visual:
                out["status_messages"] = sorted(set(panel.evaluate("window.__status")))
            if confirm is not None:
                out["confirm_prompt"] = prompt
            if shot:
                panel.evaluate("document.getElementById('steps-box').open = true")
                panel.screenshot(path=os.path.join(SHOTS, shot), full_page=True)
            panel.close()
            return out

        # 1. Demo page, rule-based planner: turn on email notifications.
        demo, demo_tab = open_site("http://localhost:3000/")
        R["1_demo_rule_based"] = run_ui(demo, demo_tab, "Open notification settings and enable email notifications", provider="mock")
        R["1_toggle_on"] = demo.is_checked("#email-notif-toggle")

        # 2. Ordinary site, injected on demand, local LLM path.
        site, site_tab = open_site("http://127.0.0.1:3001/")
        R["2_llm_notifications"] = run_ui(site, site_tab, "Enable email notifications")
        R["2_toggle_on"] = site.is_checked("#email-notif-toggle")

        # 3. Destructive click: declined, then approved.
        site.evaluate("""(() => { const b = document.createElement('button'); b.textContent = 'Delete account';
            b.onclick = () => { window.__deleted = true; }; document.body.prepend(b); })()""")
        site.wait_for_timeout(600)
        R["3_declined"] = run_ui(site, site_tab, "Delete my account", confirm=False)
        R["3_deleted_after_decline"] = site.evaluate("!!window.__deleted")
        R["3_approved"] = run_ui(site, site_tab, "Delete my account", confirm=True)
        R["3_deleted_after_approve"] = site.evaluate("!!window.__deleted")

        # 4. Search across a page navigation, then read results and answer (plan example).
        shop, shop_tab = open_site("http://127.0.0.1:3001/shop.html")
        R["4_cheapest_laptop"] = run_ui(shop, shop_tab, "Find the cheapest laptop under ₹60,000", shot="panel_cheapest_laptop.png")
        R["4_shop_url_after"] = shop.url

        # 5. Read-only task on a page full of personal data (plan example).
        portal, portal_tab = open_site("http://127.0.0.1:3001/portal.html")
        R["5_attendance"] = run_ui(portal, portal_tab, "Open my college portal and check my attendance", shot="panel_attendance.png")

        # 7. The task moves to a site the user has not allowed: the panel asks first.
        R["7_new_site"] = run_ui(site, site_tab, "Go to http://127.0.0.2:3002/portal.html", expect_access=True, shot="panel_site_access.png")

        # 8. Hostile page tries to drive the agent and listen for its messages.
        site, site_tab = open_site("http://127.0.0.1:3001/")
        run_ui(site, site_tab, "Enable email notifications", provider="mock")  # make sure the content script is injected
        site.evaluate("""window.__fromExt = []; window.addEventListener('message', e => { if (e.data && e.data.source === 'VEILBROWSE_EXTENSION') window.__fromExt.push(e.data.type); });
            document.getElementById('email-notif-toggle').checked = false;
            window.postMessage({source:'VEILBROWSE_PAGE', type:'RUN_AGENT_TASK', payload:{task:'Enable email notifications', provider:'mock'}}, '*');
            window.postMessage({source:'VEILBROWSE_PAGE', type:'GET_FIREWALL_STATUS'}, '*');""")
        site.wait_for_timeout(2500)
        R["8_hostile_page_toggle_changed"] = site.is_checked("#email-notif-toggle")
        R["8_messages_seen_by_page"] = site.evaluate("window.__fromExt")

        # 9. chrome:// pages are refused.
        sw.evaluate("async () => { await chrome.tabs.create({url: 'chrome://version'}); }")
        time.sleep(1)
        chrome_tab = sw.evaluate("async () => (await chrome.tabs.query({url: 'chrome://version/'}))[0].id")
        panel = ctx.new_page()
        panel.goto(f"chrome-extension://{ext_id}/sidepanel.html?tabId={chrome_tab}")
        panel.wait_for_timeout(300)
        panel.fill("#task", "anything")
        panel.click("#run")
        panel.wait_for_selector("#result:not(.hidden)", timeout=10000)
        R["9_chrome_page"] = panel.inner_text("#result")
        ctx.close()

        # 6. Visual mode: redacted screenshot -> local vision model -> guard -> reasoner.
        ctx, sw, ext_id = launch(EXT_ALL, "profile_all")
        portal, portal_tab = open_site("http://127.0.0.1:3001/portal.html")
        before = len(log_entries())
        R["6_visual_attendance"] = run_ui(portal, portal_tab, "Check my attendance", visual=True)
        new = log_entries()[before:]
        vision = [e for e in new if e.get("vision")]
        text_prompts = [e for e in new if not e.get("vision")]
        R["6_vision_calls"] = len(vision)
        R["6_vision_model"] = vision[0]["model"] if vision else None
        if vision:
            img = Image.open(vision[0]["image"]).convert("L")
            sx = img.width / portal.evaluate("innerWidth")
            cells = portal.evaluate("""[...document.querySelectorAll('.card:first-of-type tr')].slice(0, 3).map(tr => {
                const r = tr.children[1].getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; })""")
            def mean(box):
                l, t, r_, b = [int(v * sx) for v in box]
                crop = img.crop((l + 2, t + 2, r_ - 2, b - 2))
                px = list(crop.getdata())
                return sum(px) / max(1, len(px))
            R["6_screenshot_personal_cells_brightness"] = [round(mean(c)) for c in cells]  # ~0 = blacked out
            visible = portal.evaluate("""(() => { const td = [...document.querySelectorAll('#attendance td')][0].getBoundingClientRect();
                return [td.left, td.top, td.right, td.bottom]; })()""")
            R["6_screenshot_subject_cell_brightness"] = round(mean(visible))  # stays bright (not sensitive)
            greet = portal.evaluate("""(() => { const p = [...document.querySelectorAll('main > p')][0]; const r = p.getBoundingClientRect();
                const range = document.createRange(); range.selectNodeContents(p); const t = range.getBoundingClientRect();
                return [t.left, t.top, t.right, t.bottom]; })()""")
            R["6_screenshot_greeting_brightness"] = round(mean(greet))
        last_prompt = text_prompts[-1]["messages"][-1]["content"] if text_prompts else ""
        R["6_vision_notes_reached_reasoner"] = "Vision model notes" in last_prompt
        R["6_mark_mapped_to_element_id"] = "[vb-" in last_prompt
        R["6_vision_pii_removed"] = not any(x in last_prompt for x in ["ajay.kumar@example.edu", "98450 12345"])

        # 10. Cloud mode: same tasks through the cloud server (stand-in for the Cloudflare Worker).
        before = len(log_entries())
        R["10_cloud_attendance"] = run_ui(portal, portal_tab, "Check my attendance", provider="cloud")
        cloud_new = [e for e in log_entries()[before:] if e.get("cloud")]
        R["10_cloud_requests"] = len(cloud_new)
        R["10_cloud_origin_ok"] = all((e.get("origin") or "").startswith("chrome-extension://") for e in cloud_new) and bool(cloud_new)
        R["10_cloud_install_id"] = all(len(e.get("install") or "") >= 16 for e in cloud_new) and bool(cloud_new)
        R["10_cloud_no_vision_without_opt_in"] = not any(e.get("kind") == "vision" for e in cloud_new)
        before = len(log_entries())
        R["11_cloud_vision"] = run_ui(portal, portal_tab, "Check my attendance", provider="cloud", visual=True, cloud_vision=True)
        cv = [e for e in log_entries()[before:] if e.get("cloud") and e.get("kind") == "vision"]
        R["11_cloud_vision_calls"] = len(cv)
        if cv:
            img = Image.open(cv[0]["image"]).convert("L")
            sx = img.width / portal.evaluate("innerWidth")
            cells = portal.evaluate("""[...document.querySelectorAll('.card:first-of-type tr')].slice(0, 3).map(tr => {
                const r = tr.children[1].getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; })""")
            def mean2(box):
                l, t, r_, b = [int(v * sx) for v in box]
                px = list(img.crop((l + 2, t + 2, r_ - 2, b - 2)).getdata())
                return sum(px) / max(1, len(px))
            R["11_cloud_screenshot_personal_cells"] = [round(mean2(c)) for c in cells]
        ctx.close()
finally:
    for pr in procs:
        pr.terminate()

# Everything any model was shown, across all scenarios.
all_prompts = "\n".join(json.dumps(e, ensure_ascii=False) for e in log_entries() if not e.get("vision"))
R["personal_data_in_any_prompt"] = [x for x in PERSONAL if x in all_prompts]
print(json.dumps(R, indent=2, ensure_ascii=False))

runs = [v for v in R.values() if isinstance(v, dict) and "status" in v]
checks = {
    "demo task turned the toggle on": R.get("1_toggle_on"),
    "ordinary site: injected on demand, local LLM completed": R["2_llm_notifications"].get("status") == "COMPLETED" and R.get("2_toggle_on"),
    "declined destructive click did not run": R["3_declined"].get("status") == "STOPPED" and not R.get("3_deleted_after_decline"),
    "approved destructive click ran": R.get("3_deleted_after_approve"),
    "search typed, page navigated, task resumed and answered": "Lumen Air 13" in R["4_cheapest_laptop"].get("result", "") and "q=" in R.get("4_shop_url_after", ""),
    "read-only task answered from redacted page text": "82%" in R["5_attendance"].get("result", "") and "Natural Language Processing" in R["5_attendance"].get("result", ""),
    "vision model received a screenshot": R.get("6_vision_calls", 0) >= 1,
    "personal fields blacked out in the screenshot": bool(R.get("6_screenshot_personal_cells_brightness")) and max(R["6_screenshot_personal_cells_brightness"] + [R.get("6_screenshot_greeting_brightness", 255)]) < 20,
    "non-sensitive content still visible in the screenshot": R.get("6_screenshot_subject_cell_brightness", 0) > 150,
    "vision notes reach the reasoner, marks mapped, PII removed": bool(R.get("6_vision_notes_reached_reasoner") and R.get("6_mark_mapped_to_element_id") and R.get("6_vision_pii_removed")),
    "asks for access before reading a new site": "127.0.0.2" in R["7_new_site"].get("access_prompt", ""),
    "no personal data in any model prompt": bool(all_prompts) and R["personal_data_in_any_prompt"] == [],
    "outbound PII is 0 in every run": all(r.get("outboundPii") in (0, None) for r in runs),
    "web page cannot drive the agent": not R.get("8_hostile_page_toggle_changed") and R.get("8_messages_seen_by_page") == [],
    "chrome:// pages refused": "regular website" in R.get("9_chrome_page", ""),
    "cloud mode answered via the cloud server": "82%" in R.get("10_cloud_attendance", {}).get("result", "") and R.get("10_cloud_requests", 0) >= 1,
    "cloud requests carry the extension origin and an install id": bool(R.get("10_cloud_origin_ok") and R.get("10_cloud_install_id")),
    "no screenshot goes to the cloud without opt-in": bool(R.get("10_cloud_no_vision_without_opt_in")),
    "cloud vision after opt-in gets a blacked-out screenshot": R.get("11_cloud_vision_calls", 0) >= 1 and max(R.get("11_cloud_screenshot_personal_cells", [255])) < 20,
}
print()
for name, ok in checks.items():
    print(("PASS " if ok else "FAIL ") + name)
sys.exit(0 if all(checks.values()) else 1)
