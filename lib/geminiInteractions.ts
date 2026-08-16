const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse";
const API_REVISION = "2026-05-20";
export const GEMINI_MODEL = "gemini-3.6-flash";

// Every tool name this project defines, in one place -- used below wherever
// the SSE parser needs to recognize "this step is a tool call" generically
// instead of hardcoding a single tool's name.
const KNOWN_TOOL_NAMES = new Set(["query_graph", "read_file", "graph_overview"]);

export const READ_FILE_TOOL = {
  type: "function" as const,
  name: "read_file",
  description:
    "Read the raw text of a file directly from the repo (README, package.json, go.mod, config, source code, etc). query_graph only sees AST metadata -- names, files, line numbers, edges -- it NEVER returns actual source code. To show a function's real implementation: first query_graph the function name to get its file and line, then call read_file with that path and startLine set to that line number to get the actual code around it.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path relative to the repo root, e.g. 'README.md' or 'src/handlers.go'.",
      },
      startLine: {
        type: "number",
        description:
          "Optional. 1-indexed line to center on -- use the `line` field from a query_graph match here to pull just that function's region instead of the whole file.",
      },
      endLine: {
        type: "number",
        description: "Optional. End of the range, if the region spans multiple known lines. Defaults to startLine.",
      },
    },
    required: ["path"],
  },
};

export const GRAPH_OVERVIEW_TOOL = {
  type: "function" as const,
  name: "graph_overview",
  description:
    "Get whole-graph stats: total nodes/edges, counts by type, and the most-connected nodes (by in+out edge count -- a defensible proxy for 'central' or 'important'). Use this for questions like 'what's the most important file', 'what's central to this codebase', or 'give me an overview' -- query_graph can't answer these, it only looks up one named node at a time.",
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "How many top-connected nodes to return. Defaults to 10.",
      },
    },
    required: [],
  },
};

export const QUERY_GRAPH_TOOL = {
  type: "function" as const,
  name: "query_graph",
  description:
    "Look up a node by name in the repo's AST graph and return its edges (calls/imports/extends/etc). Use before stating any code path.",
  parameters: {
    type: "object",
    properties: {
      nodeName: {
        type: "string",
        description: "Node name to search for, e.g. a function, class, or file.",
      },
      edgeType: {
        type: "string",
        description: "Optional edge type filter, e.g. 'calls', 'imports', 'extends'.",
      },
    },
    required: ["nodeName"],
  },
};

export function getGeminiApiKey(): string {
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) {
    throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set.");
  }
  return key;
}

export function isGeminiProvider(): boolean {
  const provider = (process.env.LLM_PROVIDER ?? "gemini").toLowerCase();
  return provider === "gemini" || provider === "google";
}

interface GeminiStreamEvent {
  event_type?: string;
  index?: number;
  // In-stream errors (quota exhaustion, safety blocks, etc) arrive as a
  // normal SSE `data:` event with event_type "error" inside an HTTP 200
  // response -- they are NOT surfaced as a non-2xx status, so the only way
  // to detect them is checking for this field on every parsed event. Missing
  // this was why a quota_exceeded error was silently swallowed: the stream
  // just ended with no text and no function calls, no exception thrown, so
  // nothing downstream (including the OpenRouter fallback) ever knew it failed.
  error?: {
    message?: string;
    code?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    arguments?: string;
    arguments_delta?: string;
    partial_arguments?: string;
    content?: unknown;
  };
  step?: {
    type?: string;
    name?: string;
    id?: string;
    arguments?: Record<string, unknown> | string;
  };
  interaction?: {
    id?: string;
    status?: string;
    steps?: Array<{
      type?: string;
      name?: string;
      id?: string;
      arguments?: Record<string, unknown>;
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };
}

export interface GeminiFunctionCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface StreamInteractionResult {
  interactionId: string;
  status: string;
  functionCalls: GeminiFunctionCall[];
}

type InteractionInput =
  | string
  | Array<{
      type: "function_result";
      name: string;
      call_id: string;
      result: { content: Array<{ type: "text"; text: string }> };
    }>;

interface StreamInteractionOptions {
  input: InteractionInput;
  systemInstruction?: string;
  previousInteractionId?: string;
  onTextDelta: (text: string) => void;
}

// Per the SSE spec, one logical event's data can span multiple `data:`
// lines within a single blank-line-delimited frame -- the reconstructed
// value joins those lines with "\n" between them, not concatenated bare.
// The previous version parsed each `data:` line as its own complete JSON
// payload, which happens to work when the server always emits compact
// (single-line) JSON per event, but would silently fail JSON.parse on every
// fragment (each individual line being invalid JSON on its own) if the
// server ever emitted a pretty-printed or otherwise multi-line payload --
// caught by the empty catch below and the whole event just vanishes. This
// accumulates all data: lines in one chunk into a single value first.
export function parseSseEvents(chunk: string): GeminiStreamEvent[] {
  const dataLines = chunk
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("data:"))
    .map((line) => line.trim().slice("data:".length).trim());

  if (dataLines.length === 0) return [];

  const combined = dataLines.join("\n");
  if (!combined) return [];

