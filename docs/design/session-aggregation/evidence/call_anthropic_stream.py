"""Minimal Anthropic Messages streaming client (no SDK, no secret printing)."""
import json, os, re, sys, time
import requests

def get_key(name):
    v = os.environ.get(name)
    if v:
        return v
    cred = open(os.path.expanduser("~/.dsh/.credentials.yaml"), encoding="utf-8").read()
    m = re.search(r"(?m)^\s*" + re.escape(name) + r"\s*:\s*'?([^'\r\n]+)'?\s*$", cred)
    if not m:
        raise SystemExit("credential not found: " + name)
    return m.group(1).strip()

def main():
    base, model, prompt_file, out_file, max_tokens, key_name = sys.argv[1:7]
    prompt = open(prompt_file, encoding="utf-8").read()
    body = {
        "model": model,
        "max_tokens": int(max_tokens),
        "messages": [{"role": "user", "content": prompt}],
        "stream": True,
    }
    headers = {
        "x-api-key": get_key(key_name),
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    started = time.time()
    text = []
    usage = {}
    with requests.post(base.rstrip("/") + "/v1/messages", headers=headers, json=body,
                       stream=True, timeout=(30, 900)) as r:
        if r.status_code != 200:
            print("HTTP", r.status_code, r.text[:500])
            raise SystemExit(1)
        r.encoding = "utf-8"
        for raw in r.iter_lines(decode_unicode=False):
            if not raw:
                continue
            line = raw.decode("utf-8", "replace")
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if not data or data == "[DONE]":
                continue
            try:
                ev = json.loads(data)
            except Exception:
                continue
            t = ev.get("type")
            if t == "content_block_delta":
                d = ev.get("delta") or {}
                if d.get("type") == "text_delta":
                    text.append(d.get("text", ""))
            elif t == "message_delta":
                usage.update(ev.get("usage") or {})
            elif t == "message_start":
                usage.update((ev.get("message") or {}).get("usage") or {})
    content = "".join(text)
    open(out_file, "w", encoding="utf-8").write(content)
    print("OK model=%s chars=%d usage=%s elapsed=%.1fs out=%s" % (
        model, len(content), json.dumps(usage, ensure_ascii=False), time.time() - started, out_file))

if __name__ == "__main__":
    main()
