import { FORMATS } from "../../translator/formats.ts";

export function shouldRunServerOwnedToolLoop(input: {
  enabled: boolean;
  stream: boolean;
  isResponsesEndpoint: boolean;
  sourceFormat: string;
  responsesWebSearchFallback?: boolean;
}): boolean {
  if (!input.enabled) return false;
  if (input.stream) return false;
  if (input.responsesWebSearchFallback && input.sourceFormat === FORMATS.OPENAI_RESPONSES)
    return true;
  if (input.isResponsesEndpoint) return false;
  if (input.sourceFormat === FORMATS.OPENAI) return true;
  if (input.sourceFormat === FORMATS.CLAUDE) return true;
  return false;
}
