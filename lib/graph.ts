import fs from "fs/promises";

export interface GraphNode {
  id: string;
  name: string;
  type: string; // function | class | module | variable, etc (graphifyy-defined)
  file: string;
  line?: number;
}

export interface GraphEdge {
  source: string; // node id
  target: string; // node id
  type: string; // calls | imports | extends | defines, etc
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Same globalThis-pinning reasoning as lib/sessions.ts -- without it this
// cache can silently fragment across Next.js dev's per-route bundles, which
// just means we re-parse graph.json on every chat turn instead of caching
// it. Not a correctness bug like the sessions/rateLimit ones, but pinning it
// keeps the "one instance per process" invariant consistent everywhere.
declare global {
  // eslint-disable-next-line no-var
  var __graphCache: Map<string, Graph> | undefined;
}

const graphCache: Map<string, Graph> = globalThis.__graphCache ?? new Map();
globalThis.__graphCache = graphCache;

export async function loadGraph(sessionId: string, graphPath: string): Promise<Graph> {
  const cached = graphCache.get(sessionId);
  if (cached) return cached;

  const raw = await fs.readFile(graphPath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<Graph> & Record<string, unknown>;

  // Defensive normalization: this project's assumed shape ({nodes, edges}) is
  // a guess at graphify's real output, and it was wrong -- a real run threw
  // "Cannot read properties of undefined (reading 'filter')" because the
  // parsed JSON had no `edges` array at all. Rather than crash every chat
  // turn on a schema mismatch, coerce missing/malformed arrays to empty ones
  // so a query just comes back with no results instead of a 500. This is a
  // stop-gap, not a fix -- see the TODO below once we know the real field
  // names graphify emits.
  if (!Array.isArray(parsed.nodes)) {
    console.warn(`[graph] graph.json for session ${sessionId} has no 'nodes' array. Top-level keys:`, Object.keys(parsed));
  }
  if (!Array.isArray((parsed as any).edges)) {
    console.warn(`[graph] graph.json for session ${sessionId} has no 'edges' array. Top-level keys:`, Object.keys(parsed));
  }

  const normalized: Graph = {
    nodes: Array.isArray(parsed.nodes) ? (parsed.nodes as GraphNode[]) : [],
    edges: Array.isArray((parsed as any).edges) ? ((parsed as any).edges as GraphEdge[]) : [],
  };

  graphCache.set(sessionId, normalized);
  return normalized;
}

export function dropGraph(sessionId: string): void {
  graphCache.delete(sessionId);
}

export interface QueryGraphArgs {
  nodeName: string;
  edgeType?: string;
}

export interface QueryGraphResult {
  matchedNodes: GraphNode[];
  edges: Array<{ edge: GraphEdge; neighbor: GraphNode | null; direction: "out" | "in" }>;
}

// The one tool the LLM gets. Deliberately narrow: given a node name (fuzzy,
// case-insensitive substring match) and an optional edge type filter, return
// the matching node(s) and their immediate neighbors. This keeps the LLM
// grounded in the deterministic AST graph instead of hallucinating call paths,
// and keeps each tool call's output small and cheap.
export function queryGraph(graph: Graph, args: QueryGraphArgs): QueryGraphResult {
  const needle = args.nodeName.trim().toLowerCase();
  if (!needle) {
    return { matchedNodes: [], edges: [] };
  }

  // Some nodes in real graphify output don't carry a `name` field (e.g. a
  // node representing a whole file, or a type graphifyy doesn't label the
  // way GraphNode assumes) -- n.name.toLowerCase() on those threw. Fall back
  // to id so such nodes are still findable by whatever string identifies
  // them, rather than either crashing or being silently unmatchable.
  const labelFor = (n: GraphNode) => (n.name ?? n.id ?? "").toLowerCase();

  const matchedNodes = graph.nodes.filter((n) => labelFor(n).includes(needle));
  const matchedIds = new Set(matchedNodes.map((n) => n.id));
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));

  const edges = graph.edges
    .filter((e) => matchedIds.has(e.source) || matchedIds.has(e.target))
    .filter((e) => !args.edgeType || e.type === args.edgeType)
    .map((e) => {
      const direction: "out" | "in" = matchedIds.has(e.source) ? "out" : "in";
      const neighborId = direction === "out" ? e.target : e.source;
      return { edge: e, neighbor: nodesById.get(neighborId) ?? null, direction };
    });

  return { matchedNodes, edges };
}

export interface GraphOverviewResult {
  totalNodes: number;
  totalEdges: number;
  nodesByType: Record<string, number>;
  // Degree centrality (in-edges + out-edges) as a proxy for "important" or
  // "central" -- not a claim about actual runtime significance, just an
  // honest, computable fact the model can cite instead of guessing. This is
  // the tool that was missing: query_graph only does name lookup, so a
  // question like "what's the most important file" had no grounded way to
  // be answered and the model was hallucinating a plausible-sounding but
  // empty README-based answer instead.
  mostConnected: Array<{ name: string; file: string; type: string; degree: number }>;
}

export function getGraphOverview(graph: Graph, limit = 10): GraphOverviewResult {
  const nodesByType: Record<string, number> = {};
  const degree = new Map<string, number>();

  for (const n of graph.nodes) {
    const type = n.type || "unknown";
    nodesByType[type] = (nodesByType[type] ?? 0) + 1;
    degree.set(n.id, 0);
  }
  for (const e of graph.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const mostConnected = [...graph.nodes]
    .map((n) => ({
      name: n.name ?? n.id ?? "",
      file: n.file ?? "",
      type: n.type ?? "unknown",
      degree: degree.get(n.id) ?? 0,
    }))
    .filter((n) => n.degree > 0)
    .sort((a, b) => b.degree - a.degree)
    .slice(0, limit);

  return {
    totalNodes: graph.nodes.length,
    totalEdges: graph.edges.length,
    nodesByType,
    mostConnected,
  };
}