from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Optional
from zoneinfo import ZoneInfo


class TransactionType(Enum):
    """Transaction type enumeration."""

    INCOME = "income"
    EXPENSE = "expense"
    LOAN = "loan"


@dataclass
class Transaction:
    """Domain entity representing a financial transaction."""

    id: Optional[int]
    user_id: int
    type: TransactionType
    amount: float
    description: Optional[str]
    transaction_date: datetime
    created_at: datetime
    updated_at: Optional[datetime] = None
    category_id: Optional[int] = None

    def __post_init__(self) -> None:
        if self.id is None and self.created_at is None:
            self.created_at = datetime.now(ZoneInfo("UTC"))
        if self.transaction_date is None:
            self.transaction_date = datetime.now(ZoneInfo("UTC"))

