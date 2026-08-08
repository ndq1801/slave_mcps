from abc import ABC, abstractmethod
from typing import List, Optional

from app.domain.user.entities import User


class UserRepository(ABC):
    """Abstract repository interface for the User aggregate."""

    @abstractmethod
    def create(self, user: User) -> User:
        """Create a new user."""

    @abstractmethod
    def get_by_id(self, user_id: int) -> Optional[User]:
        """Fetch a user by primary key."""

    @abstractmethod
    def get_by_telegram_id(self, telegram_user_id: int) -> Optional[User]:
        """Fetch a user by Telegram user ID."""

    @abstractmethod
    def update(self, user: User) -> User:
        """Persist updates to a user entity."""

    @abstractmethod
    def delete(self, user_id: int) -> bool:
        """Delete a user and return True if deleted."""

    @abstractmethod
    def list_all(self, skip: int = 0, limit: int = 100) -> List[User]:
        """List users with pagination."""

