#!/usr/bin/env python3
"""Export keyword rank history from Astro's local database as JSON lines.

Reads a consistent copy of Astro's Core Data store (never the live file) and
writes one line per (app, keyword, store, date):
  {"appId", "keyword", "country", "position", "capturedAt"}
Astro's 1000 means "not ranked" and becomes null. Core Data timestamps are
seconds since 2001-01-01.

  scripts/astro/export-astro-history.py --apps 6692632196,6511242367 > history.jsonl
"""
import argparse, datetime as dt, json, os, sqlite3, sys, tempfile

ASTRO_DB = os.path.expanduser(
    "~/Library/Containers/matteospada.it.ASO/Data/Library/Application Support/Astro/Model.sqlite"
)
EPOCH = dt.datetime(2001, 1, 1, tzinfo=dt.timezone.utc)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apps", required=True, help="comma-separated App Store ids")
    ap.add_argument("--db", default=ASTRO_DB)
    args = ap.parse_args()
    apps = [a.strip() for a in args.apps.split(",") if a.strip()]

    with tempfile.TemporaryDirectory() as tmp:
        copy = os.path.join(tmp, "Model.sqlite")
        src = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
        dst = sqlite3.connect(copy)
        src.backup(dst)
        src.close()
        rows = dst.execute(
            f"""SELECT a.ZAPPID, k.ZTEXT, k.ZSTORE, d.ZRANKING, d.ZDATE
                FROM ZDATAPOINT d
                JOIN ZKEYWORD k ON k.Z_PK = d.ZKEYWORD
                JOIN ZAPPLICATION a ON a.Z_PK = k.ZAPPLICATION
                WHERE a.ZAPPID IN ({",".join("?" * len(apps))})""",
            apps,
        )
        n = 0
        for app_id, keyword, store, ranking, date in rows:
            if not keyword or date is None:
                continue
            print(json.dumps({
                "appId": app_id,
                "keyword": keyword,
                "country": (store or "us").upper(),
                "position": None if ranking is None or ranking >= 1000 else int(ranking),
                "capturedAt": (EPOCH + dt.timedelta(seconds=date)).isoformat().replace("+00:00", "Z"),
            }))
            n += 1
        print(f"exported {n} points", file=sys.stderr)

if __name__ == "__main__":
    main()
