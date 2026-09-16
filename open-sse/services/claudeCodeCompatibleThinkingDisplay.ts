import { shouldRequestClaudeSummarizedThinking } from "../translator/request/openai-responses/helpers.ts";
import { CLAUDE_VISIBLE_REASONING_MARKER } from "../config/internalRequestMarkers.ts";

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

  const responsesRequestWantsVisibleThinking =
    options.normalizedBody?.[CLAUDE_VISIBLE_REASONING_MARKER] === true ||
    shouldRequestClaudeSummarizedThinking(getResponsesReasoningSummary(options.sourceBody));
  if (responsesRequestWantsVisibleThinking) {
    return {
      ...thinking,
      display: "summarized",
    };
  }

  const connectionRequestsSummary = options.summarizeThinking === true;
  if (!connectionRequestsSummary) {
    return thinking;
  }

  const hasExplicitDisplay =
    Object.prototype.hasOwnProperty.call(thinking, "display") &&
    thinking.display !== undefined &&
    thinking.display !== null &&
    String(thinking.display).trim().length > 0;
  if (hasExplicitDisplay) {
    return thinking;
  }

  return {
    ...thinking,
    display: "summarized",
  };
}

export function shouldStreamClaudeCodeCompatibleThinking(options: {
  sourceBody?: Record<string, unknown> | null;
  normalizedBody?: Record<string, unknown> | null;
}): boolean {
  return (
    options.normalizedBody?.[CLAUDE_VISIBLE_REASONING_MARKER] === true ||
    shouldRequestClaudeSummarizedThinking(getResponsesReasoningSummary(options.sourceBody))
  );
}
