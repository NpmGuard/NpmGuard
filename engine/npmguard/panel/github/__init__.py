"""GitHub App integration for the repo panel.

Two modules split by trust surface:

- :mod:`npmguard.panel.github.client` — the App identity: App-JWT-signed
  clients (``githubkit``), on-demand installation tokens (never persisted),
  the credential-free public client, and the user OAuth web flow.
- :mod:`npmguard.panel.github.content` — repo file access over the contents
  API (authenticated) and the public raw host (anonymous, SSRF-bounded).
"""