  try {
    return [JSON.parse(combined) as GeminiStreamEvent];
  } catch {
    return [];
  }
}

function extractDeltaText(event: any): string {
  if (!event || typeof event !== "object") return "";

  if (typeof event.text === "string") return event.text;
  if (typeof event.delta === "string") return event.delta;

  if (event.delta && typeof event.delta === "object") {
    if (typeof event.delta.text === "string") return event.delta.text;
    if (typeof event.delta.content === "string") return event.delta.content;
    if (Array.isArray(event.delta.content)) {
      const txt = event.delta.content
        .map((c: any) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : ""))
        .join("");
      if (txt) return txt;
    }
    if (Array.isArray(event.delta.parts)) {
      const txt = event.delta.parts
        .map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
        .join("");
      if (txt) return txt;
    }
  }

  if (Array.isArray(event.candidates) && event.candidates.length > 0) {
    const cand = event.candidates[0];
    if (cand) {
      if (typeof cand.text === "string") return cand.text;
      if (cand.delta) {
        if (typeof cand.delta.text === "string") return cand.delta.text;
        if (Array.isArray(cand.delta.parts)) {
          const txt = cand.delta.parts
            .map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
            .join("");
          if (txt) return txt;
        }
      }
      if (cand.content) {
        if (typeof cand.content === "string") return cand.content;
        if (Array.isArray(cand.content.parts)) {
          const txt = cand.content.parts
            .map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
            .join("");
          if (txt) return txt;
        }
      }
    }
  }

  if (event.step && typeof event.step === "object") {
    if (typeof event.step.text === "string") return event.step.text;
    if (event.step.delta && typeof event.step.delta.text === "string") return event.step.delta.text;
    if (Array.isArray(event.step.content)) {
      const txt = event.step.content
        .map((c: any) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : ""))
        .join("");
      if (txt) return txt;
    }
  }

  return "";
}

function extractTextFromSteps(interaction?: GeminiStreamEvent["interaction"]): string {
  if (!interaction) return "";
  const parts: string[] = [];

  if (Array.isArray(interaction.steps)) {
    for (const step of interaction.steps) {
      if (step.type === "function_call" || step.type === "tool_call" || (step.name && KNOWN_TOOL_NAMES.has(step.name))) continue;
      const text = extractDeltaText(step);
      if (text) parts.push(text);
    }
  }

  if (parts.length === 0) {
    const text = extractDeltaText(interaction);
    if (text) parts.push(text);
  }

  return parts.join("");
}

