from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.infrastructure.db import Base


class UserModel(Base):
    """SQLAlchemy model for the users table."""

    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    telegram_user_id = Column(BigInteger, unique=True, nullable=False, index=True)
    username = Column(String, nullable=True)
    first_name = Column(String, nullable=True)
    last_name = Column(String, nullable=True)
    language_code = Column(String(8), nullable=True)
    timezone = Column(String(64), nullable=True)
    currency = Column(String(3), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    transactions = relationship("TransactionModel", back_populates="user")


class TransactionModel(Base):
    """SQLAlchemy model for the transactions table."""

    __tablename__ = "transactions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    category_id = Column(Integer, ForeignKey("categories.id", ondelete="SET NULL"), nullable=True, index=True)
    type = Column(String(20), nullable=False)
    amount = Column(Numeric(18, 2), nullable=False)
    description = Column(String, nullable=True)
    transaction_date = Column(DateTime(timezone=True), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_transactions_amount_positive"),
    )

    user = relationship("UserModel", back_populates="transactions")
    category = relationship("CategoryModel", back_populates="transactions")


class CategoryModel(Base):
    """SQLAlchemy model for the categories table."""

    __tablename__ = "categories"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(50), unique=True, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    transactions = relationship("TransactionModel", back_populates="category")


class TaskModel(Base):
    """SQLAlchemy model for the tasks table (scheduled tasks/reminders).

    Mirrors FinlogBot's final schema after all Alembic migrations.  New tasks
    only use the modern columns (action, mode, scope, confirm, notify,
    skip_if_report_exists); legacy columns (task_type, skip_if_leave, kind)
    remain nullable for old rows migrated from the reminders table.
    """

    __tablename__ = "tasks"

    id = Column(String(12), primary_key=True)
    telegram_user_id = Column(BigInteger, nullable=False, index=True)
    chat_id = Column(BigInteger, nullable=False)
    time = Column(String(5), nullable=False)           # HH:MM
    repeat = Column(String(10), nullable=False)         # once / daily / weekly
    text = Column(Text, nullable=False)
    # Legacy columns — nullable for new rows, kept for old data.
    task_type = Column(String(20), nullable=True)
    weekdays = Column(String(20), nullable=True)
    skip_if_leave = Column(Boolean, nullable=True)
    kind = Column(String(20), nullable=True)
    verbatim = Column(Text, nullable=True)
    timezone = Column(String(64), nullable=True)
    created_at = Column(String(32), nullable=True)      # stored as string
    # Modern columns (added by rename migration).
    action = Column(String(30), nullable=False, server_default="")
    mode = Column(String(10), nullable=False, server_default="executor")
    scope = Column(String(20), nullable=False, server_default="today")
    confirm = Column(Boolean, nullable=False, server_default=func.text("false"))
    notify = Column(Boolean, nullable=False, server_default=func.text("false"))
    skip_if_report_exists = Column(Boolean, nullable=False, server_default=func.text("false"))

