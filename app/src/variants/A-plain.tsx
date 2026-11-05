// PROTOTYPE (#10) variant A: the SDK alone. SingleAgent `cartographer`, sidebar
// layout, URL routing on. The question it answers: is the SDK's own UI (including
// its built-in Sessions browser and event timeline) already enough?
import { TrueForgeUI } from "@truefoundry/trueforge-ui";

// Hoisted so every render passes the same object: the SDK may treat a new
// object identity as a new config.
const SERVER = { type: "trueforge" } as const;
const AGENT = { mode: "SingleAgent", name: "cartographer" } as const;
const THEME = { preset: "trueforge", brand: { mode: "icon-title", name: "Cartographer" } } as const;

export function VariantA() {
  return (
    // The SDK fills its parent and sets no height: the parent must have one.
    <div className="h-dvh min-h-0 w-full">
      <TrueForgeUI
        server={SERVER}
        layout="sidebar"
        agentConfig={AGENT}
        theme={THEME}
        withRouter
        className="h-full min-h-0"
        onError={(e) => console.error("[TrueForgeUI]", e)}
      />
    </div>
  );
}
