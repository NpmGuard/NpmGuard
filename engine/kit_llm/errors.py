"""LLM error range: KIT-1100..1199 (modules claim ranges above KIT-1000,
CONVENTIONS.md)."""

from kit_spine import KitError


class BudgetExhausted(KitError):
    """The spend window is out of budget. Not machine-retryable — the
    window replenishes on the scale of hours, not requests."""

    code = "KIT-1101"
    http_status = 429


class EndOfRope(KitError):
    """Every model in the role's chain failed before a usable candidate
    (timeout, HTTP failure, or provider error envelope). The attributed
    attempt summary rides in details."""

    code = "KIT-1102"
    http_status = 503
    retryable = True


class OutputInvalid(KitError):
    """At least one model answered, but no candidate survived response,
    parse, semantic, and decode checks (bounded repairs included). Other
    models may also have failed at transport; the billed candidate remains
    the decisive distinction from EndOfRope."""

    code = "KIT-1103"
    http_status = 502
    retryable = True


class LoopBudgetExceeded(KitError):
    """An agentic run hit max_steps or max_cost_usd before producing a
    final answer. Provider attempts up to the cap remain captured."""

    code = "KIT-1104"
    http_status = 502


class ClientHookError(KitError):
    """A caller-supplied validate/decode/tool/token hook crashed.

    This is an application bug, not a candidate rejection: Kit must not spend
    money repairing or falling back after it.
    """

    code = "KIT-1105"
    http_status = 500


class CandidateRejected(Exception):
    """Explicitly reject a structurally parsed candidate from a client hook.

    Raising this from ``validate`` or ``decode`` enters Kit's bounded
    repair-then-model-fallback path. Any other hook exception becomes
    ``ClientHookError`` and aborts without another provider call.
    """
