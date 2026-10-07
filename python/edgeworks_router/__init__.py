"""edgeworks-router (Python). Contract: ../../SPEC.md. Sonnet-first ladder with validated escalation to Opus."""
from .config import RoutingConfig, Step, router_home, routing_json_path
from .errors import (PrefillNotSupported, RouterConfigError, RouterError, RouterInfraError,
                     RouterRequestError, SpendCapExceeded)
from .router import (Attempt, RouteResult, Router, aroute, aroute_batch, default_router, new_task_id, route,
                     route_batch)
from .sinks import FileSink, MemorySink, NoopSink
from .validators import VALIDATORS, evaluate, register_validator

__all__ = [
    "Router", "RouteResult", "Attempt", "route", "aroute", "route_batch", "aroute_batch", "default_router",
    "new_task_id", "RoutingConfig", "Step", "router_home", "routing_json_path",
    "RouterError", "RouterConfigError", "RouterInfraError", "RouterRequestError", "SpendCapExceeded",
    "PrefillNotSupported", "FileSink", "MemorySink", "NoopSink", "VALIDATORS", "register_validator", "evaluate",
]
