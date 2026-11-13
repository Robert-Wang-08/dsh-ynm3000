"""Third read-only probe: Cursor chat graph, OpenCode content, Codex sqlite, misc."""
import json, os, sqlite3, collections, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOME = os.path.expanduser("~")

def show(s, n=500):
    s = str(s).replace("\n", "\\n")
    print(s[:n])

def ro(path):
    return sqlite3.connect("file:%s?mode=ro" % path.replace("\\", "/"), uri=True)

def cursor_chat():
    base = os.path.join(HOME, ".cursor", "chats", "3b974afc46beeef1f87524ba285eec44", "f72d58af-316c-4aae-95a1-37ecff3426ed")
    con = ro(os.path.join(base, "store.db"))
    meta = dict(con.execute("select key,value from meta").fetchall())
    print("=== Cursor meta", list(meta)[:5])
    decoded = {}
    for k, v in meta.items():
        try:
            decoded[k] = bytes.fromhex(v).decode("utf-8")
        except Exception:
            decoded[k] = str(v)
        print("meta", k, show(decoded[k], 300))
    root = json.loads(decoded.get("0", "{}")).get("latestRootBlobId")
    print("root", root)
    if root:
        row = con.execute("select data from blobs where id=?", (root,)).fetchone()
        if row:
            print("root blob len", len(row[0]))
            print(row[0][:1200].decode("utf-8", "replace"))
    # sample roles across blobs
    roles = collections.Counter()
    kinds = collections.Counter()
    n = 0
    for rid, data in con.execute("select id,data from blobs limit 300"):
        n += 1
        try:
            j = json.loads(data)
            roles[j.get("role", "?")] += 1
            for c in j.get("content", []):
                if isinstance(c, dict):
                    kinds[c.get("type", "?")] += 1
        except Exception:
            pass
    print("blobs sampled", n, "roles", roles, "content kinds", kinds)
    ph = os.path.join(base, "prompt_history.json")
    if os.path.exists(ph):
        print("prompt_history", open(ph, encoding="utf-8", errors="replace").read()[:500])
    con.close()

def opencode():
    db = os.path.join(HOME, ".local", "share", "opencode", "opencode.db")
    con = ro(db)
    print("=== OpenCode counts")
    for t in ("session", "session_v2", "message", "part", "session_message", "session_part", "todo", "event", "project"):
        try:
            print(t, con.execute("select count(*) from %s" % t).fetchone()[0])
        except Exception as e:
            print(t, "ERR", e)
    print("=== OpenCode part sample")
    for r in con.execute("select data from part order by time_created desc limit 8"):
        show(json.dumps(r, ensure_ascii=False, default=str), 700)
    print("=== OpenCode session_part sample")
    for r in con.execute("select * from session_part order by time_created desc limit 6"):
        show(json.dumps(r, ensure_ascii=False, default=str), 700)
    print("=== OpenCode session_message sample")
    for r in con.execute("select type, data from session_message order by time_created desc limit 4"):
        show(json.dumps(r, ensure_ascii=False, default=str), 600)
    print("=== OpenCode todo sample")
    for r in con.execute("select session_id, content, status, priority, position from todo order by time_updated desc limit 8"):
        show(json.dumps(r, ensure_ascii=False), 300)
    print("=== OpenCode event types")
    for r in con.execute("select type, count(*) from event group by type order by count(*) desc limit 15"):
        print(r)
    print("=== OpenCode projects")
    for r in con.execute("select id, worktree, name, time_updated from project order by time_updated desc limit 5"):
        show(json.dumps(r, ensure_ascii=False), 300)
    con.close()

def codex_sqlite():
    p = os.path.join(HOME, ".codex", "sqlite", "codex.db")
    con = ro(p)
    print("=== codex.db tables")
    for t, in con.execute("select name from sqlite_master where type='table' order by name"):
        try:
            cnt = con.execute("select count(*) from '%s'" % t).fetchone()[0]
        except Exception:
            cnt = "?"
        print(t, cnt)
    for t in ("threads", "thread", "turns", "items"):
        try:
            cols = con.execute("pragma table_info('%s')" % t).fetchall()
            print(t, [(c[1], c[2]) for c in cols])
            for r in con.execute("select * from '%s' limit 2" % t):
                show(json.dumps(r, ensure_ascii=False, default=str), 400)
        except Exception as e:
            pass
    con.close()

def claude_tasks():
    root = os.path.join(HOME, ".claude", "tasks")
    if not os.path.isdir(root):
        return
    for d in os.listdir(root)[:2]:
        p = os.path.join(root, d)
        print("=== claude task dir", d)
        for f in os.listdir(p)[:8]:
            fp = os.path.join(p, f)
            print(" ", f, os.path.getsize(fp) if os.path.isfile(fp) else "dir")
            if os.path.isfile(fp):
                print("   ", open(fp, encoding="utf-8", errors="replace").read()[:500])

def dsh_storages():
    root = os.path.join(HOME, ".dsh", "storages")
    for f in ("dsh_sessivra_tasks.json", "dsh_dashboard.json", "workspace.json"):
        p = os.path.join(root, f)
        if os.path.exists(p):
            print("=== DSH storage", f, os.path.getsize(p))
            print(open(p, encoding="utf-8", errors="replace").read()[:800])

cursor_chat()
opencode()
codex_sqlite()
claude_tasks()
dsh_storages()
