"""SQLite outbox: transactional dedupe, send leases, retries and explicit ambiguity."""
import json
import sqlite3
import time
from pathlib import Path
from common import digest

class Store:
    def __init__(self, directory):
        Path(directory).mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(Path(directory) / "health.sqlite"), timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS outbox(
          key TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, available REAL NOT NULL,
          lease REAL, message_id TEXT, error TEXT, created REAL NOT NULL, accepted REAL);
        """)
        self.db.commit()

    def get(self,key,default=None):
        row = self.db.execute("SELECT value FROM kv WHERE key=?",(key,)).fetchone()
        return json.loads(row[0]) if row else default

    def put(self,key,value):
        with self.db:
            self.db.execute("INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(key,json.dumps(value,ensure_ascii=False)))

    def enqueue(self,key,payload,now=None):
        now = time.time() if now is None else now
        with self.db:
            cur=self.db.execute("INSERT OR IGNORE INTO outbox(key,payload,state,available,created) VALUES(?,?,'pending',?,?)",(key,json.dumps(payload,ensure_ascii=False),now,now))
        return cur.rowcount == 1

    def enqueue_group(self, entries, available, created=None):
        """A report is committed in full, or not at all; never mix revisions."""
        created = time.time() if created is None else created
        self.db.execute("BEGIN IMMEDIATE")
        try:
            if any(self.db.execute("SELECT 1 FROM outbox WHERE key=?", (key,)).fetchone() for key, _ in entries):
                self.db.rollback()
                return False
            for key, payload in entries:
                self.db.execute("INSERT INTO outbox(key,payload,state,available,created) VALUES(?, ?, 'pending', ?, ?)",
                                (key, json.dumps(payload, ensure_ascii=False), available, created))
            self.db.commit()
            return True
        except Exception:
            self.db.rollback()
            raise

    def claim(self,now=None):
        now = time.time() if now is None else now
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self.db.execute("UPDATE outbox SET state='unknown_delivery',available=?,error='send_lease_expired' WHERE state='sending' AND lease<?",(now,now))
            row=self.db.execute("SELECT * FROM outbox WHERE state IN ('pending','retry_wait','unknown_delivery') AND available<=? ORDER BY created,key LIMIT 1",(now,)).fetchone()
            if row:
                self.db.execute("UPDATE outbox SET state='sending',lease=?,attempts=attempts+1 WHERE key=?",(now+90,row['key']))
            self.db.commit()
            return dict(row) if row else None
        except Exception:
            self.db.rollback()
            raise

    def accepted(self,key,message_id,now=None):
        if not message_id:
            raise ValueError("channel message id required")
        with self.db:
            self.db.execute("UPDATE outbox SET state='channel_accepted',message_id=?,accepted=?,lease=NULL,error=NULL WHERE key=?",(message_id,time.time() if now is None else now,key))

    def failed(self,key,error,ambiguous=False,permanent=False,now=None):
        now=time.time() if now is None else now
        row=self.db.execute("SELECT attempts,created FROM outbox WHERE key=?",(key,)).fetchone()
        attempts=row['attempts']
        delay=[30,120,600,1800][min(max(attempts-1,0),3)]
        state='needs_attention' if permanent or now-row['created']>=6*3600 else ('unknown_delivery' if ambiguous else 'retry_wait')
        with self.db:
            self.db.execute("UPDATE outbox SET state=?,available=?,lease=NULL,error=? WHERE key=?",(state,now+delay,error,key))

    def accepted_at(self,key):
        row=self.db.execute("SELECT accepted FROM outbox WHERE key=? AND state='channel_accepted'",(key,)).fetchone()
        return row[0] if row else None

    def stats(self):
        return dict(self.db.execute("SELECT state,count(*) FROM outbox GROUP BY state").fetchall())

    def close(self):
        self.db.close()
