"use client";

import { useState, FormEvent } from "react";

const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/;

export default function LandingForm({
  onSubmit,
}: {
  onSubmit: (repoUrl: string) => void;
}) {
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);

  const isValid = GITHUB_URL_RE.test(value.trim());
  const showError = touched && value.length > 0 && !isValid;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!isValid) return;
    onSubmit(value.trim());
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-xl">
        <div className="mb-10 text-center">
          <div className="inline-flex items-center gap-2 mb-4 text-inkFaint font-mono text-xs tracking-widest uppercase">
            <span className="w-1.5 h-1.5 rounded-full bg-graft" />
            graphify / chat
          </div>
          <h1 className="font-mono text-3xl sm:text-4xl font-semibold text-ink tracking-tight">
            Walk a repo&rsquo;s call graph
            <br />
            <span className="text-inkMuted">without reading it line by line.</span>
          </h1>
          <p className="mt-4 text-inkMuted text-sm max-w-md mx-auto">
            Point this at a public GitHub repo. It parses the AST into a graph,
            then answers questions grounded in that graph &mdash; not
            guesswork.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="relative">
          <div
            className={`flex items-center gap-2 rounded-lg border bg-panel px-4 py-3 font-mono text-sm transition-colors ${
              showError ? "border-sever" : "border-line focus-within:border-wire"
            }`}
          >
            <span className="text-graft select-none">$</span>
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="https://github.com/owner/repo"
              className="flex-1 bg-transparent outline-none text-ink placeholder:text-inkFaint"
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={!isValid}
              className="text-xs font-mono px-3 py-1.5 rounded-md bg-graftDim text-graft border border-graft/30 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-graft/20 transition-colors"
            >
              init
            </button>
          </div>
          {showError && (
            <p className="mt-2 text-xs font-mono text-sever">
              expected format: https://github.com/owner/repo
            </p>
          )}
        </form>

        <p className="mt-6 text-center text-inkFaint text-xs font-mono">
          no login &middot; no history &middot; session dies in 15 min
        </p>
      </div>
    </main>
  );
}
