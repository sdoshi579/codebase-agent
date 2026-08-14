"use client";

import { useEffect, useRef, useState } from "react";
import Message, { ChatMessage } from "./Message";
import Toast, { ToastItem } from "./Toast";
import SessionExpiredModal from "./SessionExpiredModal";

interface Props {
  sessionId: string;
  repoUrl: string;
  summary: string;
  onSessionExpired: () => void;
}

type GraphStatus = "pending" | "ready" | "failed";

function uid() {
  return Math.random().toString(36).slice(2);
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function ChatInterface({ sessionId, repoUrl, summary: initialSummary, onSessionExpired }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [expired, setExpired] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [summary, setSummary] = useState(initialSummary);
  const [graphStatus, setGraphStatus] = useState<GraphStatus>("pending");
  const [graphError, setGraphError] = useState<string | undefined>();
  // Absolute timestamp (ms) the session will expire at, per the backend --
  // not computed locally, so it can never drift out of sync with the actual
  // 15-minute idle sweep. Only updated when the server says so: on mount
  // (via /api/status) and after every chat turn (via the "session" SSE
  // event) -- never by passive polling, so the countdown genuinely reflects
  // "time since last message," not "time since tab opened."
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Ticks the countdown display every second. Cheap and purely visual --
  // does not touch the server, so it can't itself extend the session.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Poll /api/status: once on mount to get the real expiresAt (the loading
  // screen never told us one) and the current graph-indexing state, then
  // repeatedly while indexing is still "pending" so the badge can flip to
  // ready/failed on its own. Stops polling once resolved -- this endpoint is
  // read-only and deliberately does not extend the session (see its own
  // comment), so there's no cost to polling, but no reason to keep polling
  // forever either once there's nothing left to learn.
  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    async function poll() {
      try {
        const res = await fetch(`/api/status?sessionId=${encodeURIComponent(sessionId)}`);
        if (cancelled) return;
        if (res.status === 404) {
          setExpired(true);
          if (pollTimer) clearInterval(pollTimer);
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;

        setGraphStatus(data.graphStatus ?? "pending");
        setGraphError(data.graphError);
        if (data.summary) setSummary(data.summary);
        if (typeof data.expiresAt === "number") setExpiresAt(data.expiresAt);

        if (data.graphStatus !== "pending" && pollTimer) {
          clearInterval(pollTimer);
        }
      } catch {
        // Transient network hiccup -- next tick tries again, no need to
        // surface this as a toast for a background poll.
      }
    }

    poll();
    pollTimer = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [sessionId]);

  function pushToast(message: string, tone: ToastItem["tone"] = "amber") {
    const id = uid();
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }

  async function sendMessage(text: string) {
    if (!text.trim() || isStreaming) return;

    const userMsg: ChatMessage = { id: uid(), role: "user", content: text.trim() };
    const assistantId = uid();
    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: assistantId, role: "assistant", content: "", toolCalls: [], pending: true },
    ]);
    setInput("");
    setIsStreaming(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: text.trim() }),
      });

      if (res.status === 404) {
        setExpired(true);
        setIsStreaming(false);
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, pending: false } : m)));
        return;
      }
      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        pushToast(data.error ?? "Rate limited. Slow down.", "amber");
        setIsStreaming(false);
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, pending: false } : m)));
        return;
      }
      if (!res.ok || !res.body) {
        pushToast("Request failed.", "sever");
        setIsStreaming(false);
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, pending: false } : m)));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const eventLine = chunk.split("\n").find((l) => l.startsWith("event:"));
          const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!eventLine || !dataLine) continue;

          const event = eventLine.replace("event:", "").trim();
          const data = JSON.parse(dataLine.replace("data:", "").trim());

          if (event === "token") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, content: m.content + data.text } : m
              )
            );
          } else if (event === "tool_call") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, toolCalls: [...(m.toolCalls ?? []), data] }
                  : m
              )
            );
          } else if (event === "session") {
            if (typeof data.expiresAt === "number") setExpiresAt(data.expiresAt);
          } else if (event === "error") {
            pushToast(data.message ?? "Agent error.", "sever");
          } else if (event === "done") {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, pending: false } : m))
            );
          }
        }
      }
    } catch {
      pushToast("Connection lost mid-stream.", "sever");
    } finally {
      setIsStreaming(false);
      // Safety net: if the stream ended without a "done"/"error" event
      // reaching the loop above (e.g. a dropped connection), don't leave the
      // mermaid block stuck on its "rendering diagram" placeholder forever.
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, pending: false } : m)));
    }
  }

  const countdownMs = expiresAt !== null ? expiresAt - now : null;

  return (
    <main className="min-h-screen flex flex-col">
      <header className="border-b border-line bg-panel px-4 sm:px-6 py-3 flex items-center gap-3">
        <span className="w-1.5 h-1.5 rounded-full bg-graft shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-xs text-ink truncate">{repoUrl}</p>
          <p className="font-mono text-[11px] text-inkFaint truncate">{summary}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {graphStatus === "pending" && (
            <span className="flex items-center gap-1.5 font-mono text-[11px] text-wire bg-wireDim/30 border border-wire/20 rounded px-2 py-1">
              <span className="w-2.5 h-2.5 rounded-full border-2 border-wire/30 border-t-wire animate-spin" />
              indexing graph
            </span>
          )}
          {graphStatus === "failed" && (
            <span
              className="font-mono text-[11px] text-amber bg-amber/10 border border-amber/30 rounded px-2 py-1"
              title={graphError}
            >
              ⚠ graph indexing failed
            </span>
          )}
          {countdownMs !== null && (
            <span
              className={`font-mono text-[11px] rounded px-2 py-1 border ${
                countdownMs < 60_000
                  ? "text-sever bg-sever/10 border-sever/30"
                  : "text-inkFaint bg-panelRaised border-line"
              }`}
              title="Time until this session is garbage-collected"
            >
              expires {formatCountdown(countdownMs)}
            </span>
          )}
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 space-y-4">
        {messages.length === 0 && (
          <div className="h-full flex items-center justify-center">
            <p className="text-inkFaint font-mono text-sm text-center max-w-sm">
              Ask about a function, a call chain, or how a request flows
              through this repo.
            </p>
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}
        {isStreaming && (
          <div className="font-mono text-xs text-inkFaint prompt-caret">thinking</div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendMessage(input);
        }}
        className="border-t border-line bg-panel px-4 sm:px-6 py-3"
      >
        <div className="flex items-center gap-2 rounded-lg border border-line focus-within:border-wire bg-void px-4 py-2.5 font-mono text-sm transition-colors">
          <span className="text-graft select-none">&gt;</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. what calls handleRequest?"
            className="flex-1 bg-transparent outline-none text-ink placeholder:text-inkFaint"
            spellCheck={false}
            autoComplete="off"
            disabled={isStreaming}
          />
          <button
            type="submit"
            disabled={isStreaming || !input.trim()}
            className="text-xs px-3 py-1 rounded-md bg-wireDim/60 text-wire border border-wire/30 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-wire/20 transition-colors"
          >
            send
          </button>
        </div>
      </form>

      <Toast toasts={toasts} />
      {expired && <SessionExpiredModal onDismiss={onSessionExpired} />}
    </main>
  );
}