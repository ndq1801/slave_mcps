"""Alembic environment for mcp-finlog.

Reads DATABASE_URL from the same pydantic-settings config used by the MCP
server (app.infrastructure.config.settings).  This avoids duplicating env
var parsing and guarantees migrations target the same database the server
connects to.
"""

from logging.config import fileConfig
from sqlalchemy import engine_from_config, pool
from alembic import context
import os
import sys

# Add project root to path so app.* imports resolve.
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from app.infrastructure.config import settings  # noqa: E402
from app.infrastructure.db import Base          # noqa: E402
# Import ALL models so Base.metadata knows about every table — required for
# autogenerate and for Alembic to stamp the correct head.
from app.infrastructure.models import UserModel, TransactionModel, CategoryModel  # noqa: E402,F401

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Override the placeholder sqlalchemy.url with the real DATABASE_URL.
config.set_main_option("sqlalchemy.url", settings.database_url)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (emit SQL to stdout, no live DB)."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations against a live database."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
