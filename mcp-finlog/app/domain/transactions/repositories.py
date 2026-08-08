from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Dict, List, Optional

from app.domain.transactions.entities import Transaction, TransactionType


class TransactionRepository(ABC):
    """Abstract repository interface for Transactions."""

    @abstractmethod
    def create(self, transaction: Transaction) -> Transaction:
        """Store a new transaction."""

    @abstractmethod
    def create_many(self, transactions: List[Transaction]) -> List[Transaction]:
        """Store multiple transactions at once."""

    @abstractmethod
    def get_by_id(self, transaction_id: int) -> Optional[Transaction]:
        """Fetch transaction by ID."""

    @abstractmethod
    def get_by_user_id(
        self,
        user_id: int,
        skip: int = 0,
        limit: int = 100,
    ) -> List[Transaction]:
        """List transactions belonging to a user."""

    @abstractmethod
    def get_by_user_and_date_range(
        self,
        user_id: int,
        start_date: datetime,
        end_date: datetime,
    ) -> List[Transaction]:
        """List transactions within a date range."""

    @abstractmethod
    def get_by_user_and_type(
        self,
        user_id: int,
        transaction_type: TransactionType,
        skip: int = 0,
        limit: int = 100,
    ) -> List[Transaction]:
        """List transactions filtered by type."""

    @abstractmethod
    def update(self, transaction: Transaction) -> Transaction:
        """Persist updates to a transaction."""

    @abstractmethod
    def delete(self, transaction_id: int) -> bool:
        """Delete a transaction and return True if deleted."""

    @abstractmethod
    def delete_many(self, transaction_ids: List[int]) -> int:
        """Delete multiple transactions by ids and return number of deleted rows."""

    @abstractmethod
    def get_by_ids(self, transaction_ids: List[int]) -> List[Transaction]:
        """Fetch multiple transactions by their IDs."""

    @abstractmethod
    def update_many(
        self,
        transaction_ids: List[int],
        values: Dict[str, Any],
    ) -> int:
        """Bulk update transactions and return number of affected rows."""

    @abstractmethod
    def get_user_balance(self, user_id: int) -> dict:
        """Return user balance summary."""

    @abstractmethod
    def get_summary_by_type_and_date_range(
        self,
        user_id: int,
        start_date: datetime,
        end_date: datetime,
    ) -> dict:
        """Get sum of amounts grouped by transaction type within date range."""

    @abstractmethod
    def get_by_user_and_date_range_with_filters(
        self,
        user_id: int,
        start_date: datetime,
        end_date: datetime,
        transaction_types: Optional[List[TransactionType]] = None,
        search_text: Optional[str] = None,
        skip: int = 0,
        limit: int = 10,
    ) -> tuple[List[Transaction], int]:
        """
        Get transactions with filters and pagination.

        Args:
            search_text: If provided, filters transactions whose description
                         contains this text (case-insensitive).

        Returns:
            Tuple of (transactions list, total count)
        """

