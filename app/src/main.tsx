// The Cartographer chat app: TrueForge's chat UI on the left, a live trace of the open
// Session on the right.

import { TrueForgeUI } from "@truefoundry/trueforge-ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { historyFetch } from "./history-fetch";
import "./index.css";
import { findAgentId } from "./trace/client";
import { TracePanel } from "./trace/TracePanel";

const AGENT_NAME = "cartographer";
// Outside the component, so the object is the same on every render and the SDK keeps
// its one client instead of rebuilding it.
// The cast only answers Bun's `preconnect` addition to the type; browsers don't have it.
const SERVER = { type: "trueforge", fetch: historyFetch(AGENT_NAME, findAgentId) as typeof fetch } as const;

function App() {
  return (
    <div className="flex h-dvh min-h-0 w-full">
      <div className="min-h-0 min-w-0 flex-1">
        <TrueForgeUI
          server={SERVER}
          layout="sidebar"
          agentConfig={{ mode: "SingleAgent", name: AGENT_NAME }}
          theme={{ preset: "trueforge", brand: { mode: "icon-title", name: "Cartographer" } }}
          withRouter
          className="h-full min-h-0"
          onError={(error) => console.error("[TrueForgeUI]", error)}
        />
      </div>
      <TracePanel />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
