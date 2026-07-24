"""GitHub repo dashboard panel.

The panel is a self-contained subpackage gated behind
``Settings.github_app_enabled``: without the GitHub App credentials the engine
runs exactly as it does today. Its persistent state lives as SQLAlchemy-core
tables declared in :mod:`npmguard.panel.tables` on the shared
``kit_spine.db.metadata`` — one schema, one alembic history.
"""
