# mcp-finlog

MCP **stdio** server for **Finlog** (the income/expense bot in `FinlogBot`): records expenses, income and loans, lists/edits transactions, pays loans, generates reports and manages categories — all against the **same PostgreSQL database** the bot uses.

Amounts are **real VND** (the old bot's x1000 convention is **not** used here — pass the actual amount, e.g. `15000` for 15,000₫). Dates are strings in `YYYY-MM-DD` format, interpreted as the **user's local dates** (start-of-day/end-of-day local are converted to UTC when storing/querying — see [Timezone](#timezone)); they default to today when omitted.

## Tools

| Tool | Purpose |
|---|---|
| `add_expense` | Record an expense (VND). Optional `category_id` and `date` |
| `add_income` | Record an income (VND). Optional `category_id` and `date` |
| `add_loan` | Record a loan (no category) |
| `list_transactions` | Filtered + paginated transaction list (type, date range, keyword, category), each item includes the category name |
| `get_transaction` | Transaction detail by id, including category name |
| `delete_transactions` | Delete transactions by ids; returns the number deleted |
| `update_transaction_category` | Set or clear the category of existing transactions (batch, e.g. categorize old records) |
| `pay_loan` | Pay a loan — converts a loan transaction into an expense (same logic as the bot's `/pay`) |
| `get_report` | Totals by type + breakdown by category for a date range |
| `get_balance` | Current balance (income − expense) in VND |
| `get_user_profile` | User profile `{telegram_user_id, username, timezone, currency}` (master can inspect other users) |
| `update_user_settings` | Set a user's `timezone` and/or `currency` (validates the values; master can update other users) |
| `search_users` | **master only** — search users by telegram id (exact) or by name substring; returns `{telegram_user_id, username, first_name, last_name, timezone, currency}` |
| `update_user` | **master only** — update a user's profile fields (`username`, `first_name`, `last_name`, `language_code`, `timezone`, `currency`); validates timezone/currency; an empty `timezone`/`currency` clears that value |
| `delete_user` | **master only** — delete a user **and all their transactions** (same session); refuses to delete yourself or the master account |
| `list_categories` | List all categories `[{id, name}]`, sorted by id |
| `add_category` | Create a category (name must be unique) |
| `update_category` | Rename a category (no collision with another category) |
| `delete_category` | Delete a category; transactions referencing it become NULL (FK `ON DELETE SET NULL`) |

All tools accept a leading `telegram_user_id` parameter (optional — see [Multi-user support](#multi-user-support)). Every transaction-data tool also accepts `target_telegram_user_id` (see [Master admin](#master-admin)).

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

Every transaction-data tool also accepts `target_telegram_user_id: int | None`
which selects **whose** data the tool operates on:

- `telegram_user_id` is always the **caller** (used for authorization).
- `target_telegram_user_id` defaults to `telegram_user_id` (the caller's own data).
- When `target_telegram_user_id` differs from the caller, access is only allowed
  for the master admin — see [Master admin](#master-admin).

**Category scope note:** `category` data (list/add/update/delete) is currently
**shared** across users — the `categories` table has no per-user column yet (the
schema is managed by FinlogBot's Alembic). The category tools still accept
`telegram_user_id` so they can be scoped per user later, but for now they operate
on the shared category set.

## Master admin

Setting `FINLOG_MASTER_TELEGRAM_ID` (optional) grants that Telegram user full
access to **every** user's data. If the variable is unset, no master exists and
nobody can access another user's data.

- Master behavior mirrors the old bot's `BOT_OWNER_TELEGRAM_ID`: a transaction
  may be viewed/deleted/updated/paid by either its owner **or** the master
  (`delete_handler.py` / `pay_handler.py`).
- With `target_telegram_user_id` on a transaction tool, the master can
  `add_*`, `list`, `get`, `delete`, `pay_loan`, `get_report`, `get_balance` and
  `update_transaction_category` on behalf of any user.
- The master can also call `get_user_profile` / `update_user_settings` with
  `target_telegram_user_id` to inspect or update another user's timezone/currency.
- The user-management tools `search_users`, `update_user` and `delete_user` are
  **master only**: a non-master caller gets
  `[ERROR] Chỉ master admin mới được dùng chức năng này.` `update_user` requires
  at least one field (`Phải cung cấp ít nhất một trường để cập nhật.`) and
  validates timezone (`ZoneInfo`) and currency (`VND`/`JPY`/`USD`); an empty
  timezone/currency clears that value. `delete_user` removes the user **and all
  their transactions** in the same session, and guards against deleting the
  caller (`Không thể xoá chính mình.`) or the master account
  (`Không thể xoá master admin.`).
- A non-master caller passing `target_telegram_user_id` for another user gets:
  `[ERROR] Bạn không có quyền truy cập dữ liệu của user khác.`

## Timezone

Transactions are always stored **in UTC** (unchanged). Timezone handling
replicates FinlogBot's behavior:

- A user's timezone is read from the `users.timezone` column, an IANA name such
  as `"Asia/Ho_Chi_Minh"` (same format as `FinlogBot/app/common/enums.py`
  `LanguageLocale.default_timezone`). When unset, the server falls back to the
  language default (`vi`→`Asia/Ho_Chi_Minh`, `ja`→`Asia/Tokyo`, `en`→`UTC`) and
  finally to `UTC`.
- `date` / `from_date` / `to_date` (`YYYY-MM-DD`) are the user's **local** dates:
  the lower bound is local start-of-day, the upper bound is local end-of-day,
  both converted to UTC before querying/storing (matches the old bot's
  `convert_time_to_utc` / `convert_time_to_utc_range`).
- `_tx_to_dict` returns `transaction_date`/`created_at`/`updated_at` in the
  transaction owner's **local** timezone.

## Currency

- Each user has a `currency` column (`String(3)`), same values as FinlogBot's
  `LanguageLocale.currency_code`: **`VND`**, **`JPY`**, **`USD`**.
- **Blocking guard**: `add_expense` / `add_income` / `add_loan` refuse to write
  until the user has a currency set, returning
  `[ERROR] User chưa cấu hình currency ...`. Ask the user which unit they want
  (e.g. VND/USD/JPY) and call `update_user_settings` first.
- `get_balance` / `get_report` include a `"currency"` field in their result, and
  every transaction dict from `_tx_to_dict` carries the owner's `"currency"`.
- `update_user_settings` validates: timezone via `zoneinfo.ZoneInfo(tz)`,
  currency against `{VND, JPY, USD}` (an invalid currency returns `[ERROR]`
  listing the supported values). At least one of `timezone`/`currency` must be
  passed.

## Environment

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string shared with FinlogBot (required for tools; the server boots without it and tools return `[ERROR]` until it is set) |
| `FINLOG_TELEGRAM_USER_ID` | Telegram user id used as a fallback when a tool call does not pass `telegram_user_id` (optional). If the user does not exist yet, the server creates it (`username="mcp"`, `first_name="MCP"`) |
| `FINLOG_MASTER_TELEGRAM_ID` | Master admin telegram user id (optional). When set, this user can access any user's data via `target_telegram_user_id`; when unset, no master exists |

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
- Transactions are stored in UTC; `transaction_date` is written from the user's local date (see [Timezone](#timezone)).
