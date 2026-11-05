// PROTOTYPE (#10): the floating variant bar. Not part of any design being judged.
import { useCallback, useEffect, useState } from "react";

// A generic hook: K is whatever string union the caller's keys are.
export function useVariant<K extends string>(keys: readonly K[]): [K, (k: K) => void] {
  const read = () => {
    const v = new URLSearchParams(location.search).get("variant");
    return keys.includes(v as K) ? (v as K) : keys[0]!;
  };
  const [variant, setState] = useState<K>(read);
  const set = useCallback((k: K) => {
    const url = new URL(location.href);
    url.searchParams.set("variant", k);
    // A full reload: each variant mounts TrueForgeUI with its own router setup.
    location.assign(url);
    setState(k);
  }, []);
  return [variant, set];
}

type Props<K extends string> = {
  variants: { key: K; name: string }[];
  current: K;
  onChange: (k: K) => void;
};

export function PrototypeSwitcher<K extends string>({ variants, current, onChange }: Props<K>) {
  const i = variants.findIndex((v) => v.key === current);
  // `%` with `+ length` wraps around in both directions.
  const step = useCallback(
    (d: number) => onChange(variants[(i + d + variants.length) % variants.length]!.key),
    [i, variants, onChange],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey); // cleanup runs on unmount
  }, [step]);

  if (import.meta.env.PROD) return null;
  const v = variants[i]!;
  return (
    <div className="fixed bottom-4 left-1/2 z-[9999] flex -translate-x-1/2 items-center gap-3 rounded-full bg-fuchsia-600 px-4 py-2 font-mono text-sm text-white shadow-xl">
      <button type="button" onClick={() => step(-1)} aria-label="Previous variant">
        ←
      </button>
      <span>
        {v.key} ({v.name})
      </span>
      <button type="button" onClick={() => step(1)} aria-label="Next variant">
        →
      </button>
    </div>
  );
}
