/**
 * #13033: when chatCore forces stream:false so a server-side web_search
 * fallback can run, the client that asked for Responses SSE still needs
 * `event: response.completed`. Reuse synthesizeOpenAiSseFromJson +
 * createResponsesApiTransformStream.
 */
import { createResponsesApiTransformStream } from "../../transformer/responsesTransformer.ts";
import { synthesizeOpenAiSseFromJson } from "../../utils/jsonToSse.ts";
import {
  buildNonStreamingResponsesSseResponse,
  synthesizeResponsesSseFromResponse,
} from "../../utils/responsesJsonToSse.ts";
import { buildNonStreamingJsonResponse } from "./nonStreamingJsonResponse.ts";

function copyForwardHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "content-type" || lower === "content-length") continue;
    out[key] = value;
  }
  return out;
}

export function wrapChatCompletionJsonAsResponsesSse(
  completion: Record<string, unknown>,
  headers?: Record<string, string>
): Response {
  const rawSse = synthesizeOpenAiSseFromJson(JSON.stringify(completion));
  if (!rawSse) {
    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...copyForwardHeaders(headers),
      },
    });
  }
  const encoder = new TextEncoder();
  const inputStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(rawSse));
      controller.close();
    },
  });
  const outputStream = inputStream.pipeThrough(createResponsesApiTransformStream());
  return new Response(outputStream, {
    status: 200,
    headers: {
      ...copyForwardHeaders(headers),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export function maybeWrapForcedNonStreamingResponsesJson(args: {
  clientRequestedResponsesStream: boolean;
  body: unknown;
  headers: Record<string, string>;
}): Response {
  const { clientRequestedResponsesStream, body, headers } = args;
  if (!clientRequestedResponsesStream || !body || typeof body !== "object" || Array.isArray(body)) {
    return buildNonStreamingJsonResponse(body, headers);
  }
  // A Responses-endpoint client already gets a Responses-shaped payload here
  // (`object: "response"` / `output[]`), which carries no `choices[]` for the
  // Chat Completions synthesizer below. Frame it directly as Responses SSE so
  // the tool items produced by the fallback survive (#13033).
  if (synthesizeResponsesSseFromResponse(body)) {
    return buildNonStreamingResponsesSseResponse(body, headers);
  }
  return wrapChatCompletionJsonAsResponsesSse(body as Record<string, unknown>, headers);
}
