"use client";

import { useState } from "react";
import LandingForm from "@/components/LandingForm";
import TerminalLoader from "@/components/TerminalLoader";
import ChatInterface from "@/components/ChatInterface";

type Stage =
  | { name: "landing" }
  | { name: "loading"; repoUrl: string }
  | { name: "chat"; repoUrl: string; sessionId: string; summary: string };

export default function Home() {
  const [stage, setStage] = useState<Stage>({ name: "landing" });
  const [initError, setInitError] = useState<string | null>(null);

  if (stage.name === "landing") {
    return (
      <>
        <LandingForm
          onSubmit={(repoUrl) => {
            setInitError(null);
            setStage({ name: "loading", repoUrl });
          }}
        />
        {initError && (
          <div className="fixed bottom-5 left-1/2 -translate-x-1/2 font-mono text-xs px-3 py-2 rounded-md border border-sever/40 bg-sever/10 text-sever">
            {initError}
          </div>
        )}
      </>
    );
  }

  if (stage.name === "loading") {
    return (
      <TerminalLoader
        repoUrl={stage.repoUrl}
        onDone={(sessionId, summary) =>
          setStage({ name: "chat", repoUrl: stage.repoUrl, sessionId, summary })
        }
        onError={(message) => {
          setInitError(message);
          setStage({ name: "landing" });
        }}
      />
    );
  }

  return (
    <ChatInterface
      sessionId={stage.sessionId}
      repoUrl={stage.repoUrl}
      summary={stage.summary}
      onSessionExpired={() => setStage({ name: "landing" })}
    />
  );
}
