"""Settings base. Apps subclass and add their own fields; validation runs at
process start — a bad config kills the process with a clear message."""

from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class KitSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: Literal["dev", "test", "prod"] = "dev"
    log_level: str = "info"
    # SQLite for dev/small deployments; Postgres (Supabase or any provider) for prod.
    database_url: str = "sqlite+aiosqlite:///./data/dev.sqlite3"
