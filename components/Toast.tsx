"use client";

export interface ToastItem {
  id: string;
  message: string;
  tone: "amber" | "sever";
}

export default function Toast({ toasts }: { toasts: ToastItem[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 items-end">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`animate-fadeUp font-mono text-xs px-3 py-2 rounded-md border shadow-lg backdrop-blur ${
            t.tone === "sever"
              ? "bg-sever/10 border-sever/40 text-sever"
              : "bg-amber/10 border-amber/40 text-amber"
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
