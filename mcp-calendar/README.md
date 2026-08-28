# mcp-calendar

MCP **stdio** server for **Google Calendar**. It lets an agent manage events on a
Google Calendar: **list, read, create, update and delete**.

It targets a **real Google Calendar account** (personal Gmail or Workspace) and
authenticates via stored OAuth credentials, so any event the agent writes also
shows up on every device synced to that calendar (and vice versa). Credentials
come from the environment and are **never exposed to the model**.

The read/write target is config-driven (`GOOGLE_CALENDAR_ID`), so the same
server works for any agent / any machine by pointing the env vars at that
owner's own Google Calendar credentials.

## Tools

| Tool | Purpose |
|---|---|
| `get_calendar_info` | Config state, calendar id, timezone, calendar summary (call first to confirm wiring) |
| `list_events` | List events in a date range (default now → +7d), optional full-text query |
| `get_event` | Read a single event by id (description, attendees, location) |
| `create_event` | Create a new event (summary + start/end required) |
| `update_event` | Update an existing event (partial: title, description, location, times) |
| `delete_event` | Delete an event by id (destructive) |

## Environment

| Variable | Description |
|---|---|
| `GOOGLE_CALENDAR_CLIENT_ID` | OAuth 2.0 Client ID (Desktop app) |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | OAuth 2.0 Client Secret |
| `GOOGLE_CALENDAR_REFRESH_TOKEN` | Refresh token obtained from the OAuth consent flow |
| `GOOGLE_CALENDAR_ID` | Calendar id to manage (default `primary`). Use `primary` for the account's main calendar; a specific id (from `list_calendars`) to target another. |
| `GOOGLE_CALENDAR_TIMEZONE` | IANA timezone used for queries (default `Asia/Ho_Chi_Minh`). |

## Setup & run

```bash
npm install
copy .env.example .env   # then fill in your own credentials (never commit .env)
node index.js            # speaks JSON-RPC over stdio; spawn it from an MCP client
```

## Get a refresh token (one-time)

The refresh token comes from running the Google OAuth consent flow once in a
browser. This server ships a helper: `scripts/get-refresh-token.mjs`.

Run it on a machine **with a browser** (your PC, not a headless server), with
the client id/secret available (either in `.env` or as env vars):

```bash
GOOGLE_CALENDAR_CLIENT_ID=... GOOGLE_CALENDAR_CLIENT_SECRET=... \
  node scripts/get-refresh-token.mjs
```

It prints a Google consent URL. Open it, sign in as the Google account whose
calendar you want to use, and approve. The script then prints
`GOOGLE_CALENDAR_REFRESH_TOKEN=...` - copy that value into `.env`.

Before running it you need: a Google Cloud project with the Google Calendar
API enabled, an OAuth 2.0 **Desktop** client, and the OAuth consent screen set
to External and **published to production** (otherwise the refresh token
expires after 7 days).

## Client configuration

```json
{
  "mcp": {
    "calendar": {
      "type": "local",
      "command": ["node", "/absolute/path/to/mcp-calendar/index.js"],
      "environment": {
        "GOOGLE_CALENDAR_CLIENT_ID": "{env:GOOGLE_CALENDAR_CLIENT_ID}",
        "GOOGLE_CALENDAR_CLIENT_SECRET": "{env:GOOGLE_CALENDAR_CLIENT_SECRET}",
        "GOOGLE_CALENDAR_REFRESH_TOKEN": "{env:GOOGLE_CALENDAR_REFRESH_TOKEN}"
      }
    }
  }
}
```

The server loads `.env` from its own folder, so clients without env support
only need the `.env` file.

## Behavior notes

- **Credential-driven**: the server reads everything from env; nothing about a
  user or machine is hardcoded.
- **No secret exposure**: tool responses never include the client secret or the
  refresh token; `get_calendar_info` only reports booleans for which fields are set.
- **Generality**: works with any agent / any machine — each owner supplies
  their own `GOOGLE_CALENDAR_*` env vars.
