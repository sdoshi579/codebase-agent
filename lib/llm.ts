import { openai, createOpenAI } from "@ai-sdk/openai";

// Use the Responses API (openai.responses(...)) rather than the classic Chat
// Completions wrapper so conversation state can be carried via
// previousResponseId -- the OpenAI-side equivalent of Gemini's
// previous_interaction_id. See runOpenAiAgent in app/api/chat/route.ts.
export function getOpenAiModel() {
  return openai.responses("gpt-4o-mini");
}

export function isOpenAiProvider(): boolean {
  const provider = (process.env.LLM_PROVIDER ?? "gemini").toLowerCase();
  return provider === "openai";
}

// --- Fallback path, not a primary LLM_PROVIDER option ---
//
// OpenRouter's API is OpenAI-compatible (Chat Completions, NOT the Responses
// API), so this is a separate createOpenAI() instance pointed at a different
// baseURL rather than a mode of getOpenAiModel() above. Used only when the
// primary Gemini path fails with a quota/rate-limit error mid-session -- see
// isGeminiQuotaError() and the fallback branch in app/api/chat/route.ts.
// Because it's Chat Completions, NOT Responses, there's no
// previousResponseId-style continuation available here: a turn served by
// this fallback is stateless, same as every turn was before conversation
// memory was added for the two primary providers.
const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

export function getOpenRouterModel() {
  // openrouter/free auto-selects an available free model, filtered to ones
  // that support tool calling -- required since we always pass query_graph.
  return openrouter("openrouter/free");
}

export function hasOpenRouterFallback(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}