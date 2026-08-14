import fs from "fs/promises";
import path from "path";
import { dropGraph } from "./graph";

export interface Session {
  id: string;
  repoUrl: string;
  path: string; // /tmp/sessions/{sessionId}
  graphPath: string; // {path}/graphify-out/graph.json
  lastActive: number;
  isGenerating: boolean;
  summary: string;
  // Gemini's Interactions API keeps conversation state server-side -- this is
  // the id of the last completed interaction in this session's thread, so the
  // next user message can continue it via previous_interaction_id instead of
  // starting a fresh, memory-less conversation every turn. OpenAI has no
  // equivalent here: an attempt to add one via the Responses API's
  // previousResponseId hit a real build failure (providerOptions isn't a
  // valid streamText() field on the installed ai package version) and was
  // reverted -- see lib/llm.ts and runOpenAiAgent in
  // app/api/chat/route.ts. OpenAI turns are stateless per-turn as a result.
  lastInteractionId?: string;
  // Clone and graph indexing are decoupled: a session becomes usable (chat
  // works, read_file works) the moment the clone finishes, not after
  // graphify too. This tracks the background indexing job separately so
  // query_graph can report "still indexing" instead of either blocking the
  // whole session start or crashing on a graph.json that doesn't exist yet.
  graphStatus: "pending" | "ready" | "failed";
  graphError?: string;
}

const SESSION_ROOT = "/tmp/sessions";
const IDLE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SWEEP_INTERVAL_MS = 60 * 1000; // check every minute

// A single in-memory Map is the entire "database." It intentionally does not
// survive a process restart -- that's the point of the ephemeral design.
//
// It's pinned to globalThis, not just a module-level `const`, because Next.js
// dev mode compiles each API route as its own on-demand bundle. A plain
// module-level Map can end up instantiated once per route bundle instead of
// once per process -- e.g. /api/init writes a session into "its" Map, then
// /api/chat compiles fresh moments later and reads from a different,
// unrelated Map instance, sees nothing, and returns 404. Storing it on
// globalThis guarantees one instance for the whole Node process regardless
// of how many separate bundles import this module. (Production builds don't
// have this problem, but there's no downside to the guard there either.)
declare global {
  // eslint-disable-next-line no-var
  var __sessions: Map<string, Session> | undefined;
}

const sessions: Map<string, Session> = globalThis.__sessions ?? new Map();
globalThis.__sessions = sessions;

function sweep() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActive > IDLE_TTL_MS) {
      void destroySession(id);
    }
  }
}

// Guard against the interval being registered twice in dev (HMR) by stashing
// it on globalThis.
declare global {
  // eslint-disable-next-line no-var
  var __sessionSweepTimer: NodeJS.Timeout | undefined;
}

if (!globalThis.__sessionSweepTimer) {
  globalThis.__sessionSweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
}

export function sessionDir(id: string): string {
  return path.join(SESSION_ROOT, id);
}

export function createSession(id: string, repoUrl: string): Session {
  const dir = sessionDir(id);
  const session: Session = {
    id,
    repoUrl,
    path: dir,
    graphPath: path.join(dir, "graphify-out", "graph.json"),
    lastActive: Date.now(),
    isGenerating: true,
    summary: "",
    graphStatus: "pending",
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function touchSession(id: string): void {
  const s = sessions.get(id);
  if (s) s.lastActive = Date.now();
}

export function setGenerating(id: string, value: boolean): void {
  const s = sessions.get(id);
  if (s) s.isGenerating = value;
}

export function setLastInteractionId(id: string, interactionId: string | undefined): void {
  const s = sessions.get(id);
  if (s) s.lastInteractionId = interactionId;
}

export function getExpiresAt(session: Session): number {
  return session.lastActive + IDLE_TTL_MS;
}

export function setGraphStatus(id: string, status: Session["graphStatus"], error?: string): void {
  const s = sessions.get(id);
  if (s) {
    s.graphStatus = status;
    s.graphError = error;
  }
}

export function setSummary(id: string, summary: string): void {
  const s = sessions.get(id);
  if (s) s.summary = summary;
}

export async function destroySession(id: string): Promise<void> {
  const session = sessions.get(id);
  sessions.delete(id);
  // Free the cached parsed graph.json alongside the session entry itself --
  // otherwise graphCache in lib/graph.ts keeps holding a full parsed graph
  // in memory for a session that no longer exists anywhere else, for as long
  // as the process stays up.
  dropGraph(id);
  if (session) {
    await fs.rm(session.path, { recursive: true, force: true }).catch(() => {
      // Directory may already be gone -- fine, GC's job is done either way.
    });
  }
}

export async function ensureSessionRoot(): Promise<void> {
  await fs.mkdir(SESSION_ROOT, { recursive: true });
}