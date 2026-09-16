import { shouldRequestClaudeSummarizedThinking } from "../translator/request/openai-responses/helpers.ts";

const COPILOT_REASONING_SUMMARY_MARKER = "_omnirouteCopilotReasoningSummary";

function getResponsesReasoningSummary(sourceBody?: Record<string, unknown> | null): unknown {
  const reasoning = sourceBody?.reasoning;
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) {
    return undefined;
  }
  return (reasoning as Record<string, unknown>).summary;
}

export function applyClaudeCodeCompatibleThinkingDisplay(
  thinking: Record<string, unknown>,
  options: {
    sourceBody?: Record<string, unknown> | null;
    normalizedBody?: Record<string, unknown> | null;
    summarizeThinking?: boolean;
  } = {}
) {
  if (thinking.type === "disabled") {
    return thinking;
  }

  const markerRequestsSummary =
    options.normalizedBody?.[COPILOT_REASONING_SUMMARY_MARKER] === "summarized";
  const responsesRequestSummary = shouldRequestClaudeSummarizedThinking(
    getResponsesReasoningSummary(options.sourceBody)
  );
  const connectionRequestsSummary = options.summarizeThinking === true;
  if (!markerRequestsSummary && !responsesRequestSummary && !connectionRequestsSummary) {
    return thinking;
  }

  const hasExplicitDisplay =
    Object.prototype.hasOwnProperty.call(thinking, "display") &&
    thinking.display !== undefined &&
    thinking.display !== null &&
    String(thinking.display).trim().length > 0;
  if (hasExplicitDisplay && !markerRequestsSummary && !responsesRequestSummary) {
    return thinking;
  }

  return {
    ...thinking,
    display: "summarized",
  };
}
