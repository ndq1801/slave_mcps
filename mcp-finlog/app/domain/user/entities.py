from dataclasses import dataclass
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo


@dataclass
class User:
    """Domain entity representing a user."""

    id: Optional[int]
    telegram_user_id: int
    username: Optional[str]
    first_name: Optional[str]
    last_name: Optional[str]
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    language_code: Optional[str] = None
    timezone: Optional[str] = None
    currency: Optional[str] = None

    def __post_init__(self) -> None:
        if self.created_at is None:
            self.created_at = datetime.now(ZoneInfo("UTC"))

