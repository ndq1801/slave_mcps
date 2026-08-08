from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.domain.transactions.entities import Transaction, TransactionType
from app.domain.transactions.repositories import TransactionRepository
from app.infrastructure.models import CategoryModel, TransactionModel


class SqlAlchemyTransactionRepository(TransactionRepository):
    """SQLAlchemy-backed implementation for transaction persistence."""

    def __init__(self, session: Session) -> None:
        self.session = session

    def create(self, transaction: Transaction) -> Transaction:
        model = self._to_model(transaction)
        self.session.add(model)
        self.session.commit()
        self.session.refresh(model)
        return self._to_entity(model)

    def create_many(self, transactions: List[Transaction]) -> List[Transaction]:
        if not transactions:
            return []
        models = [self._to_model(tx) for tx in transactions]
        self.session.add_all(models)
        self.session.commit()
        for model in models:
            self.session.refresh(model)
        return [self._to_entity(model) for model in models]

    def get_by_id(self, transaction_id: int) -> Optional[Transaction]:
        model = (
            self.session.query(TransactionModel)
            .filter(TransactionModel.id == transaction_id)
            .first()
        )
        return self._to_entity(model) if model else None

    def get_by_user_id(
        self,
        user_id: int,
        skip: int = 0,
        limit: int = 100,
    ) -> List[Transaction]:
        models = (
            self.session.query(TransactionModel)
            .filter(TransactionModel.user_id == user_id)
            .order_by(TransactionModel.transaction_date.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
        return [self._to_entity(model) for model in models]

    def get_by_user_and_date_range(
        self,
        user_id: int,
        start_date: datetime,
        end_date: datetime,
    ) -> List[Transaction]:
        models = (
            self.session.query(TransactionModel)
            .filter(
                TransactionModel.user_id == user_id,
                TransactionModel.transaction_date >= start_date,
                TransactionModel.transaction_date <= end_date,
            )
            .order_by(TransactionModel.transaction_date.asc())
            .all()
        )
        return [self._to_entity(model) for model in models]

    def get_by_user_and_type(
        self,
        user_id: int,
        transaction_type: TransactionType,
        skip: int = 0,
        limit: int = 100,
    ) -> List[Transaction]:
        models = (
            self.session.query(TransactionModel)
            .filter(
                TransactionModel.user_id == user_id,
                TransactionModel.type == transaction_type.value,
            )
            .order_by(TransactionModel.transaction_date.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
        return [self._to_entity(model) for model in models]

    def update(self, transaction: Transaction) -> Transaction:
        model = (
            self.session.query(TransactionModel)
            .filter(TransactionModel.id == transaction.id)
            .first()
        )
        if not model:
            raise ValueError(f"Transaction with id {transaction.id} not found")

        model.type = transaction.type.value
        model.amount = Decimal(str(transaction.amount))
        model.description = transaction.description
        model.transaction_date = transaction.transaction_date
        model.updated_at = datetime.now(ZoneInfo("UTC"))

        self.session.commit()
        self.session.refresh(model)
        return self._to_entity(model)

    def delete(self, transaction_id: int) -> bool:
        """Delete a transaction by id without loading the full entity."""
        delete_result = (
            self.session.query(TransactionModel)
            .filter(TransactionModel.id == transaction_id)
            .delete(synchronize_session=False)
        )
        if delete_result:
            self.session.commit()
            return True
        return False

    def delete_many(self, transaction_ids: List[int]) -> int:
        """Delete multiple transactions by ids."""
        if not transaction_ids:
            return 0

        delete_count = (
            self.session.query(TransactionModel)
            .filter(TransactionModel.id.in_(transaction_ids))
            .delete(synchronize_session=False)
        )
        if delete_count:
            self.session.commit()
        return delete_count

    def get_by_ids(self, transaction_ids: List[int]) -> List[Transaction]:
        """Fetch multiple transactions by their IDs."""
        if not transaction_ids:
            return []
        models = (
            self.session.query(TransactionModel)
            .filter(TransactionModel.id.in_(transaction_ids))
            .all()
        )
        return [self._to_entity(model) for model in models]

    def update_many(
        self,
        transaction_ids: List[int],
        values: Dict[str, Any],
    ) -> int:
        """Bulk update transactions."""
        if not transaction_ids or not values:
            return 0

        update_count = (
            self.session.query(TransactionModel)
            .filter(TransactionModel.id.in_(transaction_ids))
            .update(values, synchronize_session=False)
        )
        if update_count:
            self.session.commit()
        return update_count

    def get_user_balance(self, user_id: int) -> dict:
        income_sum = (
            self.session.query(func.coalesce(func.sum(TransactionModel.amount), 0))
            .filter(
                TransactionModel.user_id == user_id,
                TransactionModel.type == TransactionType.INCOME.value,
            )
            .scalar()
        )
        expense_sum = (
            self.session.query(func.coalesce(func.sum(TransactionModel.amount), 0))
            .filter(
                TransactionModel.user_id == user_id,
                TransactionModel.type == TransactionType.EXPENSE.value,
            )
            .scalar()
        )
        balance = Decimal(income_sum) - Decimal(expense_sum)
        return {
            "income": float(income_sum),
            "expense": float(expense_sum),
            "balance": float(balance),
        }

    def get_summary_by_type_and_date_range(
        self,
        user_id: int,
        start_date: datetime,
        end_date: datetime,
    ) -> dict:
        """Get sum of amounts grouped by transaction type within date range."""
        results = (
            self.session.query(
                TransactionModel.type,
                func.coalesce(func.sum(TransactionModel.amount), 0).label("total"),
            )
            .filter(
                TransactionModel.user_id == user_id,
                TransactionModel.transaction_date >= start_date,
                TransactionModel.transaction_date <= end_date,
            )
            .group_by(TransactionModel.type)
            .all()
        )

        summary = {}
        for transaction_type, total in results:
            summary[transaction_type] = float(total)

        # Ensure all types are present (with 0 if no transactions)
        for transaction_type in TransactionType:
            if transaction_type.value not in summary:
                summary[transaction_type.value] = 0.0

        return summary

    def get_summary_by_category_and_date_range(
        self,
        user_id: int,
        start_date: datetime,
        end_date: datetime,
        transaction_type: TransactionType,
    ) -> List[dict]:
        """Get total amount per category (joined with categories) within a date range.

        Transactions without a category are not included (loan type has no category).
        """
        results = (
            self.session.query(
                CategoryModel.id,
                CategoryModel.name,
                func.coalesce(func.sum(TransactionModel.amount), 0).label("total"),
            )
            .join(TransactionModel, TransactionModel.category_id == CategoryModel.id)
            .filter(
                TransactionModel.user_id == user_id,
                TransactionModel.type == transaction_type.value,
                TransactionModel.transaction_date >= start_date,
                TransactionModel.transaction_date <= end_date,
            )
            .group_by(CategoryModel.id, CategoryModel.name)
            .order_by(CategoryModel.id)
            .all()
        )

        return [
            {
                "category_id": category_id,
                "category_name": category_name,
                "total": float(total),
            }
            for category_id, category_name, total in results
        ]

    def get_by_user_and_date_range_with_filters(
        self,
        user_id: int,
        start_date: datetime,
        end_date: datetime,
        transaction_types: Optional[List[TransactionType]] = None,
        search_text: Optional[str] = None,
        category_id: Optional[int] = None,
        skip: int = 0,
        limit: int = 10,
    ) -> tuple[List[Transaction], int]:
        """Get transactions with filters and pagination."""
        query = (
            self.session.query(TransactionModel)
            .filter(
                TransactionModel.user_id == user_id,
                TransactionModel.transaction_date >= start_date,
                TransactionModel.transaction_date <= end_date,
            )
        )

        # Filter by transaction types if provided
        if transaction_types:
            type_values = [t.value for t in transaction_types]
            query = query.filter(TransactionModel.type.in_(type_values))

        # Filter by description search text (case-insensitive)
        if search_text:
            query = query.filter(
                TransactionModel.description.ilike(f"%{search_text}%")
            )

        # Filter by category if provided
        if category_id is not None:
            query = query.filter(TransactionModel.category_id == category_id)

        # Get total count before pagination
        total_count = query.count()

        # Apply pagination and ordering
        models = (
            query.order_by(TransactionModel.transaction_date.asc())
            .offset(skip)
            .limit(limit)
            .all()
        )

        transactions = [self._to_entity(model) for model in models]
        return transactions, total_count

    @staticmethod
    def _to_entity(model: TransactionModel) -> Transaction:
        return Transaction(
            id=model.id,
            user_id=model.user_id,
            type=TransactionType(model.type),
            amount=float(model.amount),
            description=model.description,
            transaction_date=model.transaction_date,
            created_at=model.created_at,
            updated_at=model.updated_at,
            category_id=model.category_id,
        )

    @staticmethod
    def _to_model(transaction: Transaction) -> TransactionModel:
        return TransactionModel(
            user_id=transaction.user_id,
            type=transaction.type.value
            if isinstance(transaction.type, TransactionType)
            else str(transaction.type),
            amount=Decimal(str(transaction.amount)),
            description=transaction.description,
            transaction_date=transaction.transaction_date,
            category_id=transaction.category_id,
        )

