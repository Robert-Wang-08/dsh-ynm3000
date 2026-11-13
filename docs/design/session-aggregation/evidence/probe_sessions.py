"""Read-only probe of local agent session stores. Prints schemas/samples only."""
import json, os, sqlite3, subprocess, sys, tempfile, collections

HOME = os.path.expanduser("~")
out = []

def say(*a):
    s = " ".join(str(x) for x in a)
    out.append(s)
    print(s)

def head(s, n=500):
    s = str(s).replace("\n", "\\n")
    return s[:n]

def sample_jsonl(path, n=400, label=""):
    types = collections.Counter()
    examples = {}
    first = None
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for i, line in enumerate(fh):
            if i >= n:
                break
            try:
                r = json.loads(line)
            except Exception:
                continue
            if first is None:
                first = r
            t = r.get("type") or r.get("kind") or "?"
            types[t] += 1
            if t not in examples:
                examples[t] = head(json.dumps(r, ensure_ascii=False), 420)
    say(f"--- {label} types: {dict(types)}")
    if first is not None:
        say("first:", head(json.dumps(first, ensure_ascii=False), 700))
    for t, ex in list(examples.items())[:8]:
        say(f"  [{t}] {ex}")

def sqlite_schema(path, label, only=None):
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        cur = con.cursor()
        rows = cur.execute("select name, type from sqlite_master where type in ('table','view') order by name").fetchall()
        say(f"--- {label} tables: {[r[0] for r in rows]}")
        for name, typ in rows:
            if only and not any(k in name.lower() for k in only):
                continue
            cols = cur.execute(f"pragma table_info('{name}')").fetchall()
            say(f"  {name}: " + ", ".join(f"{c[1]}:{c[2]}" for c in cols))
        con.close()
    except Exception as e:
        say(f"--- {label} ERROR {e}")

def sqlite_query(path, label, q, limit=5):
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        rows = con.execute(q).fetchmany(limit)
        say(f"--- {label} query rows={len(rows)}")
        for r in rows:
            say("   ", head(json.dumps(r, ensure_ascii=False, default=str), 500))
        con.close()
    except Exception as e:
        say(f"--- {label} ERROR {e}")

zstd = r"D:\miniforge3\envs\transformers-env\Library\bin\zstd.exe"
dsh_root = os.path.join(HOME, ".dsh", "sessions")
# pick a recent small-ish DSH session
cands = []
for dp, dn, fn in os.walk(dsh_root):
    for f in fn:
        if f.startswith("session") and ".jsonl" in f:
            p = os.path.join(dp, f)
            cands.append((os.path.getmtime(p), os.path.getsize(p), p))
cands.sort(reverse=True)
say("DSH session files:", len(cands), "recent:", cands[:3])
if cands:
    p = cands[0][2]
    tmp = os.path.join(tempfile.gettempdir(), "dsh_probe.jsonl")
    r = subprocess.run([zstd, "-d", "-f", "-q", "-o", tmp, p], capture_output=True)
    if r.returncode == 0:
        sample_jsonl(tmp, 600, "DSH " + os.path.basename(p))
        os.remove(tmp)
    else:
        say("DSH decompress error", r.stderr[:300])

# Codex
codex = []
for dp, dn, fn in os.walk(os.path.join(HOME, ".codex", "sessions")):
    for f in fn:
        if f.endswith(".jsonl"):
            p = os.path.join(dp, f)
            codex.append((os.path.getmtime(p), os.path.getsize(p), p))
codex.sort(reverse=True)
say("Codex rollout files:", len(codex), "recent:", codex[:3])
if codex:
    sample_jsonl(codex[0][2], 300, "Codex " + os.path.basename(codex[0][2]))

# Claude
claude = []
for dp, dn, fn in os.walk(os.path.join(HOME, ".claude", "projects")):
    for f in fn:
        if f.endswith(".jsonl"):
            p = os.path.join(dp, f)
            claude.append((os.path.getmtime(p), os.path.getsize(p), p))
claude.sort(reverse=True)
say("Claude jsonl files:", len(claude), "recent:", claude[:3])
if claude:
    sample_jsonl(claude[0][2], 300, "Claude " + os.path.basename(claude[0][2]))

# Cursor CLI chat store
cursor_chats = os.path.join(HOME, ".cursor", "chats")
db = None
for dp, dn, fn in os.walk(cursor_chats):
    for f in fn:
        if f == "store.db":
            p = os.path.join(dp, f)
            if not db or os.path.getsize(p) > os.path.getsize(db):
                db = p
say("Cursor chat store:", db)
if db:
    d = os.path.dirname(db)
    for f in ("meta.json", "prompt_history.json"):
        fp = os.path.join(d, f)
        if os.path.exists(fp):
            say(f"  {f}:", head(open(fp, encoding="utf-8", errors="replace").read(), 600))
    sqlite_schema(db, "Cursor chat store")

# Cursor IDE workspace storage
wsroot = os.path.join(HOME, "AppData", "Roaming", "Cursor", "User", "workspaceStorage")
wss = []
for d in os.listdir(wsroot) if os.path.isdir(wsroot) else []:
    p = os.path.join(wsroot, d, "state.vscdb")
    if os.path.exists(p):
        wss.append((os.path.getmtime(p), os.path.getsize(p), p))
wss.sort(reverse=True)
say("Cursor workspaceStorage DBs:", len(wss), "recent:", [(w[1], w[2]) for w in wss[:3]])
if wss:
    p = wss[0][2]
    sqlite_schema(p, "Cursor state.vscdb", only=["item", "cursor", "composer", "chat"])
    sqlite_query(p, "Cursor itemTable keys", "select key, length(value) from ItemTable order by length(value) desc limit 15")
    sqlite_query(p, "Cursor composer keys", "select key, substr(value,1,200) from ItemTable where key like '%composer%' or key like '%chat%' limit 10")

# OpenCode
oc = os.path.join(HOME, ".local", "share", "opencode", "opencode.db")
if os.path.exists(oc):
    say("OpenCode DB size:", os.path.getsize(oc))
    sqlite_schema(oc, "OpenCode")
    sqlite_query(oc, "OpenCode session sample", "select * from session limit 3")
    sqlite_query(oc, "OpenCode message sample", "select * from message limit 3")
else:
    say("OpenCode DB missing")

dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), "session-probe.txt")
with open(dest, "w", encoding="utf-8") as fh:
    fh.write("\n".join(out))
print("WROTE", dest)
