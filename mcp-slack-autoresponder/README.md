# mcp-slack-autoresponder

MCP stdio server for Slack: starts a Socket Mode listener, and when a DM or an `@mention` arrives, starts a countdown (default 5 minutes). If you have not replied yourself by then, the server automatically posts a reply on your behalf.

Credentials are read from `.env` or the host process environment; they are never exposed to the model.

## Tools

| Tool | Purpose |
|---|---|
| `start_slack_listener` | Start the Slack Socket Mode listener and begin countdowns |
| `stop_slack_listener` | Stop the listener and clear all pending countdowns |
| `get_slack_status` | Connection state, pending countdowns, current configuration |
| `configure_autoresponder` | Change timeout, default reply text, Slack user ID... |
| `get_pending_replies` | List messages currently waiting in a countdown |
| `cancel_pending_reply` | Cancel the countdown for a specific channel/thread |
| `send_slack_message` | Send a message directly to a Slack channel/thread |

## Environment

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_USER_TOKEN` | User token (`xoxp-...`) |
| `SLACK_APP_TOKEN` | App-Level Token for Socket Mode (`xapp-...`, scope `connections:write`) |
| `SLACK_USER_ID` | Your Slack member ID (`U...`) — used to detect your own replies |
| `AUTO_REPLY_TIMEOUT_MINUTES` | Countdown before auto-reply (default `5`) |
| `DEFAULT_REPLY_TEXT` | Default auto-reply text |

## Slack App setup (once)

1. Create an app at https://api.slack.com/apps → **From scratch**.
2. **Socket Mode**: enable, create an App-Level Token (`socket-token`, scope `connections:write`) → `SLACK_APP_TOKEN`.
3. **OAuth & Permissions** — Bot Token Scopes: `app_mentions:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `chat:write`. Install to Workspace → `SLACK_BOT_TOKEN` (`xoxb-...`).
4. **Event Subscriptions**: enable, subscribe to bot events `app_mention`, `message.im`, `message.channels`, `message.groups`.
5. Your member ID: Slack → Profile → `...` → **Copy member ID** (`U...`) → `SLACK_USER_ID`.

## Setup & run

```bash
npm install
copy .env.example .env   # then fill in your own tokens (never commit .env)
node index.js            # speaks JSON-RPC over stdio; spawn it from an MCP client
```

## Client configuration

```json
{
  "mcp": {
    "slack-autoresponder": {
      "type": "local",
      "command": ["node", "E:/PJ/mcp-hub/mcp-slack-autoresponder/index.js"],
      "environment": {
        "SLACK_BOT_TOKEN": "{env:SLACK_BOT_TOKEN}",
        "SLACK_APP_TOKEN": "{env:SLACK_APP_TOKEN}",
        "SLACK_USER_TOKEN": "{env:SLACK_USER_TOKEN}",
        "SLACK_USER_ID": "{env:SLACK_USER_ID}"
      }
    }
  }
}
```

The server loads `.env` from its own folder, so clients without env support only need the `.env` file.
