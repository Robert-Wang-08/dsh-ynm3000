"""Fourth probe: OpenCode parts, Cursor agent transcripts, DSH todo events."""
import json, os, sqlite3, sys, subprocess, tempfile, collections
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HOME = os.path.expanduser("~")

def show(s, n=500):
    print(str(s).replace("\n", "\\n")[:n])

# OpenCode parts
db = os.path.join(HOME, ".local", "share", "opencode", "opencode.db")
c = sqlite3.connect("file:%s?mode=ro" % db.replace("\\", "/"), uri=True)
print("=== OpenCode part types")
print(c.execute("select json_extract(data,'$.type') t, count(*) from part group by t order by 2 desc").fetchall())
print("=== OpenCode message roles")
print(c.execute("select json_extract(data,'$.role') r, count(*) from message group by r").fetchall())
for label, q in [
    ("text", "select data from part where json_extract(data,'$.type')='text' order by time_created desc limit 2"),
    ("tool", "select data from part where json_extract(data,'$.type')='tool' order by time_created desc limit 2"),
    ("reasoning", "select data from part where json_extract(data,'$.type')='reasoning' order by time_created desc limit 1"),
]:
    print("=== OpenCode", label)
    for r in c.execute(q):
        show(r[0], 700)
print("=== OpenCode todo statuses", c.execute("select status,count(*) from todo group by status").fetchall())
print("=== OpenCode session_message types", c.execute("select type,count(*) from session_message group by type order by 2 desc").fetchall())
print("=== OpenCode session_message sample")
for r in c.execute("select type, data from session_message order by time_created desc limit 5"):
    show(r, 500)
c.close()

# Cursor agent transcript
base = os.path.join(HOME, ".cursor", "projects", "d-nutstore-1-logseq", "agent-transcripts")
files = []
for dp, dn, fn in os.walk(base):
    for f in fn:
        if f.endswith(".jsonl"):
            files.append(os.path.join(dp, f))
files.sort(key=os.path.getmtime, reverse=True)
print("=== Cursor transcripts", len(files), files[:2])
if files:
    p = files[0]
    print("transcript", p, os.path.getsize(p))
    with open(p, encoding="utf-8", errors="replace") as fh:
        lines = [json.loads(x) for x in fh if x.strip()]
    print("records", len(lines), "types", collections.Counter(x.get("type") or x.get("role") for x in lines))
    for x in lines[:6]:
        show(json.dumps(x, ensure_ascii=False), 700)

# DSH todo/write + user/message
root = os.path.join(HOME, ".dsh", "sessions")
cands = []
for dp, dn, fn in os.walk(root):
    for f in fn:
        if f.startswith("session") and ".jsonl" in f:
            p = os.path.join(dp, f)
            cands.append((os.path.getsize(p), os.path.getmtime(p), p))
cands.sort(reverse=True)
zstd = r"D:\miniforge3\envs\transformers-env\Library\bin\zstd.exe"
found = 0
for size, mt, p in cands[:40]:
    tmp = os.path.join(tempfile.gettempdir(), "dsh_probe4.jsonl")
    subprocess.run([zstd, "-d", "-f", "-q", "-o", tmp, p], check=False)
    try:
        with open(tmp, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if r.get("type") == "todo/write":
                    print("=== DSH todo/write", os.path.basename(os.path.dirname(p)))
                    show(json.dumps(r, ensure_ascii=False), 800)
                    found += 1
                    break
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    if found >= 2:
        break
print("todo/write samples", found)
