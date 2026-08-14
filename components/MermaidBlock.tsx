"use client";

import { useEffect, useRef, useState } from "react";

let mermaidInitialized = false;

interface Props {
  chart: string;
  // While true, this diagram is still receiving SSE token deltas -- the
  // fenced ```mermaid block is syntactically incomplete for most of that
  // window. Rendering on every partial state (as this used to) meant calling
  // mermaid.render() against invalid syntax dozens of times per diagram,
  // each attempt succeeding/failing/resizing differently -- that's what
  // produced the visible layout jitter. Now it renders exactly once, after
  // streaming for this message finishes.
  pending?: boolean;
}

export default function MermaidBlock({ chart, pending }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    if (pending) return; // wait for the fence to actually close

    let cancelled = false;

    (async () => {
      const mermaid = (await import("mermaid")).default;

      if (!mermaidInitialized) {
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          themeVariables: {
            background: "#10131a",
            primaryColor: "#161a22",
            primaryTextColor: "#e7e9ea",
            primaryBorderColor: "#2a3140",
            lineColor: "#565e6c",
            secondaryColor: "#1b3a5c",
            tertiaryColor: "#1f4a2a",
            fontFamily: "JetBrains Mono, monospace",
            fontSize: "13px",
          },
        });
        mermaidInitialized = true;
      }

      try {
        const { svg } = await mermaid.render(idRef.current, chart.trim());
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
        }
      } catch (err) {
        if (!cancelled) setError("Couldn't render this diagram (invalid Mermaid syntax).");
      }
    })();

    return () => {
      cancelled = true;
    };
    // Only re-run once pending flips to false (message complete) or the
    // final chart text changes at that point -- not on every intermediate
    // token while pending is true, since we return early above regardless.
  }, [chart, pending]);

  if (pending) {
    // Fixed-height skeleton, not a live re-render -- this is what actually
    // stops the jitter, since nothing here resizes as tokens keep arriving.
    return (
      <div className="mermaid-frame h-24 flex items-center justify-center">
        <span className="font-mono text-xs text-inkFaint prompt-caret">rendering diagram</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mermaid-frame">
        <p className="text-sever font-mono text-xs">{error}</p>
        <pre className="mt-2 text-inkFaint text-xs overflow-x-auto">{chart}</pre>
      </div>
    );
  }

  return <div className="mermaid-frame" ref={containerRef} />;
}