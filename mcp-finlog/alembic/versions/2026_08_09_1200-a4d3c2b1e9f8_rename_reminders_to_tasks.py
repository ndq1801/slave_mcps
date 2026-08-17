"""rename reminders to tasks and add generic action fields

Revision ID: a4d3c2b1e9f8
Revises: b7e4d9f2a1c6
Create Date: 2026-08-09 12:00:00.000000

The table stores scheduled TASKS (notify-only reminders or automated
actions executed at fire time), so it is renamed from reminders to tasks
and gains the generic execution fields: action, mode, scope, confirm, notify.

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a4d3c2b1e9f8'
down_revision: Union[str, None] = 'b7e4d9f2a1c6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.rename_table('reminders', 'tasks')
    # action: '' = notify-only reminder; 'complete_reports' = auto-complete
    # today's unfinished daily reports at fire time.
    op.add_column('tasks', sa.Column('action', sa.String(length=30), nullable=False, server_default=''))
    # mode: 'executor' = deterministic code path; 'agent' = LLM agent runs the
    # task's verbatim text with the available MCP tools at fire time.
    op.add_column('tasks', sa.Column('mode', sa.String(length=10), nullable=False, server_default='executor'))
    # scope: data window the task operates on ('today' by default, 'all' = no date limit).
    op.add_column('tasks', sa.Column('scope', sa.String(length=20), nullable=False, server_default='today'))
    # confirm: ask the user again at fire time before executing (executor mode only).
    op.add_column('tasks', sa.Column('confirm', sa.Boolean(), nullable=False, server_default=sa.text('false')))
    # notify: report the execution result back via Telegram after the run.
    op.add_column('tasks', sa.Column('notify', sa.Boolean(), nullable=False, server_default=sa.text('false')))
    # Legacy rows with kind='llm_decision' become agent-mode tasks: the agent
    # reads verbatim at fire time (replaces the old yes/no LLM gate).
    op.execute("UPDATE tasks SET mode = 'agent' WHERE kind = 'llm_decision'")
    op.execute('ALTER INDEX ix_reminders_telegram_user_id RENAME TO ix_tasks_telegram_user_id')


def downgrade() -> None:
    op.execute('ALTER INDEX ix_tasks_telegram_user_id RENAME TO ix_reminders_telegram_user_id')
    op.drop_column('tasks', 'notify')
    op.drop_column('tasks', 'confirm')
    op.drop_column('tasks', 'scope')
    op.drop_column('tasks', 'mode')
    op.drop_column('tasks', 'action')
    op.rename_table('tasks', 'reminders')
