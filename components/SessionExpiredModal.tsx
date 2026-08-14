"use client";

export default function SessionExpiredModal({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-void/80 backdrop-blur-sm flex items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-lg border border-line bg-panel p-6 text-center">
        <div className="mx-auto mb-3 w-2 h-2 rounded-full bg-sever" />
        <h2 className="font-mono text-sm text-ink font-semibold mb-1">Session expired</h2>
        <p className="text-inkMuted text-sm mb-5">
          This session was idle past the 15-minute limit and its clone was
          garbage-collected. Start a new one.
        </p>
        <button
          onClick={onDismiss}
          className="font-mono text-xs px-4 py-2 rounded-md bg-graftDim text-graft border border-graft/30 hover:bg-graft/20 transition-colors"
        >
          back to landing
        </button>
      </div>
    </div>
  );
}
