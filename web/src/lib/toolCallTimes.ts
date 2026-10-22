// Minted once per tool call so a missing timestamp stays referentially stable across renders.
const TOOL_CALL_TIMES = new Map<string, string>();
// Stability only matters while a row can render, which the history window bounds; uncapped, this map keeps one
// entry per tool call ever rendered, across every session, for the tab's lifetime.
export const TOOL_CALL_TIMES_CAP = 8192;

export function toolCallTimestamp(id: string): string {
  let t = TOOL_CALL_TIMES.get(id);
  if (t === undefined) {
    t = new Date().toISOString();
    if (TOOL_CALL_TIMES.size >= TOOL_CALL_TIMES_CAP) {
      const oldest = TOOL_CALL_TIMES.keys().next().value;
      if (oldest !== undefined) TOOL_CALL_TIMES.delete(oldest);
    }
    TOOL_CALL_TIMES.set(id, t);
  }
  return t;
}

export function toolCallTimesSize(): number {
  return TOOL_CALL_TIMES.size;
}
