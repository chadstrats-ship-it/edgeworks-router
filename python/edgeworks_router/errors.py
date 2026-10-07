"""Router exception hierarchy (spec §3, §5)."""
from __future__ import annotations


class RouterError(Exception):
    """Base class for every error the router raises."""


class RouterConfigError(RouterError):
    """routing.json is missing/invalid, or a pipeline name is unknown / not batchable."""


class PrefillNotSupported(RouterError):
    """Last message has role 'assistant' (prefill) -> 400 on Sonnet 5.5 / Opus 5.5. Raised before any send."""


class RouterInfraError(RouterError):
    """Retryable infra failure (429/529/5xx/timeout/network) persisted after max_retries on the SAME model."""

    def __init__(self, message: str, *, task_id: str | None = None, code: str | None = None,
                 retries: int = 0, cause: BaseException | None = None):
        super().__init__(message)
        self.task_id = task_id
        self.code = code
        self.retries = retries
        self.cause = cause


class RouterRequestError(RouterError):
    """Non-retryable 4xx: the request itself is wrong. Never escalated."""

    def __init__(self, message: str, *, task_id: str | None = None, status_code: int | None = None,
                 cause: BaseException | None = None):
        super().__init__(message)
        self.task_id = task_id
        self.status_code = status_code
        self.cause = cause


class SpendCapExceeded(RouterError):
    """Total logged cost_usd >= EDGEWORKS_ROUTER_SPEND_CAP_USD. Raised before a live call."""

    def __init__(self, total: float, cap: float):
        super().__init__(f"spend cap exceeded: total ${total:.6f} >= cap ${cap:.6f}")
        self.total = total
        self.cap = cap
