# mcp-backlog

MCP stdio server for the **Backlog** team task-management app (projects, issues, board/Gantt, comments, time tracking, wiki, integrations).

Architecture note: the web app at `https://backlog.innofly-software.com` is a Next.js frontend backed by a separate JSON REST API at `https://backlog-api.innofly-software.com/api/v1`. Auth is Bearer-token based; there is no CSRF token. Credentials are read from `.env` (or the host process env) and are **never exposed to the model**.

## Current status

**Phase 2: typed read/write tools implemented.** Auth, projects, issues, comments, time tracking and dashboard/timesheet tools are available. Project and issue lookups are key-based (`project_key` / `issue_key`). Raw `api_get` / `api_write` remain as fallbacks for endpoints without a typed tool.

## Tools

| Tool | Purpose |
|---|---|
| `check_login` | Verify the configured account can log in; report e-mail, company id, company-selection warning, API version |
| `get_session_status` | Connection state (API URL, account, language, token present/obtained-at) — no secrets |
| `get_api_map` | Verified API map: base URL, key-based addressing, auth flow, list envelope, endpoints, error envelope, out-of-scope areas. Call this first when exploring |
| `list_projects` | List/search projects (`q`, `status`, `page`, `per_page`) |
| `get_project_config` | Issue types, statuses, priorities, categories, milestones with numeric ids — required before creating/updating issues |
| `list_issues` | List issues, optionally scoped to `project_key`, with filters and pagination |
| `get_issue` | Full issue detail by `issue_key` (description, attachments, watchers, children, permissions) |
| `create_issue` | Create an issue (`summary` required; other fields optional, ids from `get_project_config`) |
| `update_issue` | Partial update by `issue_key`; `null` clears nullable fields |
| `add_comment` | Add a comment (`content`, `attachment_ids`, `notified_user_ids`, `changes`) |
| `list_comments` | List comments on an issue |
| `list_time_entries` | List time entries logged on an issue |
| `log_time` | Log time (`work_date` + `hours` required, `note` optional) |
| `get_dashboard` | Caller's assigned/overdue/due-soon counts and due issues |
| `get_my_timesheet` | Caller's timesheet for a required `date_from` / `date_to` range |
| `api_get` | Read-only GET of any `/api/v1/...` path (discovery/fallback) |
| `api_write` | Serialized raw POST/PUT/PATCH/DELETE with optional JSON body (fallback) |

## Environment

| Variable | Description |
|---|---|
| `BACKLOG_API_URL` | API base URL (default `https://backlog-api.innofly-software.com`) |
| `BACKLOG_EMAIL` | Account e-mail |
| `BACKLOG_PASSWORD` | Account password |
| `BACKLOG_LANGUAGE` | `Accept-Language` value (default `vi`) |
| `BACKLOG_COMPANY_ID` | Optional fallback company id (commented out by default) |

## Setup & run

```bash
npm install
copy .env.example .env   # then fill in your own credentials (never commit .env)
npm run capture          # optional: capture response schemas into captures/
node index.js            # speaks JSON-RPC over stdio; spawn it from an MCP client
```

## Client configuration

```json
{
  "mcp": {
    "backlog": {
      "type": "local",
      "command": ["node", "E:/PJ/mcp-hub/mcp-backlog/index.js"],
      "environment": {}
    }
  }
}
```

The server loads `.env` from its own folder, so most clients need no extra `environment` block. When spawned by a host agent, credentials come from the host process's environment instead.

## Behavior notes

- **Session handling is automatic**: login once, reuse the token, re-login once and retry when the API returns HTTP 401 `TOKEN_INVALID`.
- **Mutations are serialized** — typed writes and raw `api_write` run one at a time.
- **Host-scope guard**: requests to hosts other than the configured API host are refused.
- **Capture output is gitignored**: `captures/` may contain company data.

## Known limitations

- The API is an **undocumented internal API** and may change without notice.
- No OpenAPI / docs endpoints exist.
- Access-token TTL is unknown.
- The company-switch request body is unknown.
- Project and issue lookups are **key-based** (`project_key` / `issue_key`); numeric ids appear only in payloads and request bodies.
- Webhooks/integrations management, wiki, push subscriptions and roles/admin are not exposed.
