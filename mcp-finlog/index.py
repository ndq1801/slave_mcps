"""MCP stdio server for Finlog: income/expense/loan management.

Shares the FinlogBot PostgreSQL database. Amounts are real VND (no x1000
convention used by the old bot). Dates are strings in YYYY-MM-DD format and
are interpreted as UTC dates.

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


# ---------------------------------------------------------------------------
# Startup / helpers
# ---------------------------------------------------------------------------

def _error(message: str) -> str:
    """Return a machine-readable error string for the model agent."""
    return f"[ERROR] {message}"


def _resolve_user(telegram_user_id: int | None) -> int:
    """Resolve (find-or-create) the Finlog user for a single tool call.

    Uses the caller-provided telegram_user_id when given; otherwise falls back
    to the FINLOG_TELEGRAM_USER_ID env var. Raises ValueError (converted to an
    "[ERROR] ..." string by the tools) when no user can be identified.
    """
    if telegram_user_id is None:
        telegram_id_str = os.environ.get("FINLOG_TELEGRAM_USER_ID", "").strip()
        if not telegram_id_str:
            raise ValueError(
                "Không xác định được user: hãy truyền telegram_user_id hoặc đặt "
                "FINLOG_TELEGRAM_USER_ID."
            )
        telegram_id = int(telegram_id_str)
    else:
        telegram_id = telegram_user_id

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


@contextmanager
def _session_scope():
    session = get_session_factory()()
    try:
        yield session
    finally:
        session.close()


def _parse_date(value: Optional[str]) -> datetime:
    """Parse YYYY-MM-DD as a UTC datetime; defaults to now when empty."""
    if value is None or not value.strip():
        return datetime.now(UTC)
    try:
        return datetime.strptime(value.strip(), "%Y-%m-%d").replace(tzinfo=UTC)
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
) -> Dict[str, Any]:
    """Serialize a Transaction entity to a JSON-serializable dict."""
    return {
        "id": tx.id,
        "user_id": tx.user_id,
        "type": tx.type.value if isinstance(tx.type, TransactionType) else str(tx.type),
        "amount": float(tx.amount),
        "description": tx.description,
        "transaction_date": tx.transaction_date.isoformat()
        if tx.transaction_date
        else None,
        "category_id": tx.category_id,
        "category_name": (
            category_names.get(tx.category_id)
            if category_names and tx.category_id
            else None
        ),
        "created_at": tx.created_at.isoformat() if tx.created_at else None,
        "updated_at": tx.updated_at.isoformat() if tx.updated_at else None,
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
    amount: float,
    description: str,
    category_id: Optional[int] = None,
    date: Optional[str] = None,
) -> Any:
    """Record an expense. Amount is real VND (not x1000). Date is YYYY-MM-DD, defaults to today.

    telegram_user_id: Telegram user id của người dùng; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    """
    try:
        user_id = _resolve_user(telegram_user_id)
        if amount <= 0:
            return _error("Amount must be greater than 0.")
        transaction_date = _parse_date(date)
        with _session_scope() as session:
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
            return _tx_to_dict(tx, _load_category_names(session))
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def add_income(
    *,
    telegram_user_id: int | None = None,
    amount: float,
    description: str,
    category_id: Optional[int] = None,
    date: Optional[str] = None,
) -> Any:
    """Record an income. Amount is real VND (not x1000). Date is YYYY-MM-DD, defaults to today.

    telegram_user_id: Telegram user id của người dùng; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    """
    try:
        user_id = _resolve_user(telegram_user_id)
        if amount <= 0:
            return _error("Amount must be greater than 0.")
        transaction_date = _parse_date(date)
        with _session_scope() as session:
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
            return _tx_to_dict(tx, _load_category_names(session))
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def add_loan(
    *,
    telegram_user_id: int | None = None,
    amount: float,
    description: str,
    date: Optional[str] = None,
) -> Any:
    """Record a loan (no category). Amount is real VND (not x1000). Date is YYYY-MM-DD, defaults to today.

    telegram_user_id: Telegram user id của người dùng; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    """
    try:
        user_id = _resolve_user(telegram_user_id)
        if amount <= 0:
            return _error("Amount must be greater than 0.")
        transaction_date = _parse_date(date)
        with _session_scope() as session:
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
            return _tx_to_dict(tx, _load_category_names(session))
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def list_transactions(
    *,
    telegram_user_id: int | None = None,
    type: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    keyword: Optional[str] = None,
    category_id: Optional[int] = None,
    page: int = 1,
    page_size: int = 20,
) -> Any:
    """List transactions with filters (type, date range YYYY-MM-DD, keyword, category) and pagination. Amounts are real VND.

    telegram_user_id: Telegram user id của người dùng; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    """
    try:
        user_id = _resolve_user(telegram_user_id)
        if page < 1:
            return _error("page must be >= 1.")
        if page_size < 1:
            return _error("page_size must be >= 1.")
        start = _parse_date(from_date) if from_date else datetime(2000, 1, 1, tzinfo=UTC)
        end = _parse_date(to_date) if to_date else datetime(2100, 1, 1, tzinfo=UTC)
        end = end.replace(hour=23, minute=59, second=59, microsecond=999999)
        transaction_types = [_parse_type(type)] if type else None
        skip = (page - 1) * page_size
        with _session_scope() as session:
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
                "items": [_tx_to_dict(tx, category_names) for tx in transactions],
            }
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def get_transaction(
    *,
    telegram_user_id: int | None = None,
    transaction_id: int,
) -> Any:
    """Get transaction details by id (including category name). Amount is real VND.

    telegram_user_id: Telegram user id của người dùng; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    """
    try:
        user_id = _resolve_user(telegram_user_id)
        with _session_scope() as session:
            repo = SqlAlchemyTransactionRepository(session)
            tx = repo.get_by_id(transaction_id)
            if tx is None or tx.user_id != user_id:
                return _error(f"Transaction {transaction_id} not found.")
            return _tx_to_dict(tx, _load_category_names(session))
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def delete_transactions(
    *,
    telegram_user_id: int | None = None,
    transaction_ids: list[int],
) -> Any:
    """Delete transactions by ids; returns the number of transactions deleted.

    telegram_user_id: Telegram user id của người dùng; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    """
    try:
        user_id = _resolve_user(telegram_user_id)
        with _session_scope() as session:
            repo = SqlAlchemyTransactionRepository(session)
            transactions = repo.get_by_ids(transaction_ids)
            own_ids = [tx.id for tx in transactions if tx.user_id == user_id]
            deleted = repo.delete_many(own_ids)
            return {"deleted": deleted}
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def pay_loan(
    *,
    telegram_user_id: int | None = None,
    loan_id: int,
) -> Any:
    """Pay a loan: convert a loan transaction into an expense. Amount is real VND.

    telegram_user_id: Telegram user id của người dùng; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    """
    try:
        user_id = _resolve_user(telegram_user_id)
        with _session_scope() as session:
            repo = SqlAlchemyTransactionRepository(session)
            tx = repo.get_by_id(loan_id)
            if tx is None:
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
            return _tx_to_dict(paid, _load_category_names(session))
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def get_report(
    *,
    telegram_user_id: int | None = None,
    from_date: str,
    to_date: str,
    type: Optional[str] = None,
) -> Any:
    """Report totals by type plus breakdown by category for a date range (YYYY-MM-DD). Amounts are real VND.

    telegram_user_id: Telegram user id của người dùng; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    """
    try:
        user_id = _resolve_user(telegram_user_id)
        start = _parse_date(from_date)
        end = _parse_date(to_date).replace(
            hour=23, minute=59, second=59, microsecond=999999
        )
        transaction_type = _parse_type(type)
        with _session_scope() as session:
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
                "totals": totals,
                "by_category": by_category,
            }
    except Exception as exc:
        return _error(str(exc))


@mcp.tool()
def get_balance(
    *,
    telegram_user_id: int | None = None,
) -> Any:
    """Current balance (total income minus total expense) in real VND.

    telegram_user_id: Telegram user id của người dùng; nếu bỏ trống dùng FINLOG_TELEGRAM_USER_ID.
    """
    try:
        user_id = _resolve_user(telegram_user_id)
        with _session_scope() as session:
            repo = SqlAlchemyTransactionRepository(session)
            return repo.get_user_balance(user_id)
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
            "[ERROR] DATABASE_URL is not set. Add it to the environment or to "
            "mcp-finlog/.env before starting the server.",
            file=sys.stderr,
        )
        sys.exit(1)
    mcp.run()
