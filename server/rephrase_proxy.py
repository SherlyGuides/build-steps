#!/usr/bin/env python3
"""Build Steps: instruction rephrasing proxy (Google Gemini).

The phone app sends one step's instruction (plus its parts, grade and step type) here; this
service asks Gemini for three rewrites and returns them. It exists so the API key stays on the
server and never appears in the public web app. Python standard library only.

    POST /rephrase   {"instruction", "parts": [{"name", "qty"}], "move", "grade", "step"}
                  -> {"suggestions": [{"label", "text"}, ...]}
    GET  /health  -> {"ok": true}

Run:  GEMINI_API_KEY=... python3 rephrase_proxy.py --port 8787
It listens on 127.0.0.1 only; Caddy in front of it provides HTTPS (see server/README.md).
"""

from __future__ import annotations

import argparse
import json
import os
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# =============================================================================
# SETTINGS
# =============================================================================

# Tried in order: the second is used when the first times out or is overloaded.
MODELS = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest"]
TIMEOUT_SECONDS = 20
API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

# Only the published app (and local development) may call this service.
ALLOWED_ORIGINS = {
    "https://sherlyguides.github.io",
    "http://localhost:5199",
    "http://localhost:5197",
}

MAX_INSTRUCTION_CHARS = 300
MAX_PARTS = 20
MAX_PART_NAME_CHARS = 120
MAX_BODY_BYTES = 8_000

# Abuse limits, kept in memory (reset when the service restarts). The Gemini free tier
# has its own daily limit as well.
PER_IP_PER_HOUR = 120
ALL_PER_DAY = 1_000

SYSTEM_PROMPT = """You rewrite build-instruction sentences for ThinkPro Academy PowerPoint decks. Each slide shows one step of building a model from a construction kit (bricks, plates, Technic parts, wheels, gears, motors): the instruction appears as one highlighted line above a photo of the step.

House style for an instruction:
- One sentence, an instruction to the student, starting with a verb such as Take, Fix, Attach, Push, Slide, Place, Connect, Turn or Flip.
- Use the parts from the parts list you are given, with their sizes such as "1 x 4". You may put a part name in natural English order ("Brick 1 x 4" -> "1 x 4 brick", "Technic, Brick 1 x 2 with Holes" -> "1 x 2 Technic brick with holes") but keep its words and sizes. Never invent parts, sizes or colours that are not in the list or the original text.
- Keep every fact from the original: which parts, how many, and where they go. Do not add steps or advice.
- Correct plurals ("2 Technic Bushes"). Plain words a child in the given grade can read. At most 20 words. No ending full stop, no emoji, no quotation marks.

Return exactly three suggestions:
1. label "Corrected": the original with spelling, grammar and part names fixed, wording otherwise unchanged.
2. label "Clearer": reworded so a student understands it at a glance.
3. label "Shorter": the shortest version that keeps every fact.
If the original is empty, write three different instructions from the parts and step type instead, labelled "Suggestion 1", "Suggestion 2" and "Suggestion 3"."""

RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "suggestions": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {"label": {"type": "STRING"}, "text": {"type": "STRING"}},
                "required": ["label", "text"],
            },
        }
    },
    "required": ["suggestions"],
}

# =============================================================================

API_KEY = os.environ.get("GEMINI_API_KEY", "")

_lock = threading.Lock()
_per_ip: dict[str, deque] = defaultdict(deque)
_today = {"day": "", "count": 0}


class AIError(Exception):
    """Something went wrong asking the model; the message is shown to the user."""


def allow(ip: str) -> str | None:
    """None when the request may go ahead, otherwise the reason it may not."""
    now = time.time()
    day = time.strftime("%Y-%m-%d", time.gmtime(now))
    with _lock:
        if _today["day"] != day:
            _today.update(day=day, count=0)
        if _today["count"] >= ALL_PER_DAY:
            return "The daily limit for suggestions has been reached. Try again tomorrow."
        recent = _per_ip[ip]
        while recent and now - recent[0] > 3600:
            recent.popleft()
        if len(recent) >= PER_IP_PER_HOUR:
            return "Too many suggestions from this phone in the last hour. Try again later."
        recent.append(now)
        _today["count"] += 1
    return None


