// Dispatch `claude -p --output-format stream-json` inside tmt-ai-code and
// persist Claude Code's own structured events straight into the state DB.
// Nothing here reconstructs conversations from API traffic — the stream-json
// records ARE the conversation.
import { EventEmitter } from "node:events";
import {
  CODE_CONTAINER,
  execStream,
  execCollect,
  resolveExecUser,
} from "./docker.js";
import { addNote } from "./projects.js";
import * as db from "./db.js";

export const bus = new EventEmitter();
bus.setMaxListeners(0);

const RUN_TIMEOUT = parseInt(process.env.RUN_TIMEOUT || "3600", 10) * 1000;

const RUN_PROMPT_SUFFIX =
  process.env.RUN_PROMPT_SUFFIX ??
  "If something extra pops up that is worth returning to later (follow-up" +
    " work, proposals, ideas), do not do it now — end your final reply with a" +
    " 'NOTES:' section listing each item as a '- [ ] item' line; it is saved" +
    " to the project notes.";
const RUN_NO_QUESTIONS =
  process.env.RUN_NO_QUESTIONS ??
  "This task was dispatched from the web dashboard and runs non-interactively —" +
    " you cannot have a live back-and-forth. For minor or low-risk choices, make" +
    " the most reasonable assumption, state it briefly, and carry the task through" +
    " to completion. ONLY if a decision is genuinely blocking and you cannot" +
    " proceed safely without it, stop and ask: end your reply with a block in" +
    " exactly this form, with nothing after it —\n" +
    "QUESTION: <the single blocking question>\n- <option 1>\n- <option 2>\n" +
    "List 2–4 concrete options when you can. The user picks one (or types a free" +
    " answer) and you resume in the same session, so do not ask about anything you" +
    " can reasonably decide yourself.";

const LIMIT_RE = /(?:session|usage|rate)[ _-]?limit|limit reached|hit your .{0,20}limit/i;
const NOTES_MARKER_RE = /^NOTES:[ \t]*(.*)$/im;
const QUESTION_MARKER_RE = /^QUESTION:[ \t]*(.*)$/im;
const OPTION_RE = /^\s*[-*]\s+(.*\S)\s*$/;

// Parse a trailing `QUESTION:` block into { question, options[] }. Returns null
// when there is no marker or no question text.
function parseQuestion(resultText) {
  const m = QUESTION_MARKER_RE.exec(resultText || "");
  if (!m) return null;
  const question = m[1].trim();
  if (!question) return null;
  const options = [];
  for (const line of resultText.slice(m.index + m[0].length).split("\n")) {
    const om = OPTION_RE.exec(line);
    if (om) options.push(om[1].trim());
  }
  return { question, options };
}

// Same shape from a real AskUserQuestion tool_use, if the CLI ever emits one in
// print mode. Takes the first question and its option labels.
function parseAskTool(input) {
  const qs = input && input.questions;
  if (!Array.isArray(qs) || !qs.length) return null;
  const first = qs[0];
  const options = (first.options || []).map((o) => o.label).filter(Boolean);
  const question = (first.question || first.header || "").trim();
  return question ? { question, options } : null;
}

// The wrapper Claude actually receives. Stored in turns.sent_text (raw tab),
// never shown as the request itself.
export function wrapPrompt(userText, kind) {
  let body = userText;
  if (kind === "new" && RUN_PROMPT_SUFFIX) body = `${userText}\n\n${RUN_PROMPT_SUFFIX}`;
  return RUN_NO_QUESTIONS ? `${RUN_NO_QUESTIONS}\n\n${body}` : body;
}

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function emitEvent(ev) {
  const { seq, id } = db.insertEvent(ev);
  db.touchThread(ev.thread_id);
  bus.emit(ev.thread_id, { t: "event", event: { ...ev, seq, id } });
}

// Turn one stream-json record into event rows.
function ingestRecord(ctx, obj) {
  const common = { thread_id: ctx.threadId, turn_id: ctx.turnId, run_id: ctx.runId };
  const type = obj.type;
  if (type === "system") {
    emitEvent({
      ...common,
      type: "system",
      name: obj.subtype || null,
      text: obj.subtype === "init" ? `session ${obj.session_id || ""}` : null,
      data_json: JSON.stringify(obj),
    });
  } else if (type === "assistant" && obj.message) {
    const usage = obj.message.usage || {};
    for (const block of obj.message.content || []) {
      if (block.type === "text") {
        emitEvent({
          ...common,
          type: "assistant_text",
          text: block.text || "",
          out_tokens: usage.output_tokens || 0,
        });
      } else if (block.type === "thinking") {
        emitEvent({
          ...common,
          type: "thinking",
          text: block.thinking || "",
          data_json: JSON.stringify(block),
        });
      } else if (block.type === "tool_use") {
        if (block.name === "AskUserQuestion") {
          const q = parseAskTool(block.input);
          if (q) ctx.askQuestion = q;
        }
        emitEvent({
          ...common,
          type: "tool_use",
          name: block.name || "",
          text: null,
          data_json: JSON.stringify(block.input ?? {}),
        });
      }
    }
  } else if (type === "user" && obj.message) {
    for (const block of obj.message.content || []) {
      if (block.type === "tool_result") {
        emitEvent({
          ...common,
          type: "tool_result",
          name: block.tool_use_id || null,
          text: flattenToolResult(block.content),
          data_json: JSON.stringify(block),
        });
      }
    }
  } else if (type === "result") {
    ctx.resultSeen = true;
    ctx.resultJson = JSON.stringify(obj);
    ctx.resultText = obj.result || "";
    const u = obj.usage || {};
    emitEvent({
      ...common,
      type: "result",
      text: obj.result || "",
      data_json: JSON.stringify(obj),
      in_tokens: u.input_tokens || 0,
      out_tokens: u.output_tokens || 0,
      cache_read: u.cache_read_input_tokens || 0,
      cache_creation: u.cache_creation_input_tokens || 0,
    });
  }
}

