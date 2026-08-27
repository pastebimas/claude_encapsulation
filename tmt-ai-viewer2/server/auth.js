import crypto from "node:crypto";
import * as db from "./db.js";

const PASSWORD = process.env.VIEWER_PASSWORD || "";
const MAX_ATTEMPTS = parseInt(process.env.VIEWER_MAX_ATTEMPTS || "5", 10);
const LOCKOUT_SECONDS = parseInt(process.env.VIEWER_LOCKOUT_SECONDS || "300", 10);
const TTL_SECONDS = parseInt(process.env.VIEWER_SESSION_TTL || "2592000", 10); // 30d
const COOKIE = "v2session";

const attempts = new Map(); // ip -> {count, lockedUntil}

export const authEnabled = () => !!PASSWORD;

const hash = (t) => crypto.createHash("sha256").update(t).digest("hex");

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAuthed(req) {
  if (!authEnabled()) return true;
  const token = parseCookies(req)[COOKIE];
  return !!token && db.authSessionValid(hash(token));
}

export function login(req, res) {
  const ip = req.ip || req.socket.remoteAddress || "?";
  const entry = attempts.get(ip);
  if (entry && entry.lockedUntil > Date.now()) {
    return res.status(429).json({
      error: "locked",
      retry_in: Math.ceil((entry.lockedUntil - Date.now()) / 1000),
    });
  }
  const password = (req.body && req.body.password) || "";
  if (!authEnabled() || password === PASSWORD) {
    attempts.delete(ip);
    const token = crypto.randomBytes(32).toString("hex");
    db.createAuthSession(hash(token), Math.floor(Date.now() / 1000) + TTL_SECONDS);
    res.setHeader(
      "Set-Cookie",
      `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${TTL_SECONDS}`
    );
    return res.json({ ok: true });
  }
  const e = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  e.count++;
  if (e.count >= MAX_ATTEMPTS) {
    e.count = 0;
    e.lockedUntil = Date.now() + LOCKOUT_SECONDS * 1000;
    attempts.set(ip, e);
    return res.status(429).json({ error: "locked", retry_in: LOCKOUT_SECONDS });
  }
  attempts.set(ip, e);
  return res.status(401).json({ error: "bad_password", attempts_left: MAX_ATTEMPTS - e.count });
}

export function logout(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) db.destroyAuthSession(hash(token));
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  res.json({ ok: true });
}

// Gate everything under /api except the auth endpoints themselves.
export function authMiddleware(req, res, next) {
  if (req.path === "/login" || req.path === "/me") return next();
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: "unauthorized" });
}
