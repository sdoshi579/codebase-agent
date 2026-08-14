"use client";

import { useEffect, useState } from "react";

interface Props {
  repoUrl: string;
  onDone: (sessionId: string, summary: string) => void;
  onError: (message: string) => void;
}

type StepStatus = "pending" | "active" | "done";

// Human-readable stages standing in for what's actually happening server-side
// (clone -> graphify's AST walk -> graph.json). There's no real per-stage
// progress signal from the backend today -- /api/init is one blocking call --
// so these are simulated on a timer while the real request runs in parallel,
// same as the old command-line version was. If /api/init is ever split into
// SSE progress events, replace the simulation below with real ones; the UI
// shape (steps + percent) is already set up for that.
const STEPS = [
  "Cloning repository",
  "Parsing folders & files",
  "Extracting functions & classes",
  "Resolving imports & calls",
  "Generating AST graph",
];

const STEP_INTERVAL_MS = 1400;
const SOFT_CAP_PERCENT = 92; // never claims done until the real response arrives
const PERCENT_TICK_MS = 120;

export default function TerminalLoader({ repoUrl, onDone, onError }: Props) {
  const [stepStatuses, setStepStatuses] = useState<StepStatus[]>(
    STEPS.map((_, i) => (i === 0 ? "active" : "pending"))
  );
  const [percent, setPercent] = useState(0);

  useEffect(() => {
    // Same AbortController pattern as before: React 18 Strict Mode (dev)
    // mounts/cleans up/remounts this effect once. Without actually aborting
    // the first pass's fetch, both passes' network calls complete in the
    // background and can race to update state -- see the earlier fix that
    // replaced a ref-guard (which broke this worse) with this.
    const controller = new AbortController();
    let cancelled = false;

    let activeStep = 0;
    const stepTimer = setInterval(() => {
      if (cancelled || activeStep >= STEPS.length - 1) {
        clearInterval(stepTimer);
        return;
      }
      const finishedStep = activeStep;
      activeStep += 1;
      setStepStatuses((prev) =>
        prev.map((s, i) => (i === finishedStep ? "done" : i === activeStep ? "active" : s))
      );
    }, STEP_INTERVAL_MS);

    // Asymptotically approaches SOFT_CAP_PERCENT but never claims completion
    // on its own -- only the real response finishing pushes it to 100.
    const percentTimer = setInterval(() => {
      if (cancelled) {
        clearInterval(percentTimer);
        return;
      }
      setPercent((prev) => {
        const next = prev + (SOFT_CAP_PERCENT - prev) * 0.04;
        return next > SOFT_CAP_PERCENT - 0.5 ? SOFT_CAP_PERCENT : next;
      });
    }, PERCENT_TICK_MS);

    (async () => {
      try {
        const res = await fetch("/api/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoUrl }),
          signal: controller.signal,
        });
        const data = await res.json();
        if (cancelled) return;

        clearInterval(stepTimer);
        clearInterval(percentTimer);

        if (!res.ok) {
          onError(data.error ?? "Failed to initialize repo.");
          return;
        }

        setStepStatuses(STEPS.map(() => "done"));
        setPercent(100);
        setTimeout(() => {
          if (!cancelled) onDone(data.sessionId, data.summary);
        }, 400);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        clearInterval(stepTimer);
        clearInterval(percentTimer);
        onError("Network error while reaching the server.");
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(stepTimer);
      clearInterval(percentTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoUrl]);

  const displayPercent = Math.round(percent);

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-xl rounded-lg border border-line bg-panel overflow-hidden">
        <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-line bg-panelRaised">
          <span className="w-2.5 h-2.5 rounded-full bg-line" />
          <span className="w-2.5 h-2.5 rounded-full bg-line" />
          <span className="w-2.5 h-2.5 rounded-full bg-line" />
          <span className="ml-2 text-inkFaint text-xs font-mono truncate flex-1">{repoUrl}</span>
          <span className="text-xs font-mono text-graft tabular-nums">{displayPercent}%</span>
        </div>

        {/* Progress bar tracks the same percent state as the number above */}
        <div className="h-0.5 bg-line/40">
          <div
            className="h-full bg-graft transition-[width] duration-150 ease-linear"
            style={{ width: `${displayPercent}%` }}
          />
        </div>

        <div className="p-5 space-y-3">
          {STEPS.map((label, i) => {
            const status = stepStatuses[i];
            return (
              <div key={label} className="flex items-center gap-3 animate-fadeUp">
                <StepIcon status={status} />
                <span
                  className={`font-mono text-sm ${
                    status === "done"
                      ? "text-graft"
                      : status === "active"
                      ? "text-ink"
                      : "text-inkFaint"
                  }`}
                >
                  {label}
                  {status === "active" && <span className="prompt-caret" />}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "done") {
    return (
      <span className="shrink-0 w-4 h-4 rounded-full bg-graftDim border border-graft/50 flex items-center justify-center">
        <span className="text-graft text-[10px] leading-none">✓</span>
      </span>
    );
  }
  if (status === "active") {
    return (
      <span
        className="shrink-0 w-4 h-4 rounded-full border-2 border-wire/30 border-t-wire animate-spin"
        aria-label="loading"
      />
    );
  }
  return <span className="shrink-0 w-4 h-4 rounded-full border border-line" />;
}