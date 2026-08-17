"""add reminders table for the telegram bot scheduler

Revision ID: b7e4d9f2a1c6
Revises: 8a2b9c1d3e5f
Create Date: 2026-08-09 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7e4d9f2a1c6'
down_revision: Union[str, None] = '8a2b9c1d3e5f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Table owned by the telegram assistant bot (assistant-bot repo); the bot
    # mirrors this schema in src/reminders_db.py and bootstraps it with
    # CREATE TABLE IF NOT EXISTS, so both sides must stay in sync.
    op.create_table(
        'reminders',
        sa.Column('id', sa.String(length=12), nullable=False),
        sa.Column('telegram_user_id', sa.BigInteger(), nullable=False),
        sa.Column('chat_id', sa.BigInteger(), nullable=False),
        sa.Column('time', sa.String(length=5), nullable=False),
        sa.Column('repeat', sa.String(length=10), nullable=False),
        sa.Column('text', sa.Text(), nullable=False),
        sa.Column('task_type', sa.String(length=20), nullable=False, server_default='text'),
        sa.Column('weekdays', sa.String(length=20), nullable=True),
        sa.Column('skip_if_leave', sa.Boolean(), nullable=False, server_default=sa.text('false')),
        sa.Column('kind', sa.String(length=20), nullable=False, server_default='spec'),
        sa.Column('verbatim', sa.Text(), nullable=True),
        sa.Column('timezone', sa.String(length=64), nullable=True),
        sa.Column('created_at', sa.String(length=32), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_reminders_telegram_user_id'), 'reminders', ['telegram_user_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_reminders_telegram_user_id'), table_name='reminders')
    op.drop_table('reminders')
