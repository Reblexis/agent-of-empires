import { useEffect, useState } from "react";
import { fetchCentral, setCentral, type CentralState } from "../lib/api";

const STATES: CentralState[] = ["paused", "running"];

/** Whether central is paused or running, as a two-part switch; clicking the
 *  other part runs the server's central hook and switches (docs/guides/central-pause.md). */
export function CentralSwitch() {
  const [state, setState] = useState<CentralState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetchCentral().then((s) => live && s && setState(s));
    return () => {
      live = false;
    };
  }, []);

  if (state === null) return null;

  const choose = async (next: CentralState) => {
    if (busy || next === state) return;
    setBusy(true);
    setError(null);
    const result = await setCentral(next);
    if (result.ok) setState(next);
    else setError(result.error);
    setBusy(false);
  };

  return (
    <div className="px-3 pb-2" aria-label="Central agent">
      <div className="flex items-center gap-1">
        <span className="text-xs text-text-dim pr-1">Central</span>
        {STATES.map((s) => (
          <button
            key={s}
            type="button"
            aria-label={`central ${s}`}
            aria-pressed={state === s}
            disabled={busy}
            onClick={() => choose(s)}
            className={`flex-1 rounded-md px-2 py-1.5 text-xs cursor-pointer transition-colors ${
              state === s
                ? "bg-brand-500/15 text-brand-500"
                : "text-text-dim hover:text-text-secondary hover:bg-surface-700/40"
            }`}
          >
            {busy && state !== s ? "Switching..." : s === "paused" ? "Paused" : "Running"}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-400 break-words">
          {error}
        </p>
      )}
    </div>
  );
}
