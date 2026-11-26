"""Stand-in for Ollama's /api/chat used by the e2e test.

Text requests (reasoning): scripted decisions that depend on the task and on the page text,
so the test exercises TYPE, navigation, page reading and answering.
Image requests (vision): saves the received screenshot and replies with notes that
deliberately contain personal data and a box number, to check the guard and mark mapping.
Every request is logged so the test can check what the models were shown.
"""
import base64, json, os, re, sys, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

LOG = open(sys.argv[1], "a")
SHOTS = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(sys.argv[1])
# Proxy mode: forward to a real Ollama (e.g. http://127.0.0.1:11435) and only log.
UPSTREAM = sys.argv[3] if len(sys.argv) > 3 else None


def forward(raw):
    req = urllib.request.Request(UPSTREAM + "/api/chat", data=raw, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())["message"]["content"]


def section(text, name):
    m = re.search(name + r":\n(.*?)(?:\n\n[A-Z][^\n]*:\n|\n\nNext step|$)", text, re.S)
    return m.group(1) if m else ""


def decide(user):
    task = re.search(r'User task: "(.*?)"', user).group(1).lower()
    history = section(user, "Actions taken so far")
    els = json.loads(section(user, "Interactive elements"))
    text = section(user, "Visible page text")
    allowed = [e for e in els if e["decision"] == "ALLOWED"]
    find = lambda w: next((e for e in allowed if w in (e.get("label") or "").lower()), None)

    if "cheapest" in task:
        if "TYPE" not in history:
            return {"action": "TYPE", "targetId": find("search")["id"], "text": "laptop", "submit": True}
        lines = text.split("\n")
        items = []
        for i, line in enumerate(lines):
            m = re.match(r"₹([\d,]+)$", line.strip())
            if m and i > 0:
                items.append((int(m.group(1).replace(",", "")), lines[i - 1].strip()))
        under = sorted(p for p in items if p[0] < 60000)
        name = under[0][1] if under else "nothing"
        return {"done": True, "summary": f"The cheapest laptop under ₹60,000 is {name} at ₹{under[0][0]:,}." if under else "No laptop under ₹60,000."}
    if "attendance" in task:
        overall = re.search(r"Overall attendance: (\d+%)", text)
        low = [l.split(" | ")[0] for l in text.split("\n") if re.search(r"\| (\d+)%$", l) and int(re.search(r"(\d+)%$", l).group(1)) < 75]
        return {"done": True, "summary": f"Your overall attendance is {overall.group(1)}. Below 75%: {', '.join(low) or 'none'}."}
    url = re.search(r"https?://\S+", task)
    if url and "go to" in task and "-> EXECUTED" not in history:
        return {"action": "NAVIGATE", "url": url.group(0)}
    if "-> EXECUTED" in history:
        return {"done": True, "summary": "Finished the requested step."}
    want = "delete" if "delete" in task else "email notifications"
    return {"action": "CLICK", "targetId": find(want)["id"]}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        body = json.loads(raw)
        msg = body["messages"][-1]
        if UPSTREAM:
            if msg.get("images"):
                n = len([f for f in os.listdir(SHOTS) if f.startswith("vision_")])
                path = os.path.join(SHOTS, f"vision_{n}.jpg")
                open(path, "wb").write(base64.b64decode(msg["images"][0]))
            content = forward(raw)
            entry = {"vision": True, "model": body["model"], "image": path} if msg.get("images") else dict(body)
            entry["reply"] = content
            LOG.write(json.dumps(entry) + "\n")
        elif msg.get("images"):
            n = len([f for f in os.listdir(SHOTS) if f.startswith("vision_")])
            path = os.path.join(SHOTS, f"vision_{n}.jpg")
            open(path, "wb").write(base64.b64decode(msg["images"][0]))
            LOG.write(json.dumps({"vision": True, "model": body["model"], "image": path}) + "\n")
            content = ("A student portal dashboard. The search or navigation link [1] is at the top. "
                       "The profile card shows ajay.kumar@example.edu and phone 98450 12345.")
        else:
            LOG.write(json.dumps(body) + "\n")
            try:
                content = json.dumps(decide(msg["content"]))
            except Exception as e:  # make failures visible in the run
                content = json.dumps({"done": True, "summary": f"FAKE MODEL ERROR: {e}"})
        LOG.flush()
        out = json.dumps({"message": {"role": "assistant", "content": content}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(out)


HTTPServer(("127.0.0.1", 11434), H).serve_forever()
