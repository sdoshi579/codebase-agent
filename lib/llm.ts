import { openai, createOpenAI } from "@ai-sdk/openai";

// Plain Chat Completions wrapper. openai.responses(...) (the Responses API)
// was tried here to enable previousResponseId conversation continuation,
// but that depended on a `providerOptions` field that doesn't exist on this
// installed `ai` package version's streamText() options -- a real build
// failure confirmed that, not a guess. Reverted to the well-established
// Chat Completions path since the only reason to use .responses() was that
// now-abandoned continuation attempt. OpenAI turns are stateless per-turn as
// a result; Gemini keeps its own, separately-implemented conversation memory
// (lastInteractionId), which has been tested against the real API and works.
export function getOpenAiModel() {
  return openai("gpt-4o-mini");
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