# mcp-finlog

MCP **stdio** server for **Finlog** (the income/expense bot in `FinlogBot`): records expenses, income and loans, lists/edits transactions, pays loans, generates reports and manages categories — all against the **same PostgreSQL database** the bot uses.

Amounts are **real VND** (the old bot's x1000 convention is **not** used here — pass the actual amount, e.g. `15000` for 15,000₫). Dates are strings in `YYYY-MM-DD` format, interpreted as UTC; they default to today when omitted.

## Tools

| Tool | Purpose |
|---|---|
| `add_expense` | Record an expense (VND). Optional `category_id` and `date` |
| `add_income` | Record an income (VND). Optional `category_id` and `date` |
| `add_loan` | Record a loan (no category) |
| `list_transactions` | Filtered + paginated transaction list (type, date range, keyword, category), each item includes the category name |
| `get_transaction` | Transaction detail by id, including category name |
| `delete_transactions` | Delete transactions by ids; returns the number deleted |
| `pay_loan` | Pay a loan — converts a loan transaction into an expense (same logic as the bot's `/pay`) |
| `get_report` | Totals by type + breakdown by category for a date range |
| `get_balance` | Current balance (income − expense) in VND |
| `list_categories` | List all categories `[{id, name}]`, sorted by id |
| `add_category` | Create a category (name must be unique) |
| `update_category` | Rename a category (no collision with another category) |
| `delete_category` | Delete a category; transactions referencing it become NULL (FK `ON DELETE SET NULL`) |

All tools accept a leading `telegram_user_id` parameter (optional — see [Multi-user support](#multi-user-support)).

## Multi-user support

Every tool accepts a leading `telegram_user_id: int | None = None` argument so a
single server instance can serve many users at once (matching the original
FinlogBot behavior). Per tool call:

- If `telegram_user_id` is passed, the server resolves (find-or-create) the
  matching Finlog user and operates on that user's data.
- If it is omitted, the server falls back to `FINLOG_TELEGRAM_USER_ID` from the
  environment.
- If neither is available, the tool returns an `[ERROR]` string saying the user
  could not be identified.

A user that does not exist yet is created on first use (`username="mcp"`,
`first_name="MCP"`). `FINLOG_TELEGRAM_USER_ID` is therefore only a fallback and
no environment variable is required at startup: the server boots even without
`DATABASE_URL` and every tool returns an `[ERROR]` until it is configured.

**Category scope note:** `category` data (list/add/update/delete) is currently
**shared** across users — the `categories` table has no per-user column yet (the
schema is managed by FinlogBot's Alembic). The category tools still accept
`telegram_user_id` so they can be scoped per user later, but for now they operate
on the shared category set.

## Environment

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string shared with FinlogBot (required for tools; the server boots without it and tools return `[ERROR]` until it is set) |
| `FINLOG_TELEGRAM_USER_ID` | Telegram user id used as a fallback when a tool call does not pass `telegram_user_id` (optional). If the user does not exist yet, the server creates it (`username="mcp"`, `first_name="MCP"`) |

Both are read from the process env or from `mcp-finlog/.env`. If `DATABASE_URL`
is missing, the server prints a warning to stderr and keeps running.

## Setup & run

```bash
pip install -r requirements.txt
copy .env.example .env   # then fill in your own values (never commit .env)
python index.py          # speaks MCP over stdio; spawn it from an MCP client
```

## Client configuration

```json
{
  "mcp": {
    "finlog": {
      "type": "local",
      "command": ["python", "E:/PJ/mcp-hub/mcp-finlog/index.py"],
      "environment": {}
    }
  }
}
```

The server loads `.env` from its own folder, so most clients need no extra `environment` block. `FINLOG_TELEGRAM_USER_ID` may also be injected by the host process.

## Notes on syncing with FinlogBot

- `app/` is **vendored** from `E:\PJ\FinlogBot\app` (`common/enums.py`, `domain/`, `infrastructure/{db,models,repositories}`). Only telegram/ai/interface/application layers are excluded. When FinlogBot changes, re-copy those folders.
- The database schema is managed by **FinlogBot's Alembic** — this server **never** runs migrations. `Category` and `Transaction.category_id` already exist in the shared schema; the vendored domain entity and transaction repository were extended to carry `category_id` (the bot's own code is untouched).
- `app/infrastructure/repositories/category_repository.py` is a new thin helper (FinlogBot has no category repository).
- Dates are interpreted in UTC; the bot stores `transaction_date` in UTC too.
