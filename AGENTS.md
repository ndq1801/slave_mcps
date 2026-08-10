---
description: Project rules for agents working on the mcp-hub project
alwaysApply: true
---

# mcp-hub — Agent Rules

## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.

## Project overview

`mcp-hub` is a collection of self-contained MCP stdio servers (Node.js or Python). One folder per server (`mcp-daily-report/`, `mcp-finlog/`, ...). Each server keeps its credentials in its own `.env` (gitignored) or receives them from the host process environment.

## Coding rules

- All code comments must be written in English.
- Communicate with the user in Vietnamese.
- Only modify exactly what is requested; no unrelated refactoring.
- Preserve existing formatting and style.
- Follow the conventions of the nearest existing server in this repo (they share one design).

## Architecture constraints (do not break)

1. **Never commit secrets** (`.env`, tokens, passwords). The root `.gitignore` already excludes `.env` and `node_modules/`; keep it that way.
2. **One folder per server**, self-contained and runnable on its own (`npm install` + `.env` is enough).
3. **Stdio transport only** — servers are spawned as child processes by clients (opencode, Telegram bot, Claude Desktop...). No HTTP endpoints.
4. **Credentials are never exposed to the model**: tool inputs must not require or echo passwords; the server reads them from `.env`/env only.
5. **Host-scope guard**: `httpFetch` must refuse requests to hosts other than the configured app host.
6. Every new server must ship with `README.md` (description, tool list, env table, client config example) and `.env.example`.
7. Write operations that mutate app data should be serialized (one at a time) to keep verification and flash messages unambiguous.
8. **Multi-user identity convention**: servers that manage per-user data must accept `telegram_user_id: int | None = None` as the first parameter of every tool. Resolve the user per call (find-or-create by telegram id, like `mcp-finlog`); when the parameter is omitted, fall back to a dedicated env var (e.g. `FINLOG_TELEGRAM_USER_ID`). Never ask the model for credentials (see rule 4) — identity always comes from the host (assistant-bot) or the env fallback.
9. **Self-describing tool descriptions**: every tool description must state BOTH what the tool does AND when to use it (trigger conditions, prerequisites, what it should NOT be used for). The host's system prompt is MCP-agnostic and will never mention any server by name — the model decides purely from name + description + schema. Follow the `get_app_map` model ("Call this FIRST when exploring the app..."). Never rely on the host knowing the server's context, routes, or other tools.

## Verification

- Per server: `npm install` (or `pip install -r requirements.txt` for Python servers) then spawn it via an MCP client or `assistant-bot`'s `smoke_test.py` (spawn + login + clean shutdown).
- Before finishing a change, run the smoke test of every server you touched.

## Secrets

- Never print or log `.env` values.
- `.env.example` is the template; the real `.env` is per-machine and gitignored.
