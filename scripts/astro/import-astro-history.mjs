#!/usr/bin/env node
// Load rank history exported by export-astro-history.py into asocli's
// app_keyword_position_history. INSERT OR IGNORE: a point asocli recorded
// itself always wins over an imported one for the same timestamp.
//
// Inside the container:
//   node import-astro-history.mjs < history.jsonl
import Database from "better-sqlite3";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";

const dbPath = process.env.ASO_DB_PATH || path.join(os.homedir(), ".aso", "aso-db.sqlite");
const db = new Database(dbPath);
const insert = db.prepare(
  `INSERT OR IGNORE INTO app_keyword_position_history
     (app_id, keyword, country, position, captured_at)
   VALUES (?, ?, ?, ?, ?)`
);

// Same normalisation asocli applies to keywords (domain/keywords/policy).
const normalize = (keyword) => keyword.trim().toLowerCase();

const points = [];
for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim()) points.push(JSON.parse(line));
}
let inserted = 0;
db.transaction(() => {
  for (const p of points) {
    inserted += insert.run(p.appId, normalize(p.keyword), p.country, p.position, p.capturedAt).changes;
  }
})();
console.log(`read ${points.length}, inserted ${inserted}, skipped ${points.length - inserted}`);
