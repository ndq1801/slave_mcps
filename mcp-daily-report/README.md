# mcp-daily-report

MCP stdio server for the **Daily Report** web app (Laravel 13 + Inertia + React, session-based auth): logs in with your account, reads pages, and submits leave requests / daily reports / overtime records.

Credentials are read from `.env` (or the host process env) and are **never exposed to the model**.

## Tools

| Tool | Purpose |
|---|---|
| `check_login` | Verify the configured account can log in |
| `get_session_status` | Connection state (base URL, account, login status) — no secrets |
| `get_app_map` | Map of the app: routes, request fields, known limitations. Call this first when exploring |
| `get_page` | Fetch a page (e.g. `/`, `/profile`) with the active session, returns Inertia page data |
| `post_data` | Low-level POST to any app path (form or JSON) with session + CSRF |
| `submit_daily_report` | Create/update a daily work report (`/daily-reports`) |
| `submit_request` | Create a leave/remote/compensatory request (`/user-requests`) |
| `register_overtime` | Create/update overtime hours (`/overtimes`) |
| `delete_record` | Delete a daily report / request / overtime by id |

## Environment

| Variable | Description |
|---|---|
| `DAILY_REPORT_BASE_URL` | App base URL (default `https://daily-report.wpdevelop.online`) |
| `DAILY_REPORT_USERNAME` | Account email (or username) |
| `DAILY_REPORT_PASSWORD` | Account password |
| `DAILY_REPORT_LOGIN_FIELD` | Login form field name (default `email`) |

## Setup & run

```bash
npm install
copy .env.example .env   # then fill in your own credentials (never commit .env)
node index.js            # speaks JSON-RPC over stdio; spawn it from an MCP client
```

## Client configuration

```json
{
  "mcp": {
    "daily-report": {
      "type": "local",
      "command": ["node", "E:/PJ/mcp-hub/mcp-daily-report/index.js"],
      "environment": {}
    }
  }
}
```

The server loads `.env` from its own folder, so most clients need no extra `environment` block. When spawned by `assistant-bot`, credentials come from the bot's environment instead (no `.env` needed here).

## Behavior notes

- **Session handling is automatic**: login once, reuse the session, auto re-login when the app session expires, CSRF token refreshed from `/` before each mutation, `X-XSRF-TOKEN` cookie header included.
- **Mutations are serialized** — write operations run one at a time so flash messages and verification stay unambiguous.
- **Host-scope guard**: HTTP requests to hosts other than the configured app host are refused.

## Known app limitations (see also `get_app_map` tool)

1. The app does **not** store or expose remaining leave days — only used dates (`userStats`). Answer "not available" instead of searching.
2. `GET /daily-reports` returns HTTP 500 — read reports via `GET /?date=YYYY-MM-DD`.
3. Multi-day requests create **one record per date** (a 5-day leave creates 5 records).
