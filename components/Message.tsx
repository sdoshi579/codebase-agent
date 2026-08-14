"use client";

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import MermaidBlock from "./MermaidBlock";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: Array<{ nodeName: string; edgeType?: string; matches: number }>;
  // True while this assistant message is still receiving SSE token deltas.
  // Passed down to MermaidBlock so it can defer rendering until the fence is
  // actually complete -- rendering mermaid.render() against every partial,
  // syntactically-invalid intermediate state of a streaming diagram is what
  // caused visible layout jitter as each attempt succeeded/failed/resized.
  pending?: boolean;
}

export default function Message({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  // react-markdown's `components.code` isn't just a callback -- it's used
  // as an actual React component type for every <code> node. Defining it
  // inline (a fresh function literal on every render of Message) gives it a
  // new identity every render, and a new component TYPE at the same tree
  // position forces React to unmount the old instance and mount a new one,
  // not just re-render. ChatInterface ticks a `now` state every second for
  // the expiry countdown, which re-renders every Message in the list each
  // time -- so without this memo, MermaidBlock was being fully torn down
  // and rebuilt once a second, forever, independent of streaming ever
  // finishing: that's the post-streaming blink. Memoizing on `pending`
  // keeps the same identity across all those countdown-driven re-renders,
  // and only produces a new one at the one moment a fresh mount is actually
  // warranted (pending flipping from streaming to done).
  const components = useMemo(
    () => ({
      code(props: any) {
        const { className, children, ...rest } = props;
        const match = /language-(\w+)/.exec(className || "");
        const lang = match?.[1];
        if (lang === "mermaid") {
          return <MermaidBlock chart={String(children)} pending={message.pending} />;
        }
        return (
          <code className={className} {...rest}>
            {children}
          </code>
        );
      },
    }),
    [message.pending]
  );

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} animate-fadeUp`}>
      <div className={`max-w-[85%] ${isUser ? "" : "w-full"}`}>
        {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {message.toolCalls.map((tc, idx) => (
              <span
                key={idx}
                className="font-mono text-[11px] text-wire bg-wireDim/40 border border-wire/20 rounded px-1.5 py-0.5"
              >
                query_graph({tc.nodeName}
                {tc.edgeType ? `, ${tc.edgeType}` : ""}) → {tc.matches}
              </span>
            ))}
          </div>
        )}

        <div
          className={`rounded-lg px-4 py-2.5 text-sm ${
            isUser
              ? "bg-graftDim/50 border border-graft/20 text-ink font-mono"
              : "bg-panel border border-line text-ink"
          }`}
        >
          {isUser ? (
            <span>{message.content}</span>
          ) : (
            <div className="msg-prose">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                {message.content || "\u00A0"}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}