def clean(value, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def build_request(body: dict) -> str:
    instruction = clean(body.get("instruction"), MAX_INSTRUCTION_CHARS)
    parts = []
    for part in (body.get("parts") or [])[:MAX_PARTS]:
        if not isinstance(part, dict):
            continue
        name = clean(part.get("name"), MAX_PART_NAME_CHARS)
        qty = part.get("qty") if isinstance(part.get("qty"), int) and 0 < part.get("qty") < 1000 else 1
        if name:
            parts.append(f"- {name} (quantity {qty})")
    move = {"flip": "The assembly is flipped upside down; no part is added.",
            "turn": "The assembly is turned around; no part is added."}.get(body.get("move"), "")
    grade = body.get("grade") if isinstance(body.get("grade"), int) and 1 <= body.get("grade") <= 12 else None
    lines = [
        f"Grade: {grade}" if grade else "Grade: not given",
        f"Step number: {body['step']}" if isinstance(body.get("step"), int) else "",
        "Parts used in this step:\n" + "\n".join(parts) if parts else "Parts used in this step: none listed",
        move,
        f"Original instruction: {instruction}" if instruction else "Original instruction: (empty)",
    ]
    return "\n".join(line for line in lines if line)


def ask_gemini(model: str, prompt: str) -> list[dict]:
    payload = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": RESPONSE_SCHEMA,
            "temperature": 0.3,
            "maxOutputTokens": 500,
            "thinkingConfig": {"thinkingLevel": "minimal"},
        },
    }
    request = urllib.request.Request(
        API_URL.format(model=model), data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": API_KEY},
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        data = json.load(response)
    candidate = (data.get("candidates") or [{}])[0]
    text = "".join(part.get("text", "") for part in (candidate.get("content") or {}).get("parts", []))
    if not text:
        raise AIError("No suggestions came back for this instruction.")
    return json.loads(text).get("suggestions") or []


def suggest(body: dict) -> list[dict]:
    prompt = build_request(body)
    last_error = None
    for model in MODELS:
        try:
            raw = ask_gemini(model, prompt)
            break
        except urllib.error.HTTPError as error:
            detail = error.read()[:300].decode(errors="replace")
            print(f"Gemini {model} HTTP {error.code}: {detail}", flush=True)
            if error.code == 429:
                last_error = AIError("The free AI limit was reached for now. Try again in a minute.")
            elif error.code >= 500:
                last_error = AIError("The AI is busy. Try again in a minute.")
            else:
                raise AIError("The AI could not answer right now. Try again.") from error
        except (TimeoutError, urllib.error.URLError) as error:
            print(f"Gemini {model} unreachable: {error}", flush=True)
            last_error = AIError("The AI took too long to answer. Try again.")
        except (ValueError, KeyError) as error:
            print(f"Gemini {model} bad answer: {error}", flush=True)
            last_error = AIError("The AI gave an unreadable answer. Try again.")
    else:
        raise last_error or AIError("The AI could not answer right now. Try again.")

    seen, out = set(), []
    for item in raw[:3]:
        if not isinstance(item, dict):
            continue
        text = clean(item.get("text"), MAX_INSTRUCTION_CHARS).strip("\"'").rstrip(".")
        if text and text.lower() not in seen:
            seen.add(text.lower())
            out.append({"label": clean(item.get("label"), 30) or "Suggestion", "text": text})
    if not out:
        raise AIError("No suggestions came back for this instruction.")
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "BuildStepsAI/1"

    def cors(self) -> None:
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "86400")

    def reply(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def client_ip(self) -> str:
        # Caddy sets X-Forwarded-For; the service itself only listens on 127.0.0.1.
        return (self.headers.get("X-Forwarded-For") or self.client_address[0]).split(",")[0].strip()

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"ok": True, "model": MODELS[0], "key": bool(API_KEY)})
        self.reply(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/rephrase":
            return self.reply(404, {"error": "Not found"})
        if self.headers.get("Origin", "") not in ALLOWED_ORIGINS:
            return self.reply(403, {"error": "This service only answers the Build Steps app."})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BODY_BYTES:
            return self.reply(413, {"error": "Request too large."})
        try:
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError
        except ValueError:
            return self.reply(400, {"error": "Invalid request."})
        blocked = allow(self.client_ip())
        if blocked:
            return self.reply(429, {"error": blocked})
        try:
            return self.reply(200, {"suggestions": suggest(body)})
        except AIError as error:
            return self.reply(502, {"error": str(error)})

    def log_message(self, fmt, *args):
        # One line per request, without request bodies (no instructions are stored).
        print(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {self.client_ip()} {fmt % args}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    if not API_KEY:
        raise SystemExit("GEMINI_API_KEY is not set (see server/README.md).")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Build Steps AI proxy on http://{args.host}:{args.port} ({', '.join(MODELS)})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
