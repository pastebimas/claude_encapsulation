"""Identify the human-typed prompt inside an Anthropic API request body.

Interactive Claude Code prompts never reach us through an interface we own —
they arrive embedded in the messages array of a proxied API request. This
module pulls out the text the user actually typed for a *new* turn, and returns
None for everything else: tool-loop continuations, background/subagent calls,
and Claude Code's injected synthetic messages (recaps, suggestions, quota
checks, notifications, transcript summaries, document dumps).

Shared by proxy.py (writes user_prompts at ingest) and the 008 backfill
migration so the rule lives in exactly one place.
"""
import re
from typing import Optional

REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.DOTALL)

# Lowercased openings of auto-generated user messages to exclude.
SYNTHETIC_PREFIXES = (
    "the user stepped away",
    "[suggestion mode",
    "[system notification",
    "the coordinator sent a message",
    "<task-notification",
    "<transcript",
    "<!doctype",
    "<?php",
    "<html",
    "quota",
)


def _system_text(system) -> str:
    if isinstance(system, str):
        return system
    if isinstance(system, list):
        return " ".join(
            b.get("text", "") for b in system if isinstance(b, dict)
        )
    return ""


def _last_user_message(messages: list) -> Optional[dict]:
    # Claude Code appends trailing `system`-role / <total_tokens> messages, so
    # the real prompt/continuation is the last *user*-role message.
    for msg in reversed(messages):
        if isinstance(msg, dict) and msg.get("role") == "user":
            return msg
    return None


def extract_user_prompt(body: dict) -> Optional[str]:
    """Return the typed prompt text for a new human turn, else None."""
    if not isinstance(body, dict):
        return None
    model = body.get("model") or ""
    if not (model.startswith("claude-opus") or model.startswith("claude-sonnet")):
        return None
    # Claude Code tags Task-spawned subagent requests in the system prompt's
    # billing header. Those prompts are written by Claude, not the user.
    if "cc_is_subagent=true" in _system_text(body.get("system")):
        return None
    messages = body.get("messages")
    if not isinstance(messages, list):
        return None
    last = _last_user_message(messages)
    if last is None:
        return None

    content = last.get("content")
    if isinstance(content, list):
        # A tool_result block means this is a tool-loop continuation, not a turn.
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return None
        text = "\n".join(
            b.get("text", "")
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    elif isinstance(content, str):
        text = content
    else:
        return None

    text = REMINDER_RE.sub("", text).strip()
    if not text:
        return None
    low = text.lower()
    if any(low.startswith(p) for p in SYNTHETIC_PREFIXES):
        return None
    return text
