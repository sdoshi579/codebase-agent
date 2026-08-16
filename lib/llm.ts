import { openai, createOpenAI } from "@ai-sdk/openai";

// Chat Completions, not the Responses API -- OpenAI turns are stateless
// per-turn (no cross-turn memory), unlike Gemini's lastInteractionId.
export function getOpenAiModel() {
  return openai("gpt-4o-mini");
}

export function isOpenAiProvider(): boolean {
  const provider = (process.env.LLM_PROVIDER ?? "gemini").toLowerCase();
  return provider === "openai";
}

// Fallback path, not a primary LLM_PROVIDER option -- used only when the
// primary Gemini path fails with a quota/rate-limit error mid-session (see
// isGeminiQuotaError() in app/api/chat/route.ts). OpenRouter's API is
// OpenAI-compatible, so this is a separate createOpenAI() instance pointed
// at a different baseURL. Same stateless-per-turn limitation as OpenAI above.
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