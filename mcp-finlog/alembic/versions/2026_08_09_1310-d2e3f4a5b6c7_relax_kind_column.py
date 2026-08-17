"""relax legacy kind column so new tasks store NULL

Revision ID: d2e3f4a5b6c7
Revises: c6d7e8f9a0b1
Create Date: 2026-08-09 13:10:00.000000

The legacy kind column (was NOT NULL with server_default 'spec') is unused
by new tasks; the bot's ORM mapping declares it nullable and inserts NULL.

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd2e3f4a5b6c7'
down_revision: Union[str, None] = 'c6d7e8f9a0b1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        'tasks', 'kind',
        existing_type=sa.String(length=20),
        existing_nullable=False,
        nullable=True,
        existing_server_default='spec',
        server_default=None,
    )


def downgrade() -> None:
    op.alter_column(
        'tasks', 'kind',
        existing_type=sa.String(length=20),
        existing_nullable=True,
        nullable=False,
        server_default='spec',
    )
