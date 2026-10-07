// Error classes (SPEC §3, §5). Validation failures never throw — only infra/request/cap/prefill problems do.

export class RouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** routing.json invalid, unknown pipeline, non-batchable pipeline, empty ladder, bad custom_id, missing key/fetch. */
export class RouterConfigError extends RouterError {}

/** Retryable failure (429/529/5xx/timeout/network) persisted after max_retries on the SAME model. */
export class RouterInfraError extends RouterError {
  readonly code: string;
  readonly taskId: string | null;
  readonly model: string | null;
  readonly retries: number;
  constructor(message: string, info: { code: string; taskId?: string | null; model?: string | null; retries?: number }) {
    super(message);
    this.code = info.code;
    this.taskId = info.taskId ?? null;
    this.model = info.model ?? null;
    this.retries = info.retries ?? 0;
  }
}

/** Non-retryable HTTP 4xx (400/401/403/404/413/422/...): the request itself is wrong. Never escalates. */
export class RouterRequestError extends RouterError {
  readonly status: number | null;
  readonly taskId: string | null;
  readonly body: string | null;
  constructor(message: string, info: { status?: number | null; taskId?: string | null; body?: string | null } = {}) {
    super(message);
    this.status = info.status ?? null;
    this.taskId = info.taskId ?? null;
    this.body = info.body ?? null;
  }
}

export class SpendCapExceeded extends RouterError {
  readonly totalUsd: number;
  readonly capUsd: number;
  constructor(totalUsd: number, capUsd: number) {
    super(`spend cap exceeded: total $${totalUsd.toFixed(6)} >= cap $${capUsd.toFixed(6)}`);
    this.totalUsd = totalUsd;
    this.capUsd = capUsd;
  }
}

/** Last message has role "assistant" — prefill 400s on Sonnet 5.5 / Opus 5.5; never silently mutated. */
export class PrefillNotSupported extends RouterError {
  constructor(message = "assistant prefill (last message role 'assistant') is not supported by the routed models") {
    super(message);
  }
}
