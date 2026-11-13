"""Second read-only probe: DSH event details, Cursor blobs/DiskKV, misc stores."""
import json, os, sqlite3, subprocess, tempfile, collections

HOME = os.path.expanduser("~")

def show(s, n=700):
    s = str(s).replace("\n", "\\n")
    print(s[:n])

def dsh():
    root = os.path.join(HOME, ".dsh", "sessions")
    cands = []
    for dp, dn, fn in os.walk(root):
        for f in fn:
            if f.startswith("session") and ".jsonl" in f:
                p = os.path.join(dp, f)
                cands.append((os.path.getsize(p), os.path.getmtime(p), p))
    cands.sort(reverse=True)
    # pick a medium session
    p = next((c[2] for c in cands if 100000 < c[0] < 800000), cands[0][2])
    zstd = r"D:\miniforge3\envs\transformers-env\Library\bin\zstd.exe"
    tmp = os.path.join(tempfile.gettempdir(), "dsh_probe2.jsonl")
    subprocess.run([zstd, "-d", "-f", "-q", "-o", tmp, p], check=True)
    seen = set()
    with open(tmp, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                r = json.loads(line)
            except Exception:
                continue
            t = r.get("type")
            if t in seen:
                continue
            # show interesting kinds
            if t in ("user/message", "assistant/message", "tool/call", "tool/result", "todo/write", "job/registered", "job/settled", "session/title", "turn/start", "step/end"):
                seen.add(t)
                print("=== DSH", t, "sec=", r.get("seq"), "time=", r.get("time"))
                show(json.dumps(r.get("data", r), ensure_ascii=False), 900)
    os.remove(tmp)

def cursor_blob():
    db = os.path.join(HOME, ".cursor", "chats", "3b974afc46beeef1f87524ba285eec44", "f72d58af-316c-4aae-95a1-37ecff3426ed", "store.db")
    con = sqlite3.connect("file:%s?mode=ro" % db.replace("\\", "/"), uri=True)
    print("=== Cursor chat meta", con.execute("select key,value from meta").fetchall())
    rows = con.execute("select id,length(data) from blobs order by length(data) desc limit 10").fetchall()
    print("blobs:", rows)
    for rid, ln in rows[:2]:
        data = con.execute("select data from blobs where id=?", (rid,)).fetchone()[0]
        print("id", rid, "type", type(data), "head", bytes(data[:120]))
        try:
            print("utf8:", data[:500].decode("utf-8", "replace"))
        except Exception:
            pass

def cursor_ide():
    root = os.path.join(HOME, "AppData", "Roaming", "Cursor", "User", "workspaceStorage")
    dbs = []
    for d in os.listdir(root):
        p = os.path.join(root, d, "state.vscdb")
        if os.path.exists(p):
            dbs.append((os.path.getsize(p), p))
    dbs.sort(reverse=True)
    print("=== Cursor IDE dbs:", dbs[:3])
    for size, p in dbs[:2]:
        con = sqlite3.connect("file:%s?mode=ro" % p.replace("\\", "/"), uri=True)
        try:
            print("DB", p, size)
            for q in [
                "select count(*) from composerHeaders",
                "select composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, substr(value,1,200) from composerHeaders order by lastUpdatedAt desc limit 3",
                "select key, length(value) from cursorDiskKV order by length(value) desc limit 8",
                "select key, substr(value,1,160) from cursorDiskKV where key like '%composerData%' or key like '%bubble%' limit 5",
            ]:
                try:
                    print("Q", q[:100])
                    for r in con.execute(q).fetchmany(5):
                        show(json.dumps(r, ensure_ascii=False, default=str), 500)
                except Exception as e:
                    print("ERR", e)
        finally:
            con.close()

def misc():
    print("=== ~/.claude/tasks")
    tasks = os.path.join(HOME, ".claude", "tasks")
    if os.path.isdir(tasks):
        for f in os.listdir(tasks)[:5]:
            print(" ", f)
    print("=== ~/.codex/sqlite")
    cd = os.path.join(HOME, ".codex", "sqlite")
    print(os.listdir(cd)[:10] if os.path.isdir(cd) else "missing")
    print("=== ~/.codex/archived_sessions")
    ad = os.path.join(HOME, ".codex", "archived_sessions")
    if os.path.isdir(ad):
        fs = []
        for dp, dn, fn in os.walk(ad):
            for f in fn:
                fs.append(os.path.join(dp, f))
        print("count", len(fs), "recent", fs[:3])
    print("=== DSH storages")
    sd = os.path.join(HOME, ".dsh", "storages")
    if os.path.isdir(sd):
        for f in os.listdir(sd)[:10]:
            print(" ", f)
    print("=== DSH archived sessions repo")
    ar = r"D:\src\dsh\dsh-archived-sessions"
    if os.path.isdir(ar):
        print(os.listdir(ar)[:10])

dsh()
cursor_blob()
cursor_ide()
misc()
