"""add skip_if_report_exists column for conditional notify tasks

Revision ID: e1f2a3b4c5d6
Revises: d2e3f4a5b6c7
Create Date: 2026-08-09 14:00:00.000000

Notify-only tasks can skip the reminder when today's report already exists
('chỉ nhắc khi chưa có báo cáo'). The legacy task_type='daily_report'
behavior is replaced by this explicit generic flag.

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e1f2a3b4c5d6'
down_revision: Union[str, None] = 'd2e3f4a5b6c7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'tasks',
        sa.Column('skip_if_report_exists', sa.Boolean(), nullable=False,
                  server_default=sa.text('false')),
    )


def downgrade() -> None:
    op.drop_column('tasks', 'skip_if_report_exists')
