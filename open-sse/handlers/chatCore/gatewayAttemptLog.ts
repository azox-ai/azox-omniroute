import { getHeaderValueCaseInsensitive } from "./headers.ts";

const MAX_FIELD_LENGTH = 256;

function boundedText(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).replace(/[\r\n]/g, "").trim();
  return text ? text.slice(0, MAX_FIELD_LENGTH) : null;
}

function accountAlias(
  selectedAlias: string | null | undefined,
  credentials: Record<string, unknown> | null | undefined,
  connectionId: string | null | undefined
): string | null {
  const candidates = [
    selectedAlias,
    credentials?.connectionName,
    credentials?.name,
    credentials?.displayName,
    credentials?.id,
    credentials?.connectionId,
    connectionId,
  ];
  for (const candidate of candidates) {
    const value = boundedText(candidate);
    if (value) return value;
  }
  return null;
}

export function buildGatewayAttemptLog(
  input: {
    correlationId?: string | null;
    clientHeaders?: Record<string, unknown> | Headers | null;
    comboName?: unknown;
    comboStepId?: unknown;
    provider?: string | null;
    model?: string | null;
    accountAlias?: string | null;
    credentials?: Record<string, unknown> | null;
    connectionId?: string | null;
    status: number;
    error?: string | null;
    startTime: number;
  },
  endTime = Date.now()
) {
  const correlationId =
    boundedText(input.correlationId) ||
    boundedText(getHeaderValueCaseInsensitive(input.clientHeaders, "x-correlation-id"));
  const status = Number.isFinite(input.status) ? input.status : 500;

  return {
    event: "llm_gateway.router_attempt",
    router: "omniroute",
    correlation_id: correlationId,
    key_alias: boundedText(
      getHeaderValueCaseInsensitive(input.clientHeaders, "x-llm-key-alias")
    ),
    team_alias: boundedText(
      getHeaderValueCaseInsensitive(input.clientHeaders, "x-llm-team-alias")
    ),
    combo: boundedText(input.comboName),
    attempt: boundedText(input.comboStepId),
    provider: boundedText(input.provider),
    model: boundedText(input.model),
    account: accountAlias(input.accountAlias, input.credentials, input.connectionId),
    status,
    outcome: status >= 200 && status < 400 && !input.error ? "success" : "failure",
    latency_ms: Math.max(0, endTime - input.startTime),
  };
}
