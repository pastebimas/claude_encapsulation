// Night scheduler: spends idle Claude credits on queued tasks. Server-side, so
// it runs whether or not a browser is open. It only ever *starts* work when the
// window + idle + policy gates all pass; run-now (routes) bypasses the gates.
import * as db from "./db.js";
import { usageWindows, latestLimits } from "./usage.js";
import { dispatchScheduled } from "./claude.js";

const DEFAULTS = {
  enabled: false,
  policy: "always", // 'always' | 'weekly_low'
  night_start_hour: 0,
  night_end_hour: 6,
  timezone: "Europe/Vilnius",
  concurrency: 1,
  idle_minutes: 30,
  default_agents: 4,
  weekly_anchors: [
    [6, 0.14],
    [2, 0.8],
    [0.5, 0.95],
  ],
};

export function schedulerConfig() {
  return { ...DEFAULTS, ...(db.getSettings("scheduler") || {}) };
}
export function saveSchedulerConfig(patch) {
  const merged = { ...schedulerConfig(), ...(patch || {}) };
  db.setSettings("scheduler", merged);
  return merged;
}

// Allowed weekly-utilization cutoff, ramping by days left until the 7d reset.
// Anchors are [daysLeft, cutoff] pairs; we piecewise-linearly interpolate.
export function weeklyThreshold(daysLeft, anchors) {
  const pts = (anchors || DEFAULTS.weekly_anchors).slice().sort((a, b) => b[0] - a[0]);
  if (daysLeft >= pts[0][0]) return pts[0][1];
  const last = pts[pts.length - 1];
  if (daysLeft <= last[0]) return last[1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [d1, t1] = pts[i];
    const [d2, t2] = pts[i + 1];
    if (daysLeft <= d1 && daysLeft >= d2) {
      const f = (d1 - daysLeft) / (d1 - d2 || 1);
      return t1 + f * (t2 - t1);
    }
  }
  return last[1];
}

function hourInTz(tz) {
  try {
    return parseInt(
      new Date().toLocaleString("en-GB", { timeZone: tz, hour12: false, hour: "2-digit" }),
      10
    );
  } catch {
    return new Date().getHours();
  }
}

export function inWindow(cfg) {
  const h = hourInTz(cfg.timezone);
  const a = cfg.night_start_hour;
  const b = cfg.night_end_hour;
  return a <= b ? h >= a && h < b : h >= a || h < b; // wraps past midnight
}

// Whether the weekly policy allows a run right now. Also used by the UI preview.
export function policyDecision(cfg, limits) {
  if (cfg.policy === "always") return { allow: true, reason: "always at night" };
  const w = limits && limits.available && limits.seven_d;
  if (!w || w.reset == null || w.utilization == null)
    return { allow: false, reason: "no weekly-limit data yet" };
  const daysLeft = (w.reset - Date.now() / 1000) / 86400;
  const cutoff = weeklyThreshold(daysLeft, cfg.weekly_anchors);
  return {
    allow: w.utilization <= cutoff,
    cutoff,
    utilization: w.utilization,
    days_left: daysLeft,
    reason:
      `week ${Math.round(w.utilization * 100)}% used, cutoff ${Math.round(cutoff * 100)}%` +
      ` (${daysLeft.toFixed(1)}d left)`,
  };
}

// Finalize scheduled tasks whose dispatched thread has reached a terminal state.
function reconcile() {
  for (const t of db.runningScheduled()) {
    const th = t.thread_id ? db.getThread(t.thread_id) : null;
    if (!th) {
      db.updateScheduled(t.id, { status: "failed", error: "thread missing", finished_at: db.now() });
      continue;
    }
    const s = th.status;
    if (s === "running") continue;
    if (s === "done" || s === "awaiting")
      db.updateScheduled(t.id, { status: "done", finished_at: db.now() });
    else if (s === "stopped")
      db.updateScheduled(t.id, { status: "canceled", finished_at: db.now() });
    else if (s === "error" || s === "stale") {
      // A transient-error auto-retry is queued — not final yet.
      if (s === "error" && db.hasPendingRetry(t.thread_id)) continue;
      db.updateScheduled(t.id, { status: "failed", error: `run ${s}`, finished_at: db.now() });
    }
  }
}

let sessionActive = false; // within-window session; relaxes the idle gate once started
let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    reconcile();
    const cfg = schedulerConfig();
    if (!cfg.enabled) return;
    if (!inWindow(cfg)) {
      sessionActive = false;
      return;
    }
    if (db.runningScheduledCount() >= cfg.concurrency) return;
    // Policy is re-checked every dispatch, so a weekly_low run stops once
    // utilization reaches tonight's cutoff.
    if (!policyDecision(cfg, latestLimits()).allow) return;
    // Idle only gates the *start* of a night session — the scheduler's own
    // tokens shouldn't block it from pulling the next task.
    if (!sessionActive) {
      const idle = (usageWindows().windows[cfg.idle_minutes]?.requests || 0) === 0;
      if (!idle) return;
    }
    // Walk the queue in order: an approval whose thread is still busy stays
    // queued and must not block the tasks behind it.
    for (const task of db.listQueued()) {
      if (dispatchScheduled(task)) {
        sessionActive = true;
        break;
      }
    }
  } catch (e) {
    console.error("scheduler tick:", e.message);
  } finally {
    ticking = false;
  }
}

export function startScheduler() {
  setInterval(tick, 60_000);
  console.log("night scheduler started");
}
