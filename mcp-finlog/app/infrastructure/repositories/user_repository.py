from __future__ import annotations

from typing import List, Optional

from sqlalchemy.orm import Session

from app.domain.user.entities import User
from app.domain.user.repositories import UserRepository
from app.infrastructure.models import UserModel


class SqlAlchemyUserRepository(UserRepository):
    """SQLAlchemy-backed implementation of UserRepository."""

    def __init__(self, session: Session) -> None:
        self.session = session

    def create(self, user: User) -> User:
        model = UserModel(
            telegram_user_id=user.telegram_user_id,
            username=user.username,
            first_name=user.first_name,
            last_name=user.last_name,
            language_code=user.language_code,
            timezone=user.timezone,
            currency=user.currency,
        )
        self.session.add(model)
        self.session.commit()
        self.session.refresh(model)
        return self._to_entity(model)

    def get_by_id(self, user_id: int) -> Optional[User]:
        model = self.session.query(UserModel).filter(UserModel.id == user_id).first()
        return self._to_entity(model) if model else None

    def get_by_telegram_id(self, telegram_user_id: int) -> Optional[User]:
        model = (
            self.session.query(UserModel)
            .filter(UserModel.telegram_user_id == telegram_user_id)
            .first()
        )
        return self._to_entity(model) if model else None

    def update(self, user: User) -> User:
        model = self.session.query(UserModel).filter(UserModel.id == user.id).first()
        if not model:
            raise ValueError(f"User with id {user.id} not found")

        model.username = user.username
        model.first_name = user.first_name
        model.last_name = user.last_name
        model.language_code = user.language_code
        model.timezone = user.timezone
        model.currency = user.currency
        model.updated_at = user.updated_at

        self.session.commit()
        self.session.refresh(model)
        return self._to_entity(model)

    def delete(self, user_id: int) -> bool:
        model = self.session.query(UserModel).filter(UserModel.id == user_id).first()
        if not model:
            return False
        self.session.delete(model)
        self.session.commit()
        return True

    def list_all(self, skip: int = 0, limit: int = 100) -> List[User]:
        models = (
            self.session.query(UserModel)
            .offset(skip)
            .limit(limit)
            .all()
        )
        return [self._to_entity(model) for model in models]

    @staticmethod
    def _to_entity(model: UserModel) -> User:
        return User(
            id=model.id,
            telegram_user_id=model.telegram_user_id,
            username=model.username,
            first_name=model.first_name,
            last_name=model.last_name,
            language_code=model.language_code,
            timezone=model.timezone,
            currency=model.currency,
            created_at=model.created_at,
            updated_at=model.updated_at,
        )

