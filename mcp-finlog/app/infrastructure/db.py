from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

from app.infrastructure.config import settings

Base = declarative_base()

_engine = None
_session_factory = None


def get_engine():
    """Create (once) the SQLAlchemy engine bound to settings.database_url.

    The engine is created lazily so importing this package does not require a
    valid DATABASE_URL (startup validation happens in index.py).
    """
    global _engine
    if _engine is None:
        if not settings.database_url:
            raise RuntimeError("DATABASE_URL is not set")
        _engine = create_engine(settings.database_url)
    return _engine


def get_session_factory():
    """Create (once) a sessionmaker bound to the engine."""
    global _session_factory
    if _session_factory is None:
        _session_factory = sessionmaker(
            autocommit=False, autoflush=False, bind=get_engine()
        )
    return _session_factory


def get_db():
    db = get_session_factory()()
    try:
        yield db
    finally:
        db.close()
