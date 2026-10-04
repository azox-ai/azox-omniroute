/**
 * #13033: when chatCore forces stream:false so a server-side web_search
 * fallback can run, the client that asked for Responses SSE still needs
 * `event: response.completed`. Reuse synthesizeOpenAiSseFromJson +
 * createResponsesApiTransformStream.
 */
import { createResponsesApiTransformStream } from "../../transformer/responsesTransformer.ts";
import { synthesizeOpenAiSseFromJson } from "../../utils/jsonToSse.ts";
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

function wrapResponsesJsonAsSse(
  response: Record<string, unknown>,
  headers?: Record<string, string>
): Response {
  const output = response.output as Array<Record<string, unknown>>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let sequence = 0;
      const emit = (type: string, fields: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(
            `event: ${type}\ndata: ${JSON.stringify({ type, ...fields, sequence_number: ++sequence })}\n\n`
          )
        );
      };
      const initial = { ...response, status: "in_progress", output: [] };
      emit("response.created", { response: { ...initial, status: "in_progress" } });
      emit("response.in_progress", { response: initial });

      for (const [outputIndex, item] of output.entries()) {
        const id = item.id;
        const initialItem = { ...item, status: "in_progress" };
        if (item.type === "message") initialItem.content = [];
        if (item.type === "custom_tool_call") initialItem.input = "";
        if (item.type === "function_call") initialItem.arguments = "";
        emit("response.output_item.added", {
          output_index: outputIndex,
          item: initialItem,
        });
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const [contentIndex, part] of item.content.entries()) {
            if (!part || typeof part !== "object" || Array.isArray(part)) continue;
            const content = part as Record<string, unknown>;
            emit("response.content_part.added", {
              item_id: id,
              output_index: outputIndex,
              content_index: contentIndex,
              part: { ...content, ...(content.type === "output_text" ? { text: "" } : {}) },
            });
            if (content.type === "output_text" && typeof content.text === "string") {
              emit("response.output_text.delta", {
                item_id: id,
                output_index: outputIndex,
                content_index: contentIndex,
                delta: content.text,
              });
              emit("response.output_text.done", {
                item_id: id,
                output_index: outputIndex,
                content_index: contentIndex,
                text: content.text,
              });
            }
            emit("response.content_part.done", {
              item_id: id,
              output_index: outputIndex,
              content_index: contentIndex,
              part: content,
            });
          }
        } else if (item.type === "custom_tool_call" && typeof item.input === "string") {
          emit("response.custom_tool_call_input.delta", {
            item_id: id,
            output_index: outputIndex,
            delta: item.input,
          });
          emit("response.custom_tool_call_input.done", {
            item_id: id,
            output_index: outputIndex,
            input: item.input,
          });
        } else if (item.type === "function_call" && typeof item.arguments === "string") {
          emit("response.function_call_arguments.delta", {
            item_id: id,
            output_index: outputIndex,
            delta: item.arguments,
          });
          emit("response.function_call_arguments.done", {
            item_id: id,
            output_index: outputIndex,
            arguments: item.arguments,
          });
        }
        emit("response.output_item.done", { output_index: outputIndex, item });
      }
      const terminal =
        response.status === "completed"
          ? "response.completed"
          : response.status === "failed"
            ? "response.failed"
            : "response.incomplete";
      emit(terminal, { response });
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      ...copyForwardHeaders(headers),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
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
  const completion = body as Record<string, unknown>;
  if (
    completion.object === "response" &&
    (completion.status === "completed" ||
      completion.status === "failed" ||
      completion.status === "incomplete") &&
    Array.isArray(completion.output)
  ) {
    return wrapResponsesJsonAsSse(completion, headers);
  }
  return wrapChatCompletionJsonAsResponsesSse(completion, headers);
}
