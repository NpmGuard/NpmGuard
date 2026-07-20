"""LLM error range: KIT-1100..1199 (modules claim ranges above KIT-1000,
CONVENTIONS.md)."""

from kit_spine import KitError


class BudgetExhausted(KitError):
    """The spend window is out of budget. Not machine-retryable — the
    window replenishes on the scale of hours, not requests."""

    code = "KIT-1101"
    http_status = 429


class EndOfRope(KitError):
    """Every model in the role's chain failed at the transport level
    (timeout / HTTP error). The attempt summary rides in details."""

    code = "KIT-1102"
    http_status = 503
    retryable = True


class OutputInvalid(KitError):
    """Every model in the chain ANSWERED, but nothing survived the
    parser (repair retries included). Distinct from EndOfRope: these
    attempts were billed."""

    code = "KIT-1103"
    http_status = 502
    retryable = True


class LoopBudgetExceeded(KitError):
    """An agentic run hit max_steps or max_cost_usd before producing a
    final answer. The transcript up to the cap is fully captured."""

    code = "KIT-1104"
    http_status = 502
