import { describe, it, expect } from "vitest";
import { queryGraph, getGraphOverview, type Graph } from "./graph";

// A small, hand-built graph mirroring the assumed {nodes, edges} shape.
// Intentionally includes a node missing `name` -- that's not hypothetical,
// it's the exact shape that crashed queryGraph in production with
// "Cannot read properties of undefined (reading 'toLowerCase')" before the
// labelFor() fallback was added.
function buildGraph(): Graph {
  return {
    nodes: [
      { id: "n1", name: "handleRequest", type: "function", file: "server.go", line: 10 },
      { id: "n2", name: "parseInput", type: "function", file: "server.go", line: 30 },
      { id: "n3", name: "Logger", type: "class", file: "log.go" },
      // No `name` field -- matches real graphify output that doesn't always
      // populate it (e.g. a whole-file node).
      { id: "n4", file: "config.go", type: "module" } as any,
    ],
    edges: [
      { source: "n1", target: "n2", type: "calls" },
      { source: "n1", target: "n3", type: "imports" },
      { source: "n2", target: "n3", type: "imports" },
      // Dangling edge -- points at a node id that doesn't exist in `nodes`.
      // Real AST extraction can produce these (e.g. an external/stdlib call
      // that was recorded as an edge but never got its own node).
      { source: "n1", target: "n999", type: "calls" },
    ],
  };
}

describe("queryGraph", () => {
  it("returns nothing for an empty needle instead of matching everything", () => {
    const result = queryGraph(buildGraph(), { nodeName: "   " });
    expect(result.matchedNodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it("matches by case-insensitive substring on name", () => {
    const result = queryGraph(buildGraph(), { nodeName: "handlerequest" });
    expect(result.matchedNodes).toHaveLength(1);
    expect(result.matchedNodes[0].id).toBe("n1");
  });

  it("falls back to id when a node has no name, instead of throwing", () => {
    // This is the direct regression test for the real production crash:
    // n.name.toLowerCase() on a node with no `name` field.
    expect(() => queryGraph(buildGraph(), { nodeName: "n4" })).not.toThrow();
    const result = queryGraph(buildGraph(), { nodeName: "n4" });
    expect(result.matchedNodes.map((n) => n.id)).toContain("n4");
  });

  it("filters edges by edgeType when provided", () => {
    const result = queryGraph(buildGraph(), { nodeName: "handleRequest", edgeType: "calls" });
    expect(result.edges.every((e) => e.edge.type === "calls")).toBe(true);
    // n1 has one "calls" edge to n2 and one "calls" edge to the dangling n999
    expect(result.edges).toHaveLength(2);
  });

  it("reports edge direction correctly relative to the matched node", () => {
    const result = queryGraph(buildGraph(), { nodeName: "Logger" });
    // Logger (n3) is the *target* of edges from n1 and n2 -- those should
    // show as "in" from Logger's perspective, not "out".
    expect(result.edges.every((e) => e.direction === "in")).toBe(true);
  });

  it("resolves a dangling edge's neighbor to null instead of throwing", () => {
    const result = queryGraph(buildGraph(), { nodeName: "handleRequest" });
    const danglingEdge = result.edges.find((e) => e.edge.target === "n999");
    expect(danglingEdge).toBeDefined();
    expect(danglingEdge?.neighbor).toBeNull();
  });

  it("returns no matches for a name that isn't in the graph, without erroring", () => {
    const result = queryGraph(buildGraph(), { nodeName: "doesNotExist" });
    expect(result.matchedNodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});

describe("getGraphOverview", () => {
  it("counts total nodes and edges", () => {
    const overview = getGraphOverview(buildGraph());
    expect(overview.totalNodes).toBe(4);
    expect(overview.totalEdges).toBe(4);
  });

  it("buckets nodes by type, defaulting missing type to 'unknown'", () => {
    const overview = getGraphOverview(buildGraph());
    expect(overview.nodesByType.function).toBe(2);
    expect(overview.nodesByType.class).toBe(1);
    expect(overview.nodesByType.module).toBe(1);
  });

  it("ranks mostConnected by total degree (in + out), descending", () => {
    const overview = getGraphOverview(buildGraph());
    // n1: 3 out-edges (n2, n3, n999) = degree 3
    // n3: 2 in-edges (from n1, n2) = degree 2
    // n2: 1 in (from n1) + 1 out (to n3) = degree 2
    expect(overview.mostConnected[0].name).toBe("handleRequest");
    expect(overview.mostConnected[0].degree).toBe(3);
  });

  it("excludes zero-degree (unconnected) nodes from mostConnected", () => {
    const graph = buildGraph();
    graph.nodes.push({ id: "n5", name: "isolated", type: "function", file: "x.go" });
    const overview = getGraphOverview(graph);
    expect(overview.mostConnected.find((n) => n.name === "isolated")).toBeUndefined();
  });

  it("respects the limit parameter", () => {
    const overview = getGraphOverview(buildGraph(), 1);
    expect(overview.mostConnected).toHaveLength(1);
  });

  it("handles an empty graph without throwing", () => {
    const overview = getGraphOverview({ nodes: [], edges: [] });
    expect(overview.totalNodes).toBe(0);
    expect(overview.mostConnected).toEqual([]);
  });
});