"""Engine factory. The engine is selected by DATABASE_URL — SQLite for
dev/small deployments, Postgres for prod. Modules use SQLAlchemy through
this factory and never name an engine."""

from sqlalchemy import MetaData, event
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

# Deterministic constraint names so Alembic migrations are portable.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

metadata = MetaData(naming_convention=NAMING_CONVENTION)


class Base(DeclarativeBase):
    """Declarative base for the APP's own models. Shares the kit metadata,
    so app tables and module tables are one schema: one alembic history,
    one autogenerate diff, the same naming conventions."""

    metadata = metadata


def make_engine(database_url: str) -> AsyncEngine:
    # pre_ping: a task cancelled mid-query (e.g. an SSE client disconnecting)
    # can poison its pooled connection; validate before reuse instead of
    # handing the corpse to the next caller. Found by the stream module.
    engine = create_async_engine(database_url, pool_pre_ping=True)

    if engine.dialect.name == "sqlite":

        @event.listens_for(engine.sync_engine, "connect")
        def _sqlite_pragmas(dbapi_connection, connection_record) -> None:
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA busy_timeout=5000")
            cursor.close()

    return engine


def make_session_factory(engine: AsyncEngine) -> async_sessionmaker:
    return async_sessionmaker(engine, expire_on_commit=False)
