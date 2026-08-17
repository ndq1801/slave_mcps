"""relax legacy columns so new tasks store NULL instead of defaults

Revision ID: c6d7e8f9a0b1
Revises: a4d3c2b1e9f8
Create Date: 2026-08-09 13:00:00.000000

The legacy columns task_type / skip_if_leave were NOT NULL with server
defaults ('text' / false). New tasks never use them and the bot's ORM
inserts explicit NULL, so the columns become nullable without defaults
(the ORM mapping already declares them nullable).

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c6d7e8f9a0b1'
down_revision: Union[str, None] = 'a4d3c2b1e9f8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        'tasks', 'task_type',
        existing_type=sa.String(length=20),
        existing_nullable=False,
        nullable=True,
        existing_server_default='text',
        server_default=None,
    )
    op.alter_column(
        'tasks', 'skip_if_leave',
        existing_type=sa.Boolean(),
        existing_nullable=False,
        nullable=True,
        existing_server_default=sa.text('false'),
        server_default=None,
    )


def downgrade() -> None:
    op.alter_column(
        'tasks', 'task_type',
        existing_type=sa.String(length=20),
        existing_nullable=True,
        nullable=False,
        server_default='text',
    )
    op.alter_column(
        'tasks', 'skip_if_leave',
        existing_type=sa.Boolean(),
        existing_nullable=True,
        nullable=False,
        server_default=sa.text('false'),
    )
