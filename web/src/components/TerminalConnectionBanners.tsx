// Shared connection-state banners for every terminal surface: the strip while the WS redials (only once the drop
// has outlasted a blip), and the restart strip for a dead or refused pane.

interface Props {
  connected: boolean;
  reconnecting: boolean;
  /** Disconnected for longer than a blip. */
  disconnectedLong: boolean;
  /** The server kept refusing the pane; redialing stopped. */
  gaveUp: boolean;
  onRetry: () => void;
  /** The pane's process exited; Restart re-ensures the session instead of just redialing. */
  paneDead?: boolean;
  onRestart?: () => void;
}

const LINK = "text-xs text-brand-500 hover:text-brand-400 cursor-pointer underline";
const ERROR_STRIP = "bg-status-error/10 border-b border-status-error/30 px-4 py-1.5 flex items-center gap-2 shrink-0";

export function TerminalConnectionBanners({
  connected,
  reconnecting,
  disconnectedLong,
  gaveUp,
  onRetry,
  paneDead,
  onRestart,
}: Props) {
  if (connected) return null;
  if (paneDead && onRestart) {
    return (
      <div className={ERROR_STRIP}>
        <span className="text-xs text-status-error">Agent exited</span>
        <button onClick={onRestart} className={LINK}>
          Restart
        </button>
      </div>
    );
  }
  if (gaveUp) {
    return (
      <div className={ERROR_STRIP}>
        <span className="text-xs text-status-error">Connection lost</span>
        <button onClick={onRestart ?? onRetry} className={LINK}>
          {onRestart ? "Restart" : "Retry"}
        </button>
      </div>
    );
  }
  if (reconnecting && disconnectedLong) {
    return (
      <div className="bg-status-waiting/15 border-b border-status-waiting/30 px-4 py-1.5 flex items-center gap-2 shrink-0">
        <span className="text-xs text-status-waiting">Reconnecting...</span>
        <button onClick={onRetry} className={LINK}>
          Retry now
        </button>
      </div>
    );
  }
  return null;
}
