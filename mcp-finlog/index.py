"""MCP stdio server for Finlog: income/expense/loan management.

Shares the FinlogBot PostgreSQL database. Amounts are real VND (no x1000
convention used by the old bot). Dates are strings in YYYY-MM-DD format and
are interpreted as the user's LOCAL dates: start-of-day (local) is converted
to UTC when storing/querying, and end-of-day (local) is converted to UTC for
the upper bound of a date range. They default to today when omitted.

Every tool returns JSON-serializable data or an "[ERROR] ..." string; tools
never raise exceptions to the MCP client.
"""

from __future__ import annotations

import os
import sys
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from mcp.server.fastmcp import FastMCP
from sqlalchemy.exc import IntegrityError

from app.domain.transactions.entities import Transaction, TransactionType
from app.domain.user.entities import User
from app.infrastructure.config import settings
from app.infrastructure.db import get_session_factory
from app.infrastructure.models import CategoryModel
from app.infrastructure.repositories.category_repository import (
    SqlAlchemyCategoryRepository,
)
from app.infrastructure.repositories.transaction_repository import (
    SqlAlchemyTransactionRepository,
)
from app.infrastructure.repositories.user_repository import (
    SqlAlchemyUserRepository,
)

mcp = FastMCP("mcp-finlog")

UTC = ZoneInfo("UTC")

# Timezone/currency defaults replicated from FinlogBot app/common/enums.py
# (LanguageLocale): timezone is an IANA name, currency a 3-letter code.
#   VI -> "Asia/Ho_Chi_Minh"/"VND", JA -> "Asia/Tokyo"/"JPY", EN -> "UTC"/"USD"
_LANGUAGE_DEFAULT_TIMEZONES = {
    "vi": "Asia/Ho_Chi_Minh",
    "ja": "Asia/Tokyo",
    "en": "UTC",
}
_LANGUAGE_DEFAULT_CURRENCIES = {
    "vi": "VND",
    "ja": "JPY",
    "en": "USD",
}
_VALID_CURRENCIES = frozenset(_LANGUAGE_DEFAULT_CURRENCIES.values())


# ---------------------------------------------------------------------------
# Startup / helpers
# ---------------------------------------------------------------------------

def _error(message: str) -> str:
    """Return a machine-readable error string for the model agent."""
    return f"[ERROR] {message}"


def _effective_telegram_id(telegram_user_id: int | None) -> int:
    """Resolve the caller's telegram user id (arg or FINLOG_TELEGRAM_USER_ID)."""
    if telegram_user_id is not None:
        return telegram_user_id
    telegram_id_str = os.environ.get("FINLOG_TELEGRAM_USER_ID", "").strip()
    if not telegram_id_str:
        raise ValueError(
            "Không xác định được user: hãy truyền telegram_user_id hoặc đặt "
            "FINLOG_TELEGRAM_USER_ID."
        )
    return int(telegram_id_str)


def _is_master(telegram_user_id: int) -> bool:
    """True when the caller is the master admin (FINLOG_MASTER_TELEGRAM_ID)."""
    master_id_str = os.environ.get("FINLOG_MASTER_TELEGRAM_ID", "").strip()
    if not master_id_str:
        return False
    try:
        return int(master_id_str) == telegram_user_id
    except ValueError:
        return False


def _resolve_user(telegram_user_id: int | None) -> int:
    """Resolve (find-or-create) the Finlog user for a single tool call.

    Uses the caller-provided telegram_user_id when given; otherwise falls back
    to the FINLOG_TELEGRAM_USER_ID env var. Raises ValueError (converted to an
    "[ERROR] ..." string by the tools) when no user can be identified.
    """
    telegram_id = _effective_telegram_id(telegram_user_id)

    session = get_session_factory()()
    try:
        user_repo = SqlAlchemyUserRepository(session)
        user = user_repo.get_by_telegram_id(telegram_id)
        if user is None:
            try:
                user = user_repo.create(
                    User(
                        id=None,
                        telegram_user_id=telegram_id,
                        username="mcp",
                        first_name="MCP",
                        last_name=None,
                    )
                )
            except IntegrityError:
                # Concurrent creation race; fall back to fetching the existing user.
                session.rollback()
                user = user_repo.get_by_telegram_id(telegram_id)
                if user is None:
                    raise
        return user.id
    finally:
        session.close()


