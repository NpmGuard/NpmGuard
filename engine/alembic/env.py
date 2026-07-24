"""Alembic env: sync engine over the async DATABASE_URL (standard practice
— migrations run sync). Scaffolded by kit add; owned by the app.

autogenerate compares target_metadata against the live database — every
table NOT imported below looks deleted to it and gets a DROP. The kit
block is maintained by kit add; keep your own models imported too."""

from sqlalchemy import create_engine

# kit:tables — vendored modules register their tables on import (kit add
# maintains this block; do not remove the marker comments)
import kit_llm  # noqa: F401
import kit_stream  # noqa: F401

# kit:tables:end
import npmguard.panel.tables  # noqa: F401,E402
import npmguard.persistence  # noqa: F401,E402
from alembic import context
from kit_spine.db import metadata
from npmguard.config import get_settings

url = get_settings().database_url.replace("+aiosqlite", "").replace("+asyncpg", "")

engine = create_engine(url)
with engine.connect() as connection:
    context.configure(connection=connection, target_metadata=metadata)
    with context.begin_transaction():
        context.run_migrations()