function flattenToolResult(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((b) => (typeof b === "string" ? b : b.text || ""))
      .filter(Boolean)
      .join("\n");
  return "";
}

function handleLine(ctx, line) {
  const s = line.trim();
  if (!s || s[0] !== "{") return;
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    return;
  }
  ctx.processed++;
  ingestRecord(ctx, obj);
}

// Kick off a run for an already-created turn. Returns immediately; ingest runs
// in the background and streams to `bus`.
export function startRun(thread, turn, kind) {
  const runId = db.createRun(thread.id, turn.id, kind);
  db.setTurnRun(turn.id, runId);
  ingest(thread, turn, runId, kind).catch((e) => {
    console.error(`run ${runId} failed:`, e);
    db.updateRun(runId, {
      status: "error",
      error: e.message,
      finished_at: db.now(),
    });
    db.setThreadStatus(thread.id, "error");
    bus.emit(thread.id, { t: "status", status: "error" });
  });
  return runId;
}

async function ingest(thread, turn, runId, kind) {
  const outFile = `/tmp/tmt2-${runId}.jsonl`;
  const errFile = `/tmp/tmt2-${runId}.err`;
  const user = await resolveExecUser();
  const sid = thread.session_id;

  const args = ["claude", "-p", "--verbose", "--output-format", "stream-json"];
  // Fresh run: assign the session id up front so the thread maps immediately.
  // Resume: --resume alone continues that same session (passing --session-id
  // too is rejected unless --fork-session).
  if (kind === "resume") args.push("--resume", sid);
  else args.push("--session-id", sid);
  args.push(turn.sent_text);

  // tee: the exec's stdout (the attach stream we read live) also lands in a
  // file, so if the socket-proxy drops a quiet stream we recover the tail.
  const shell = `${args.map(shq).join(" ")} 2>${shq(errFile)} | tee ${shq(outFile)}`;

  const ctx = { threadId: thread.id, turnId: turn.id, runId, processed: 0, resultSeen: false };

  const { exitCode, stderr, note } = await execStream(CODE_CONTAINER, ["sh", "-c", shell], {
    workdir: `/workspace/${thread.project}`,
    user,
    onStdoutLine: (l) => handleLine(ctx, l),
    deadlineMs: RUN_TIMEOUT,
  });

  // Tail-catch: re-read the file for anything the live stream missed.
  if (note || !ctx.resultSeen) {
    try {
      const { stdout } = await execCollect(CODE_CONTAINER, ["cat", outFile]);
      const lines = stdout.split("\n");
      for (const l of lines.slice(ctx.processed)) handleLine(ctx, l);
    } catch {
      /* best effort */
    }
  }

  let errText = stderr || "";
  try {
    const { stdout } = await execCollect(CODE_CONTAINER, ["cat", errFile]);
    if (stdout.trim()) errText = `${errText}\n${stdout}`.trim();
  } catch {
    /* ignore */
  }

  const ok = exitCode === 0 && ctx.resultSeen;
  const status = ok ? "done" : "error";

  const fields = {
    status,
    exit_code: exitCode,
    finished_at: db.now(),
    stream_note: note,
    result_json: ctx.resultJson || null,
    error: ok ? null : errText || `exit ${exitCode}` || null,
  };

  // usage-limit detection → mark resumable + schedule.
  const haystack = `${errText}\n${ctx.resultText || ""}`;
  if (LIMIT_RE.test(haystack)) {
    fields.limit_hit = 1;
    fields.resume_at = new Date(
      Date.now() + parseInt(process.env.RUN_LIMIT_RETRY_MINUTES || "30", 10) * 60000
    ).toISOString();
  }

  db.updateRun(runId, fields);

  // Did the run pause on a blocking question (marker in the reply, or a real
  // AskUserQuestion tool call)? If so, park the thread as 'awaiting' so the UI
  // can surface the question; the user's answer resumes the same session.
  const question = ok ? parseQuestion(ctx.resultText) || ctx.askQuestion : null;
  if (question) {
    db.setThreadAwaiting(thread.id, question);
  } else {
    db.setThreadStatus(thread.id, status);
  }

  // Save any NOTES: trailer to the project notes (proxy's notes table).
  if (ctx.resultText) saveNotes(thread, ctx.resultText);

  bus.emit(thread.id, {
    t: "status",
    status: question ? "awaiting" : status,
    run: db.getRun(runId),
  });
  if (question) bus.emit(thread.id, { t: "awaiting", awaiting: question });
  bus.emit(thread.id, { t: "done" });

  execCollect(CODE_CONTAINER, ["rm", "-f", outFile, errFile]).catch(() => {});
}

function saveNotes(thread, resultText) {
  const m = NOTES_MARKER_RE.exec(resultText);
  if (!m) return;
  const body = resultText.slice(m.index + m[0].length).trim();
  const combined = [m[1].trim(), body].filter(Boolean).join("\n").trim();
  if (!combined) return;
  try {
    addNote(thread.project, {
      title: thread.title.slice(0, 80),
      body: combined,
      origin: "agent",
      session_id: thread.session_id,
    });
  } catch (e) {
    console.error("saveNotes failed:", e.message);
  }
}
