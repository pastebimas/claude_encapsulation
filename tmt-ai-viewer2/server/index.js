import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { markStaleOnBoot } from "./db.js";
import { authMiddleware } from "./auth.js";
import routes from "./routes.js";
import { startScheduler } from "./scheduler.js";
import { startTaskApi } from "./taskApi.js";
import { pruneWorktrees } from "./git.js";
import { listWorkspaceProjects, resolveExecUser } from "./docker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.VIEWER_PORT || "8035", 10);
const DIST = path.join(__dirname, "..", "dist");

markStaleOnBoot();

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

app.use("/api", authMiddleware, routes);

// Serve the built SPA; fall back to index.html for client-side routing.
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(DIST, "index.html")));
} else {
  app.get("/", (req, res) =>
    res.status(503).send("frontend not built — run `npm run build`")
  );
}

app.listen(PORT, "0.0.0.0", () => console.log(`tmt-ai-viewer2 on :${PORT}`));

startScheduler();

// Public task-dispatch API on its own port (off unless TASK_API_TOKEN is set).
startTaskApi();

// No runs are active at boot (markStaleOnBoot cleared them): drop any worktrees
// left over from a crash/restart so stale checkouts don't accumulate. Branches
// and commits are preserved in each repo's .git.
(async () => {
  try {
    const user = await resolveExecUser();
    for (const p of await listWorkspaceProjects()) await pruneWorktrees(p, user);
  } catch (e) {
    console.error("worktree prune on boot failed:", e.message);
  }
})();
