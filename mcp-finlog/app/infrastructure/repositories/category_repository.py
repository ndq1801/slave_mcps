from __future__ import annotations

from typing import List, Optional

from sqlalchemy.orm import Session

from app.infrastructure.models import CategoryModel


class SqlAlchemyCategoryRepository:
    """SQLAlchemy-backed helper for category persistence.

    FinlogBot has no category repository or domain entity; this thin helper is
    added for the mcp-finlog category tools (list/add/update/delete).
    """

    def __init__(self, session: Session) -> None:
        self.session = session

    def list_all(self) -> List[CategoryModel]:
        return (
            self.session.query(CategoryModel).order_by(CategoryModel.id).all()
        )

    def get_by_id(self, category_id: int) -> Optional[CategoryModel]:
        return (
            self.session.query(CategoryModel)
            .filter(CategoryModel.id == category_id)
            .first()
        )

    def get_by_name(self, name: str) -> Optional[CategoryModel]:
        return (
            self.session.query(CategoryModel)
            .filter(CategoryModel.name == name)
            .first()
        )

    def create(self, name: str) -> CategoryModel:
        model = CategoryModel(name=name)
        self.session.add(model)
        self.session.commit()
        self.session.refresh(model)
        return model

    def update_name(self, category_id: int, name: str) -> Optional[CategoryModel]:
        model = self.get_by_id(category_id)
        if not model:
            return None
        model.name = name
        self.session.commit()
        self.session.refresh(model)
        return model

    def delete(self, category_id: int) -> bool:
        """Delete a category; transactions referencing it become NULL via FK ON DELETE SET NULL."""
        delete_result = (
            self.session.query(CategoryModel)
            .filter(CategoryModel.id == category_id)
            .delete(synchronize_session=False)
        )
        if delete_result:
            self.session.commit()
            return True
        return False