def _resolve_target(
    telegram_user_id: int | None, target_telegram_user_id: int | None
) -> int:
    """Resolve the user whose data a tool operates on.

    telegram_user_id is the CALLER (used for authorization); when
    target_telegram_user_id is omitted it defaults to the caller's own data.
    Operating on another user's data is only allowed when the caller is the
    master admin (FINLOG_MASTER_TELEGRAM_ID). Raises ValueError (converted to
    an "[ERROR] ..." string by the tools) when access is denied.
    """
    caller_user_id = _resolve_user(telegram_user_id)
    caller_telegram_id = _effective_telegram_id(telegram_user_id)
    if target_telegram_user_id is None:
        return caller_user_id
    if target_telegram_user_id == caller_telegram_id:
        return caller_user_id
    if not _is_master(caller_telegram_id):
        raise ValueError("Bạn không có quyền truy cập dữ liệu của user khác.")
    return _resolve_user(target_telegram_user_id)


@contextmanager
def _session_scope():
    session = get_session_factory()()
    try:
        yield session
    finally:
        session.close()


def _load_user(session, user_id: int) -> Optional[User]:
    """Load a User entity by internal user id within the given session."""
    return SqlAlchemyUserRepository(session).get_by_id(user_id)


def _default_timezone_for(language_code: Optional[str]) -> str:
    """Replicate FinlogBot's LanguageLocale.default_timezone fallback.

    Uses the user's language default when no explicit timezone is stored;
    falls back to "UTC" when the language is unknown or absent.
    """
    if language_code:
        return _LANGUAGE_DEFAULT_TIMEZONES.get(language_code.lower(), "UTC")
    return "UTC"


def _zone_info_for(user: User) -> ZoneInfo:
    """Resolve a user's timezone (column users.timezone) to a ZoneInfo.

    Format replicates FinlogBot: IANA name such as "Asia/Ho_Chi_Minh".
    Falls back to "UTC" when unset or invalid.
    """
    tz_name = user.timezone or _default_timezone_for(user.language_code)
    try:
        return ZoneInfo(tz_name)
    except Exception:
        return UTC


def _user_timezone(user_id: int) -> ZoneInfo:
    """Return the ZoneInfo for a user (column users.timezone); fallback UTC."""
    with _session_scope() as session:
        user = _load_user(session, user_id)
        return _zone_info_for(user) if user else UTC


def _parse_date(value: Optional[str], tz: ZoneInfo) -> datetime:
    """Parse YYYY-MM-DD as a UTC datetime.

    The given date is the user's LOCAL date: local start-of-day is converted
    to UTC. Defaults to now (UTC) when empty.
    """
    if value is None or not value.strip():
        return datetime.now(UTC)
    try:
        local = datetime.strptime(value.strip(), "%Y-%m-%d").replace(tzinfo=tz)
        return local.astimezone(UTC)
    except ValueError:
        raise ValueError(
            f"Invalid date format: {value!r}. Expected YYYY-MM-DD."
        )


def _parse_date_end(value: Optional[str], tz: ZoneInfo) -> datetime:
    """Parse YYYY-MM-DD as a UTC datetime at the end of the user's local day.

    Used for the upper bound (to) of date-range queries.
    """
    if value is None or not value.strip():
        return datetime.now(UTC)
    try:
        local = datetime.strptime(value.strip(), "%Y-%m-%d").replace(
            hour=23, minute=59, second=59, microsecond=999999, tzinfo=tz
        )
        return local.astimezone(UTC)
    except ValueError:
        raise ValueError(
            f"Invalid date format: {value!r}. Expected YYYY-MM-DD."
        )


def _parse_type(value: Optional[str]) -> Optional[TransactionType]:
    """Parse an optional transaction type string into a TransactionType."""
    if value is None:
        return None
    try:
        return TransactionType(value.strip().lower())
    except ValueError:
        raise ValueError(
            f"Invalid transaction type: {value!r}. Allowed: income, expense, loan."
        )


def _load_category_names(session) -> Dict[int, str]:
    """Map category id -> name for enriching transaction output."""
    rows = session.query(CategoryModel.id, CategoryModel.name).all()
    return {category_id: name for category_id, name in rows}


