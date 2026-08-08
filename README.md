# mcp-hub

Collection of self-contained MCP (Model Context Protocol) **stdio** servers. One folder per server, each fully independent (own `package.json`, own `index.js`, own `.env`).

Every server here works with **any** MCP client that supports stdio — opencode, Claude Desktop, Cline, and the Telegram bot in [`assistant-bot`](https://github.com/) (which spawns them as child processes).

## Current servers

| Folder | What it does | Env needed |
|---|---|---|
| [`mcp-daily-report/`](mcp-daily-report/README.md) | Operates the Daily Report work app (leave requests, daily reports, overtime) | `DAILY_REPORT_*` |
| [`mcp-slack-autoresponder/`](mcp-slack-autoresponder/README.md) | Slack Socket Mode listener: auto-replies to DMs/mentions after a countdown if you did not reply | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_USER_TOKEN`, `SLACK_USER_ID`, ... |
| [`mcp-finlog/`](mcp-finlog/README.md) | Finlog income/expense/loan manager (shared PostgreSQL with the FinlogBot) | `DATABASE_URL`, `FINLOG_TELEGRAM_USER_ID` |

## Quick start (local use)

```bash
# 1. Install dependencies for the server(s) you need
cd mcp-daily-report && npm install

# 2. Create credentials from the template (never commit .env)
cp .env.example .env   # then fill in your own values

# 3. Point your MCP client at the server entry
#    command: node   args: <absolute path to this folder>/index.js
```

Example `opencode.json` fragment:

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

> Note: every server loads `.env` from its **own folder** automatically, so most clients need no `environment` block at all.

## Conventions (read before adding a server)

1. **One folder per server**, self-contained: `index.js` (stdio transport), `package.json`, `.env.example`, `README.md`.
2. **Never commit secrets.** Credentials live in per-folder `.env` (gitignored) or are injected by the host process (e.g. the Telegram bot passes its own env to child processes).
3. Use the official `@modelcontextprotocol/sdk` with `StdioServerTransport` and `ListToolsRequestSchema` / `CallToolRequestSchema` handlers.
4. Host-scope guard: never allow the server to make HTTP requests outside its configured app host.
5. Sensitive tool descriptions must tell the model what NOT to search for (e.g. "the app does not store this data").
6. Every new server ships with: `README.md` (what it does, tools, env table, client config example), `.env.example`, `.gitignore` entries for its own `.env`/`node_modules` (covered by the root `.gitignore`).

## Use from assistant-bot (Telegram)

The bot does **not** vendor this project. On deployment (Railway) it clones this repo at startup via `MCP_HUB_REPO_URL` and installs each server's npm dependencies, so MCP updates never require a redeploy:

- `MCP_HUB_REPO_URL` — git URL of this repo (leave empty in local development)
- `MCP_HUB_DIR` — where to clone it (default `./mcp-hub`)
- Server entry paths default to `<hub>/<folder>/index.js`; override with `MCP_DAILY_REPORT_INDEX` etc. when needed (local dev: absolute path to your local clone)

## Testing a server

```bash
cd mcp-daily-report
npm install
node index.js   # speaks JSON-RPC over stdio; a client is required to exercise it
```

The `assistant-bot` repo contains integration smoke tests (`python smoke_test.py`) that spawn these servers and verify login/tool listing.
