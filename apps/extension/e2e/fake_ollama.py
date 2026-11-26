# Stand-in for Ollama's /api/chat: picks the element whose label mentions "email notifications",
# then reports done. Logs every prompt so the test can check no PII was sent.
import json, re, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
LOG = open(sys.argv[1], "a")
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        user = body["messages"][-1]["content"]
        LOG.write(json.dumps(body) + "\n"); LOG.flush()
        if "-> EXECUTED" in user:
            reply = {"done": True, "summary": "Finished the requested step."}
        else:
            els = json.loads(user.split("Current sanitized page elements:\n", 1)[1].split("\n\nNext step", 1)[0])
            want = "delete" if "delete" in user.lower().split("actions taken")[0] else "email notifications"
            target = next(e for e in els if want in (e.get("label") or "").lower() and e["decision"] == "ALLOWED")
            reply = {"action": "CLICK", "targetId": target["id"]}
        out = json.dumps({"message": {"role": "assistant", "content": json.dumps(reply)}}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(out)
HTTPServer(("127.0.0.1", 11434), H).serve_forever()