def _tx_to_dict(
    tx: Transaction,
    category_names: Optional[Dict[int, str]] = None,
    tz: Optional[ZoneInfo] = None,
    currency: Optional[str] = None,
) -> Dict[str, Any]:
    """Serialize a Transaction entity to a JSON-serializable dict.

    transaction_date / created_at / updated_at are returned in the owner
    user's local timezone (tz); falls back to UTC when tz is None.
    """
    local_tz = tz or UTC

    def _to_local(value: Optional[datetime]) -> Optional[str]:
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(local_tz).isoformat()

    return {
        "id": tx.id,
        "user_id": tx.user_id,
        "type": tx.type.value if isinstance(tx.type, TransactionType) else str(tx.type),
        "amount": float(tx.amount),
        "description": tx.description,
        "transaction_date": _to_local(tx.transaction_date),
        "category_id": tx.category_id,
        "category_name": (
            category_names.get(tx.category_id)
            if category_names and tx.category_id
            else None
        ),
        "created_at": _to_local(tx.created_at),
        "updated_at": _to_local(tx.updated_at),
        "currency": currency,
    }


def _category_to_dict(category: CategoryModel) -> Dict[str, Any]:
    return {"id": category.id, "name": category.name}


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@mcp.tool()
def add_expense(
    *,
    telegram_user_id: int | None = None,
    target_telegram_user_id: int | None = None,
    amount: float,
    description: str,
    category_id: Optional[int] = None,
    date: Optional[str] = None,
) -> Any:
    """Record an expense. Amount is real VND (not x1000). Date is YYYY-MM-DD in the user's timezone, defaults to today.

    telegram_user_id: Telegram user id của người gọi; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    target_telegram_user_id: Telegram user id của user sở hữu dữ liệu; mặc định = telegram_user_id; chỉ master (FINLOG_MASTER_TELEGRAM_ID) được truy cập user khác.
    """
    try:
        user_id = _resolve_target(telegram_user_id, target_telegram_user_id)
        if amount <= 0:
            return _error("Amount must be greater than 0.")
        with _session_scope() as session:
            user = _load_user(session, user_id)
            if user is None:
                return _error(f"User {user_id} not found.")
            if not user.currency:
                return _error(
                    "User chưa cấu hình currency (đơn vị tiền tệ). Hãy hỏi user "
                    "muốn dùng đơn vị nào (VD: VND, USD, JPY) rồi gọi "
                    "update_user_settings để thiết lập trước khi ghi giao dịch."
                )
            tz = _zone_info_for(user)
            transaction_date = _parse_date(date, tz)
            category_repo = SqlAlchemyCategoryRepository(session)
            if category_id is not None and category_repo.get_by_id(category_id) is None:
                return _error(f"Category {category_id} does not exist.")
            repo = SqlAlchemyTransactionRepository(session)
            tx = repo.create(
                Transaction(
                    id=None,
                    user_id=user_id,
                    type=TransactionType.EXPENSE,
                    amount=float(amount),
                    description=description,
                    transaction_date=transaction_date,
                    created_at=datetime.now(UTC),
                    updated_at=None,
                    category_id=category_id,
                )
            )
            return _tx_to_dict(
                tx, _load_category_names(session), tz=tz, currency=user.currency
            )
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def add_income(
    *,
    telegram_user_id: int | None = None,
    target_telegram_user_id: int | None = None,
    amount: float,
    description: str,
    category_id: Optional[int] = None,
    date: Optional[str] = None,
) -> Any:
    """Record an income. Amount is real VND (not x1000). Date is YYYY-MM-DD in the user's timezone, defaults to today.

    telegram_user_id: Telegram user id của người gọi; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    target_telegram_user_id: Telegram user id của user sở hữu dữ liệu; mặc định = telegram_user_id; chỉ master (FINLOG_MASTER_TELEGRAM_ID) được truy cập user khác.
    """
    try:
        user_id = _resolve_target(telegram_user_id, target_telegram_user_id)
        if amount <= 0:
            return _error("Amount must be greater than 0.")
        with _session_scope() as session:
            user = _load_user(session, user_id)
            if user is None:
                return _error(f"User {user_id} not found.")
            if not user.currency:
                return _error(
                    "User chưa cấu hình currency (đơn vị tiền tệ). Hãy hỏi user "
                    "muốn dùng đơn vị nào (VD: VND, USD, JPY) rồi gọi "
                    "update_user_settings để thiết lập trước khi ghi giao dịch."
                )
            tz = _zone_info_for(user)
            transaction_date = _parse_date(date, tz)
            category_repo = SqlAlchemyCategoryRepository(session)
            if category_id is not None and category_repo.get_by_id(category_id) is None:
                return _error(f"Category {category_id} does not exist.")
            repo = SqlAlchemyTransactionRepository(session)
            tx = repo.create(
                Transaction(
                    id=None,
                    user_id=user_id,
                    type=TransactionType.INCOME,
                    amount=float(amount),
                    description=description,
                    transaction_date=transaction_date,
                    created_at=datetime.now(UTC),
                    updated_at=None,
                    category_id=category_id,
                )
            )
            return _tx_to_dict(
                tx, _load_category_names(session), tz=tz, currency=user.currency
            )
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def add_loan(
    *,
    telegram_user_id: int | None = None,
    target_telegram_user_id: int | None = None,
    amount: float,
    description: str,
    date: Optional[str] = None,
) -> Any:
    """Record a loan (no category). Amount is real VND (not x1000). Date is YYYY-MM-DD in the user's timezone, defaults to today.

    telegram_user_id: Telegram user id của người gọi; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    target_telegram_user_id: Telegram user id của user sở hữu dữ liệu; mặc định = telegram_user_id; chỉ master (FINLOG_MASTER_TELEGRAM_ID) được truy cập user khác.
    """
    try:
        user_id = _resolve_target(telegram_user_id, target_telegram_user_id)
        if amount <= 0:
            return _error("Amount must be greater than 0.")
        with _session_scope() as session:
            user = _load_user(session, user_id)
            if user is None:
                return _error(f"User {user_id} not found.")
            if not user.currency:
                return _error(
                    "User chưa cấu hình currency (đơn vị tiền tệ). Hãy hỏi user "
                    "muốn dùng đơn vị nào (VD: VND, USD, JPY) rồi gọi "
                    "update_user_settings để thiết lập trước khi ghi giao dịch."
                )
            tz = _zone_info_for(user)
            transaction_date = _parse_date(date, tz)
            repo = SqlAlchemyTransactionRepository(session)
            tx = repo.create(
                Transaction(
                    id=None,
                    user_id=user_id,
                    type=TransactionType.LOAN,
                    amount=float(amount),
                    description=description,
                    transaction_date=transaction_date,
                    created_at=datetime.now(UTC),
                    updated_at=None,
                    category_id=None,
                )
            )
            return _tx_to_dict(
                tx, _load_category_names(session), tz=tz, currency=user.currency
            )
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def list_transactions(
    *,
    telegram_user_id: int | None = None,
    target_telegram_user_id: int | None = None,
    type: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    keyword: Optional[str] = None,
    category_id: Optional[int] = None,
    page: int = 1,
    page_size: int = 20,
) -> Any:
    """List transactions with filters (type, date range YYYY-MM-DD local, keyword, category) and pagination. Amounts are real VND.

    telegram_user_id: Telegram user id của người gọi; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    target_telegram_user_id: Telegram user id của user sở hữu dữ liệu; mặc định = telegram_user_id; chỉ master (FINLOG_MASTER_TELEGRAM_ID) được truy cập user khác.
    """
    try:
        user_id = _resolve_target(telegram_user_id, target_telegram_user_id)
        if page < 1:
            return _error("page must be >= 1.")
        if page_size < 1:
            return _error("page_size must be >= 1.")
        transaction_types = [_parse_type(type)] if type else None
        skip = (page - 1) * page_size
        with _session_scope() as session:
            user = _load_user(session, user_id)
            if user is None:
                return _error(f"User {user_id} not found.")
            tz = _zone_info_for(user)
            start = (
                _parse_date(from_date, tz)
                if from_date
                else datetime(2000, 1, 1, tzinfo=UTC)
            )
            end = (
                _parse_date_end(to_date, tz)
                if to_date
                else datetime(2100, 1, 1, tzinfo=UTC)
            )
            repo = SqlAlchemyTransactionRepository(session)
            transactions, total = repo.get_by_user_and_date_range_with_filters(
                user_id,
                start,
                end,
                transaction_types=transaction_types,
                search_text=keyword,
                category_id=category_id,
                skip=skip,
                limit=page_size,
            )
            category_names = _load_category_names(session)
            return {
                "total": total,
                "page": page,
                "page_size": page_size,
                "currency": user.currency,
                "items": [
                    _tx_to_dict(tx, category_names, tz=tz, currency=user.currency)
                    for tx in transactions
                ],
            }
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def get_transaction(
    *,
    telegram_user_id: int | None = None,
    target_telegram_user_id: int | None = None,
    transaction_id: int,
) -> Any:
    """Get transaction details by id (including category name). Amount is real VND.

    telegram_user_id: Telegram user id của người gọi; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    target_telegram_user_id: Telegram user id của user sở hữu dữ liệu; mặc định = telegram_user_id; chỉ master (FINLOG_MASTER_TELEGRAM_ID) được truy cập user khác.
    """
    try:
        user_id = _resolve_target(telegram_user_id, target_telegram_user_id)
        with _session_scope() as session:
            repo = SqlAlchemyTransactionRepository(session)
            tx = repo.get_by_id(transaction_id)
            if tx is None or tx.user_id != user_id:
                return _error(f"Transaction {transaction_id} not found.")
            user = _load_user(session, tx.user_id)
            tz = _zone_info_for(user) if user else UTC
            currency = user.currency if user else None
            return _tx_to_dict(
                tx, _load_category_names(session), tz=tz, currency=currency
            )
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def delete_transactions(
    *,
    telegram_user_id: int | None = None,
    target_telegram_user_id: int | None = None,
    transaction_ids: list[int],
) -> Any:
    """Delete transactions by ids; returns the number of transactions deleted.

    telegram_user_id: Telegram user id của người gọi; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    target_telegram_user_id: Telegram user id của user sở hữu dữ liệu; mặc định = telegram_user_id; chỉ master (FINLOG_MASTER_TELEGRAM_ID) được truy cập user khác.
    """
    try:
        user_id = _resolve_target(telegram_user_id, target_telegram_user_id)
        with _session_scope() as session:
            repo = SqlAlchemyTransactionRepository(session)
            transactions = repo.get_by_ids(transaction_ids)
            own_ids = [tx.id for tx in transactions if tx.user_id == user_id]
            deleted = repo.delete_many(own_ids)
            return {"deleted": deleted}
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def update_transaction_category(
    *,
    telegram_user_id: int | None = None,
    target_telegram_user_id: int | None = None,
    transaction_ids: list[int],
    category_id: Optional[int] = None,
) -> Any:
    """Set or clear the category of existing transactions (batch, e.g. categorize old records). Pass category_id=None to clear it.

    telegram_user_id: Telegram user id của người gọi; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    target_telegram_user_id: Telegram user id của user sở hữu dữ liệu; mặc định = telegram_user_id; chỉ master (FINLOG_MASTER_TELEGRAM_ID) được truy cập user khác.
    """
    try:
        user_id = _resolve_target(telegram_user_id, target_telegram_user_id)
        with _session_scope() as session:
            if category_id is not None:
                category_repo = SqlAlchemyCategoryRepository(session)
                if category_repo.get_by_id(category_id) is None:
                    return _error(f"Category {category_id} does not exist.")
            repo = SqlAlchemyTransactionRepository(session)
            transactions = repo.get_by_ids(transaction_ids)
            own_ids = [tx.id for tx in transactions if tx.user_id == user_id]
            if not own_ids:
                return _error("No transactions found for this user.")
            updated = repo.update_many(
                own_ids,
                {
                    "category_id": category_id,
                    "updated_at": datetime.now(UTC),
                },
            )
            return {"updated": updated}
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def pay_loan(
    *,
    telegram_user_id: int | None = None,
    target_telegram_user_id: int | None = None,
    loan_id: int,
) -> Any:
    """Pay a loan: convert a loan transaction into an expense. Amount is real VND.

    telegram_user_id: Telegram user id của người gọi; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    target_telegram_user_id: Telegram user id của user sở hữu dữ liệu; mặc định = telegram_user_id; chỉ master (FINLOG_MASTER_TELEGRAM_ID) được truy cập user khác.
    """
    try:
        user_id = _resolve_target(telegram_user_id, target_telegram_user_id)
        with _session_scope() as session:
            repo = SqlAlchemyTransactionRepository(session)
            tx = repo.get_by_id(loan_id)
            if tx is None or tx.user_id != user_id:
                return _error(f"Transaction {loan_id} not found.")
            if tx.type != TransactionType.LOAN:
                return _error(f"Transaction {loan_id} is not a loan; only loans can be paid.")
            updated = repo.update_many(
                [loan_id],
                {
                    "type": TransactionType.EXPENSE.value,
                    "updated_at": datetime.now(UTC),
                },
            )
            if updated != 1:
                return _error(f"Failed to convert transaction {loan_id}.")
            paid = repo.get_by_id(loan_id)
            user = _load_user(session, user_id)
            tz = _zone_info_for(user) if user else UTC
            currency = user.currency if user else None
            return _tx_to_dict(
                paid, _load_category_names(session), tz=tz, currency=currency
            )
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def get_report(
    *,
    telegram_user_id: int | None = None,
    target_telegram_user_id: int | None = None,
    from_date: str,
    to_date: str,
    type: Optional[str] = None,
) -> Any:
    """Report totals by type plus breakdown by category for a date range (YYYY-MM-DD local). Amounts are real VND.

    telegram_user_id: Telegram user id của người gọi; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    target_telegram_user_id: Telegram user id của user sở hữu dữ liệu; mặc định = telegram_user_id; chỉ master (FINLOG_MASTER_TELEGRAM_ID) được truy cập user khác.
    """
    try:
        user_id = _resolve_target(telegram_user_id, target_telegram_user_id)
        transaction_type = _parse_type(type)
        with _session_scope() as session:
            user = _load_user(session, user_id)
            if user is None:
                return _error(f"User {user_id} not found.")
            tz = _zone_info_for(user)
            start = _parse_date(from_date, tz)
            end = _parse_date_end(to_date, tz)
            repo = SqlAlchemyTransactionRepository(session)
            totals = repo.get_summary_by_type_and_date_range(user_id, start, end)
            by_category = []
            if transaction_type is None:
                breakdown_types = [TransactionType.EXPENSE, TransactionType.INCOME]
            elif transaction_type == TransactionType.LOAN:
                breakdown_types = []  # loans have no category
            else:
                breakdown_types = [transaction_type]
            for t in breakdown_types:
                rows = repo.get_summary_by_category_and_date_range(
                    user_id, start, end, t
                )
                for row in rows:
                    row["type"] = t.value
                by_category.extend(rows)
            return {
                "from_date": from_date,
                "to_date": to_date,
                "currency": user.currency,
                "totals": totals,
                "by_category": by_category,
            }
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def get_balance(
    *,
    telegram_user_id: int | None = None,
    target_telegram_user_id: int | None = None,
) -> Any:
    """Current balance (total income minus total expense) in the user's currency.

    telegram_user_id: Telegram user id của người gọi; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    target_telegram_user_id: Telegram user id của user sở hữu dữ liệu; mặc định = telegram_user_id; chỉ master (FINLOG_MASTER_TELEGRAM_ID) được truy cập user khác.
    """
    try:
        user_id = _resolve_target(telegram_user_id, target_telegram_user_id)
        with _session_scope() as session:
            user = _load_user(session, user_id)
            if user is None:
                return _error(f"User {user_id} not found.")
            repo = SqlAlchemyTransactionRepository(session)
            result = repo.get_user_balance(user_id)
            result["currency"] = user.currency
            return result
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def get_user_profile(
    *,
    telegram_user_id: int | None = None,
    target_telegram_user_id: int | None = None,
) -> Any:
    """Return a user's profile (telegram_user_id, username, timezone, currency). Master can inspect other users via target_telegram_user_id.

    telegram_user_id: Telegram user id của người gọi; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    target_telegram_user_id: Telegram user id của user cần xem; mặc định = telegram_user_id; chỉ master (FINLOG_MASTER_TELEGRAM_ID) được truy cập user khác.
    """
    try:
        user_id = _resolve_target(telegram_user_id, target_telegram_user_id)
        with _session_scope() as session:
            user = _load_user(session, user_id)
            if user is None:
                return _error(f"User {user_id} not found.")
            return {
                "telegram_user_id": user.telegram_user_id,
                "username": user.username,
                "timezone": user.timezone,
                "currency": user.currency,
            }
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def update_user_settings(
    *,
    telegram_user_id: int | None = None,
    target_telegram_user_id: int | None = None,
    timezone: Optional[str] = None,
    currency: Optional[str] = None,
) -> Any:
    """Update a user's timezone and/or currency. At least one of timezone/currency is required. Master can update other users via target_telegram_user_id.

    telegram_user_id: Telegram user id của người gọi; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    target_telegram_user_id: Telegram user id của user cần cập nhật; mặc định = telegram_user_id; chỉ master (FINLOG_MASTER_TELEGRAM_ID) được truy cập user khác.
    """
    try:
        user_id = _resolve_target(telegram_user_id, target_telegram_user_id)
        if timezone is None and currency is None:
            return _error("Phải truyền ít nhất một trong: timezone hoặc currency.")
        if timezone is not None:
            timezone = timezone.strip()
            try:
                ZoneInfo(timezone)
            except Exception:
                return _error(
                    f"Invalid timezone: {timezone!r}. Use an IANA zone name "
                    "(VD: Asia/Ho_Chi_Minh, UTC)."
                )
        if currency is not None:
            currency = currency.strip().upper()
            if currency not in _VALID_CURRENCIES:
                return _error(
                    f"Invalid currency: {currency!r}. Supported currencies: "
                    f"{', '.join(sorted(_VALID_CURRENCIES))}."
                )
        with _session_scope() as session:
            repo = SqlAlchemyUserRepository(session)
            user = repo.get_by_id(user_id)
            if user is None:
                return _error(f"User {user_id} not found.")
            if timezone is not None:
                user.timezone = timezone
            if currency is not None:
                user.currency = currency
            user.updated_at = datetime.now(UTC)
            updated = repo.update(user)
            return {
                "telegram_user_id": updated.telegram_user_id,
                "username": updated.username,
                "timezone": updated.timezone,
                "currency": updated.currency,
            }
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def search_users(
    *,
    telegram_user_id: int | None = None,
    query: str,
    limit: int = 20,
) -> Any:
    """[master only] Search users by telegram id (exact) or by username/first_name/last_name (substring). Returns [{telegram_user_id, username, first_name, last_name, timezone, currency}].

    telegram_user_id: Telegram user id của master; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    """
    try:
        if not _is_master(_effective_telegram_id(telegram_user_id)):
            return _error("Chỉ master admin mới được dùng chức năng này.")
        limit = max(1, min(limit, 100))
        with _session_scope() as session:
            repo = SqlAlchemyUserRepository(session)
            return [
                {
                    "telegram_user_id": user.telegram_user_id,
                    "username": user.username,
                    "first_name": user.first_name,
                    "last_name": user.last_name,
                    "timezone": user.timezone,
                    "currency": user.currency,
                }
                for user in repo.search(query, limit=limit)
            ]
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def update_user(
    *,
    telegram_user_id: int | None = None,
    target_telegram_user_id: int,
    username: Optional[str] = None,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
    language_code: Optional[str] = None,
    timezone: Optional[str] = None,
    currency: Optional[str] = None,
) -> Any:
    """[master only] Update a user's profile fields (username/first_name/last_name/language_code/timezone/currency). At least one field is required. An empty timezone/currency clears that value.

    telegram_user_id: Telegram user id của master; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    target_telegram_user_id: Telegram user id của user cần cập nhật.
    """
    try:
        if not _is_master(_effective_telegram_id(telegram_user_id)):
            return _error("Chỉ master admin mới được dùng chức năng này.")
        if all(
            value is None
            for value in (
                username,
                first_name,
                last_name,
                language_code,
                timezone,
                currency,
            )
        ):
            return _error("Phải cung cấp ít nhất một trường để cập nhật.")
        updates: Dict[str, Any] = {}
        if username is not None:
            updates["username"] = username.strip()
        if first_name is not None:
            updates["first_name"] = first_name.strip()
        if last_name is not None:
            updates["last_name"] = last_name.strip()
        if language_code is not None:
            updates["language_code"] = language_code.strip()
        if timezone is not None:
            tz_value = timezone.strip()
            if tz_value:
                try:
                    ZoneInfo(tz_value)
                except Exception:
                    return _error(
                        f"Invalid timezone: {tz_value!r}. Use an IANA zone name "
                        "(VD: Asia/Ho_Chi_Minh, UTC)."
                    )
                updates["timezone"] = tz_value
            else:
                updates["timezone"] = None
        if currency is not None:
            currency_value = currency.strip().upper()
            if currency_value:
                if currency_value not in _VALID_CURRENCIES:
                    return _error(
                        f"Invalid currency: {currency_value!r}. Supported currencies: "
                        f"{', '.join(sorted(_VALID_CURRENCIES))}."
                    )
                updates["currency"] = currency_value
            else:
                updates["currency"] = None
        with _session_scope() as session:
            repo = SqlAlchemyUserRepository(session)
            user = repo.get_by_telegram_id(target_telegram_user_id)
            if user is None:
                return _error(f"User {target_telegram_user_id} không tồn tại.")
            for field, value in updates.items():
                setattr(user, field, value)
            user.updated_at = datetime.now(UTC)
            updated = repo.update(user)
            return {
                "telegram_user_id": updated.telegram_user_id,
                "username": updated.username,
                "timezone": updated.timezone,
                "currency": updated.currency,
            }
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def delete_user(
    *,
    telegram_user_id: int | None = None,
    target_telegram_user_id: int,
) -> Any:
    """[master only] Delete a user and all their transactions. Cannot delete yourself or the master account.

    telegram_user_id: Telegram user id của master; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    target_telegram_user_id: Telegram user id của user cần xoá.
    """
    try:
        caller_telegram_id = _effective_telegram_id(telegram_user_id)
        if not _is_master(caller_telegram_id):
            return _error("Chỉ master admin mới được dùng chức năng này.")
        if target_telegram_user_id == caller_telegram_id:
            return _error("Không thể xoá chính mình.")
        master_id_str = os.environ.get("FINLOG_MASTER_TELEGRAM_ID", "").strip()
        try:
            master_id = int(master_id_str) if master_id_str else None
        except ValueError:
            master_id = None
        if master_id is not None and target_telegram_user_id == master_id:
            return _error("Không thể xoá master admin.")
        with _session_scope() as session:
            repo = SqlAlchemyUserRepository(session)
            user = repo.get_by_telegram_id(target_telegram_user_id)
            if user is None:
                return _error(f"User {target_telegram_user_id} không tồn tại.")
            tx_repo = SqlAlchemyTransactionRepository(session)
            transaction_ids: List[int] = []
            skip = 0
            while True:
                page = tx_repo.get_by_user_id(user.id, skip=skip, limit=100)
                if not page:
                    break
                transaction_ids.extend(tx.id for tx in page)
                skip += len(page)
            transactions_deleted = tx_repo.delete_many(transaction_ids)
            repo.delete(user.id)
            return {
                "deleted": True,
                "telegram_user_id": target_telegram_user_id,
                "transactions_deleted": transactions_deleted,
            }
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def list_categories(
    *,
    telegram_user_id: int | None = None,
) -> Any:
    """List all categories, sorted by id. Returns [{id, name}].

    telegram_user_id: Telegram user id của người dùng; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    """
    try:
        _resolve_user(telegram_user_id)
        with _session_scope() as session:
            repo = SqlAlchemyCategoryRepository(session)
            return [_category_to_dict(c) for c in repo.list_all()]
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def add_category(
    *,
    telegram_user_id: int | None = None,
    name: str,
) -> Any:
    """Create a new category. The name must be unique.

    telegram_user_id: Telegram user id của người dùng; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    """
    try:
        _resolve_user(telegram_user_id)
        name = name.strip()
        if not name:
            return _error("Category name must not be empty.")
        with _session_scope() as session:
            repo = SqlAlchemyCategoryRepository(session)
            if repo.get_by_name(name) is not None:
                return _error(f"Category '{name}' already exists.")
            try:
                category = repo.create(name)
            except IntegrityError:
                return _error(f"Category '{name}' already exists.")
            return _category_to_dict(category)
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def update_category(
    *,
    telegram_user_id: int | None = None,
    category_id: int,
    name: str,
) -> Any:
    """Rename a category. The new name must not collide with another category.

    telegram_user_id: Telegram user id của người dùng; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    """
    try:
        _resolve_user(telegram_user_id)
        name = name.strip()
        if not name:
            return _error("Category name must not be empty.")
        with _session_scope() as session:
            repo = SqlAlchemyCategoryRepository(session)
            existing = repo.get_by_id(category_id)
            if existing is None:
                return _error(f"Category {category_id} does not exist.")
            conflict = repo.get_by_name(name)
            if conflict is not None and conflict.id != category_id:
                return _error(f"Category '{name}' already exists (id {conflict.id}).")
            updated = repo.update_name(category_id, name)
            return _category_to_dict(updated)
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def delete_category(
    *,
    telegram_user_id: int | None = None,
    category_id: int,
) -> Any:
    """Delete a category. Transactions referencing it become NULL (FK ON DELETE SET NULL).

    telegram_user_id: Telegram user id của người dùng; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    """
    try:
        _resolve_user(telegram_user_id)
        with _session_scope() as session:
            repo = SqlAlchemyCategoryRepository(session)
            if repo.get_by_id(category_id) is None:
                return _error(f"Category {category_id} does not exist.")
            repo.delete(category_id)
            return {"deleted": True, "category_id": category_id}
    except Exception as exc:
        return _error(str(exc))


if __name__ == "__main__":
    if not settings.database_url:
        print(
            "[WARN] DATABASE_URL is not set; tools will return errors until it "
            "is configured. Add it to the environment or mcp-finlog/.env.",
            file=sys.stderr,
        )
    mcp.run()
