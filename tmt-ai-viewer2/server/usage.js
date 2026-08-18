// Global token-usage header. This is the ONE place we read the proxy's raw
// request_logs — purely to sum tokens across rolling time windows. Thread
// conversations never touch this.
import fs from "node:fs";
import path from "node:path";
import { projectTokensSince, TOKEN_KEYS } from "./projects.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const WINDOWS = [5, 30, 60, 120, 240];

function dbProjects() {
  let files = [];
  try {
    files = fs.readdirSync(DATA_DIR);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".db") && !f.startsWith("."))
    .map((f) => path.basename(f, ".db"));
}

function isoCutoff(minutes) {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

export function usageWindows() {
  const projects = dbProjects();
  const windows = {};
  for (const minutes of WINDOWS) {
    const cutoff = isoCutoff(minutes);
    const totals = Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0]));
    let requests = 0;
    for (const p of projects) {
      const row = projectTokensSince(p, cutoff);
      if (!row) continue;
      requests += row.n || 0;
      for (const k of TOKEN_KEYS) totals[k] += row[k] || 0;
    }
    windows[minutes] = {
      minutes,
      requests,
      tokens: (totals.input_tokens || 0) + (totals.output_tokens || 0),
      ...totals,
    };
  }
  return { windows };
}
