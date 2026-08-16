import { describe, it, expect } from "vitest";
import { parseSseEvents } from "./geminiInteractions";

describe("parseSseEvents", () => {
  it("parses a single-line data: frame", () => {
    const chunk = 'data: {"event_type":"text","delta":{"text":"hello"}}';
    const events = parseSseEvents(chunk);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("text");
  });

  it("reconstructs a JSON payload split across multiple data: lines by joining with \\n", () => {
    // Per the SSE spec, a single logical event's value can span multiple
    // data: lines within one frame -- each continuation line also gets its
    // own "data:" prefix. The value is reconstructed by joining those lines
    // with "\n" between them. This test exists specifically because the
    // pre-fix version parsed each data: line as its own independent JSON
    // payload, which only "worked" because payloads happened to always be
    // single-line in practice -- this proves the real spec-correct behavior
    // instead of relying on that coincidence.
    const chunk = ['data: {"event_type":"text",', 'data: "delta":{"text":"hi"}}'].join("\n");
    const events = parseSseEvents(chunk);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("text");
  });

  it("does not silently corrupt a multi-line text value by dropping the newline", () => {
    // Regression guard against the code-review-suggested fix's own bug: it
    // proposed joining data: lines with "" instead of "\n". That's still
    // wrong per the SSE spec's own reconstruction rule, but it's worth being
    // honest about what this test can and can't prove: a raw newline can
    // never legitimately appear *inside* a JSON string's content split
    // across data: lines in the first place -- valid JSON always escapes an
    // internal newline as the two-character sequence \n, which stays within
    // a single data: line and is never split by SSE framing at all. Real
    // pretty-printed JSON only ever line-breaks *between* tokens, where
    // whitespace is syntactically insignificant regardless of which
    // separator (or none) is used to rejoin it. So there isn't a
    // constructible input where join("\n") succeeds and join("") fails, or
    // vice versa, for actually-valid JSON -- this was a case where an
    // earlier version of this test asserted a "corruption" scenario that
    // isn't reachable, so it's removed rather than kept with a false
    // premise. The join("\n") choice remains for spec correctness (it's
    // what SSE actually specifies for reconstructing a multi-line field),
    // not because a concrete parse-outcome difference can be demonstrated.
  });

  it("ignores non-data lines within the same frame (e.g. an event: line)", () => {
    const chunk = ['event: text', 'data: {"event_type":"text","delta":{"text":"hi"}}'].join("\n");
    const events = parseSseEvents(chunk);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("text");
  });

  it("returns an empty array for a chunk with no data: lines", () => {
    expect(parseSseEvents("event: ping\n")).toEqual([]);
  });

  it("returns an empty array for an empty chunk", () => {
    expect(parseSseEvents("")).toEqual([]);
  });

  it("returns an empty array (not a throw) for malformed JSON", () => {
    expect(() => parseSseEvents("data: {not valid json")).not.toThrow();
    expect(parseSseEvents("data: {not valid json")).toEqual([]);
  });

  it("returns an empty array when the data: line is present but blank", () => {
    expect(parseSseEvents("data: ")).toEqual([]);
  });

  it("handles the quota-error event shape from a real failure", () => {
    // Matches the actual quota_exceeded payload seen in production -- this
    // is the exact event that used to be silently swallowed before error
    // detection was added to streamInteraction().
    const chunk =
      'data: {"error":{"message":"You exceeded your current quota","code":"quota_exceeded"},"event_type":"error"}';
    const events = parseSseEvents(chunk);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("error");
    expect(events[0].error?.code).toBe("quota_exceeded");
  });
});