function parseArgumentsJson(raw: string): Record<string, unknown> {
  let trimmed = raw.trim();
  if (!trimmed) return {};
  trimmed = trimmed.replace(/^(\{\}\s*)+/, "");
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stepArgumentsToJson(args: Record<string, unknown> | string | undefined): string {
  if (!args) return "";
  if (typeof args === "string") return args;
  if (typeof args === "object" && Object.keys(args).length === 0) return "";
  return JSON.stringify(args);
}

function collectFunctionCalls(
  pendingByIndex: Map<
    number,
    { id?: string; name?: string; argsJson: string; parsedArgs?: Record<string, unknown> }
  >,
  lastInteraction?: GeminiStreamEvent["interaction"]
): GeminiFunctionCall[] {
  const calls: GeminiFunctionCall[] = [];

  if (lastInteraction?.steps) {
    for (const step of lastInteraction.steps) {
      const isFunctionCall =
        step.type === "function_call" ||
        step.type === "tool_call" ||
        (step.name !== undefined && KNOWN_TOOL_NAMES.has(step.name));
      if (isFunctionCall && step.id && step.name) {
        let args: Record<string, unknown> = {};
        if (typeof step.arguments === "object" && step.arguments !== null) {
          args = step.arguments;
        } else if (typeof step.arguments === "string") {
          args = parseArgumentsJson(step.arguments);
        }
        calls.push({
          id: step.id,
          name: step.name,
          arguments: args,
        });
      }
    }
    if (calls.length > 0) return calls;
  }

  for (const pending of pendingByIndex.values()) {
    if (!pending.name || !pending.id) continue;
    let args = pending.parsedArgs;
    if (!args || Object.keys(args).length === 0) {
      args = parseArgumentsJson(pending.argsJson);
    }
    calls.push({
      id: pending.id,
      name: pending.name,
      arguments: args,
    });
  }
  return calls;
}

export async function streamInteraction(
  options: StreamInteractionOptions
): Promise<StreamInteractionResult> {
  const body: Record<string, unknown> = {
    model: GEMINI_MODEL,
    input: options.input,
    stream: true,
    tools: [QUERY_GRAPH_TOOL, READ_FILE_TOOL, GRAPH_OVERVIEW_TOOL],
  };
  if (options.systemInstruction) {
    body.system_instruction = options.systemInstruction;
  }
  if (options.previousInteractionId) {
    body.previous_interaction_id = options.previousInteractionId;
  }

  console.log("\n==================== LLM REQUEST ====================");
  console.log("URL:", INTERACTIONS_URL);
  console.log("Model:", GEMINI_MODEL);
  console.log("Body:", JSON.stringify(body, null, 2));
  console.log("=====================================================\n");

  const res = await fetch(INTERACTIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": getGeminiApiKey(),
      "Api-Revision": API_REVISION,
    },
    body: JSON.stringify(body),
  });

  console.log(`[LLM Response Status] ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[LLM Response Error Detail]:", detail);
    throw new Error(`Gemini Interactions API ${res.status}: ${detail.slice(0, 500)}`);
  }
  if (!res.body) {
    throw new Error("Gemini Interactions API returned no response body.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let interactionId = "";
  let status = "in_progress";
  const pendingByIndex = new Map<
    number,
    { id?: string; name?: string; argsJson: string; parsedArgs?: Record<string, unknown> }
  >();
  let lastInteraction: GeminiStreamEvent["interaction"];
  let streamedText = "";

  while (true) {
    let value: Uint8Array | undefined;
    let done: boolean;
    try {
      ({ value, done } = await reader.read());
    } catch (err) {
      reader.releaseLock();
      throw err;
    }
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() ?? "";

    try {
      for (const chunk of chunks) {
        if (chunk.trim()) {
          console.log("[LLM SSE Chunk Received]:\n", chunk);
        }

        const events = parseSseEvents(chunk);
        for (const event of events) {
          console.log("[LLM SSE Parsed Event]:\n", JSON.stringify(event, null, 2));

          const textDelta = extractDeltaText(event);
          if (textDelta) {
            console.log(`[LLM Text Delta]: ${JSON.stringify(textDelta)}`);
            streamedText += textDelta;
            options.onTextDelta(textDelta);
          }

          const eventType = event.event_type;

          // Must be checked before anything else touches this event: a
          // quota/safety/server error mid-stream still has event_type "error"
          // wrapping a message + code, not a text delta or a step. Throwing
          // here is what lets app/api/chat/route.ts's isGeminiQuotaError()
          // actually see this failure and fall back to OpenRouter -- without
          // it, this event was silently ignored and the turn just came back
          // empty with status "in_progress" and no explanation.
          if (eventType === "error" || event.error) {
            const message = event.error?.message ?? "Unknown error from Gemini Interactions API stream.";
            const code = event.error?.code ?? "unknown";
            throw new Error(`Gemini Interactions API stream error (${code}): ${message}`);
          }

          if (eventType === "step.start" && (event.step?.type === "function_call" || (event.step?.name && KNOWN_TOOL_NAMES.has(event.step.name)))) {
            const idx = event.index ?? 0;
            const pending = pendingByIndex.get(idx) ?? { argsJson: "" };
            pending.id = event.step.id ?? pending.id;
            pending.name = event.step.name ?? pending.name;
            if (typeof event.step.arguments === "object" && event.step.arguments !== null) {
              if (Object.keys(event.step.arguments).length > 0) {
                pending.parsedArgs = event.step.arguments as Record<string, unknown>;
              }
            } else if (typeof event.step.arguments === "string" && event.step.arguments.trim().length > 0) {
              pending.argsJson = event.step.arguments;
            }
            pendingByIndex.set(idx, pending);
          }

          if (
            event.delta?.type === "arguments" ||
            event.delta?.type === "arguments_delta" ||
            event.delta?.arguments ||
            event.delta?.arguments_delta ||
            event.delta?.partial_arguments
          ) {
            const idx = event.index ?? 0;
            const pending = pendingByIndex.get(idx) ?? { argsJson: "" };
            pending.argsJson +=
              event.delta.partial_arguments ??
              event.delta.arguments_delta ??
              event.delta.arguments ??
              "";
            pendingByIndex.set(idx, pending);
          }

          if (event.interaction?.id) {
            interactionId = event.interaction.id;
          }
          if (event.interaction?.status) {
            status = event.interaction.status;
          }
          if (event.interaction) {
            lastInteraction = event.interaction;
          }

          if (eventType === "interaction.completed" || eventType === "interaction.complete") {
            if (lastInteraction?.status) status = lastInteraction.status;
          }
        }
      }
    } catch (err) {
      // Release the in-flight HTTP/2 stream reader before propagating --
      // otherwise a thrown error here leaks the connection instead of
      // letting fetch clean it up.
      await reader.cancel().catch(() => {});
      throw err;
    }
  }

  if (!interactionId) {
    interactionId = lastInteraction?.id ?? `auto_${Math.random().toString(36).slice(2)}`;
  }

  if (!streamedText) {
    const fallback = extractTextFromSteps(lastInteraction);
    if (fallback) {
      console.log(`[LLM Fallback Extracted Text]: ${JSON.stringify(fallback)}`);
      options.onTextDelta(fallback);
    }
  }

  const functionCalls = collectFunctionCalls(pendingByIndex, lastInteraction);

  console.log("\n==================== LLM RESPONSE COMPLETE ====================");
  console.log("Interaction ID:", interactionId);
  console.log("Status:", status);
  console.log("Streamed Text Length:", streamedText.length);
  console.log("Function Calls:", JSON.stringify(functionCalls, null, 2));
  console.log("===============================================================\n");

  return {
    interactionId,
    status,
    functionCalls,
  };
}