// PROTOTYPE (#10), throwaway: lives only on the prototype/chat-app branch.
// Three variants of the Cartographer chat app on one route, switched by `?variant=`.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { PrototypeSwitcher, useVariant } from "./PrototypeSwitcher";
import { VariantA } from "./variants/A-plain";
import { VariantB } from "./variants/B-trace";
import { VariantC } from "./variants/C-bench";

const VARIANTS = {
  A: { name: "Plain SDK chat", Component: VariantA },
  B: { name: "Chat + live trace", Component: VariantB },
  C: { name: "Lab bench", Component: VariantC },
} as const;

// `keyof typeof X` is the union of X's keys: here "A" | "B" | "C".
type Key = keyof typeof VARIANTS;

function App() {
  const keys = Object.keys(VARIANTS) as Key[];
  const [variant, setVariant] = useVariant(keys);
  const { Component, name } = VARIANTS[variant];
  return (
    <>
      {/* `key` remounts the whole variant on switch, so no SDK state leaks between them. */}
      <Component key={variant} />
      <PrototypeSwitcher
        variants={keys.map((k) => ({ key: k, name: VARIANTS[k].name }))}
        current={variant}
        onChange={setVariant}
      />
    </>
  );
}

// The `!` asserts the element exists; index.html always has #root.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
