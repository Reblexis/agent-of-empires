import { useCallback, useEffect, useEffectEvent, useRef } from "react";
import { useSnapshotStore } from "./useSnapshotStore";
import { listen } from "./domEvents";
import { getOrCreateDeviceBindingSecret } from "../lib/deviceBinding";
import { getToken } from "../lib/token";
import { buttonMouseBytes, wheelMouseBytes } from "../lib/liveMouse";
import { createFrameInflater, supportsFrameDeflate, type FrameInflater } from "../lib/frameStream";
import { MAX_RETRIES, retryDelayMs } from "../lib/wsBackoff";
import { reportTelemetrySeen } from "../lib/api";
import {
  noteGrid,
  recallFittingScreen,
  recallHistory,
  rememberHistory,
  rememberScreen,
  screenKey,
} from "../lib/screenCache";
import { HISTORY_CAP_LINES, mergeFrame, type HistoryCache } from "../lib/liveHistory";
import type { LiveClientMessage, LivePane0, LiveServerMessage } from "../lib/generated/liveWire";

export type { LiveCursor, LivePane0 as LivePaneRect } from "../lib/generated/liveWire";

const encodeControl = (message: LiveClientMessage) => JSON.stringify(message);

// Mirrors CLOSE_CODE_PTY_DEAD in src/server/pane.rs.
const CLOSE_CODE_PTY_DEAD = 4001;
// Mirrors CLOSE_CODE_SESSION_RENAMED and CLOSE_CODE_TRY_AGAIN_LATER in src/server/pane.rs.
const CLOSE_CODE_SESSION_RENAMED = 4002;
const CLOSE_CODE_TRY_AGAIN_LATER = 1013;
/** The server sends a heartbeat every 3 s; a connection silent for this long is dead. */
const STALE_AFTER_MS = 10_000;
const STALE_CHECK_MS = 2_000;
const CONNECT_TIMEOUT_MS = 8_000;
/** A second rename close this soon after a silent redial takes the ordinary retry path. */
const SILENT_REDIAL_MIN_GAP_MS = 2_000;
/** A drop that heals within this long shows no banner. */
const BANNER_DELAY_MS = 1_000;
const MAX_PENDING_INPUT_BYTES = 64 * 1024;
/** Floor between two scrollback downloads, so a pane whose history keeps failing to align cannot hold the server on
 *  the wide, slow window. */
const MIN_REDOWNLOAD_MS = 2000;

export interface LiveStats {
  frames: number;
  patches: number;
  wireBytes: number;
  resyncs: number;
}

type FrameMessage = Extract<LiveServerMessage, { type: "frame" }>;
type LiveDataMessage = Extract<LiveServerMessage, { type: "frame" | "patch" }>;
/** Longest a socket's first screens wait for the pane to take this page's size. */
const FIRST_SCREEN_HOLD_MS = 600;

export type LiveFrame = Omit<FrameMessage, "type" | "seq" | "pane0"> & {
  lines?: string[];
  seq?: number;
  receivedAt?: number;
  pane0?: LivePane0 | null;
  /** The grid this page had asked for when the frame was streamed at that size; null when streamed at another
   *  size (another device controls it); absent on a prefetched picture. */
  grid?: { cols: number; rows: number } | null;
};

export interface LiveTerminalState {
  connected: boolean;
  reconnecting: boolean;
  /** Disconnected for longer than a blip: the reconnecting banner may show. */
  disconnectedLong: boolean;
  /** The server kept refusing the pane; redialing stopped until Restart. */
  gaveUp: boolean;
  retryCount: number;
  retryCountdown: number;
  frame: LiveFrame | null;
  reading: boolean;
  isOwner: boolean;
  transport: "grid" | "snapshot" | null;
  /** The agent exited and left a dead pane; redialing cannot help until it is restarted. */
  paneDead: boolean;
  stats: LiveStats;
}

const INITIAL_STATE: LiveTerminalState = {
  connected: false,
  reconnecting: false,
  disconnectedLong: false,
  gaveUp: false,
  retryCount: 0,
  retryCountdown: 0,
  frame: null,
  reading: false,
  isOwner: false,
  transport: null,
  paneDead: false,
  stats: { frames: 0, patches: 0, wireBytes: 0, resyncs: 0 },
};

export function useLiveTerminal(
  sessionId: string | null,
  wsPath: string = "live-ws",
  onClipboard?: (text: string) => void,
) {
  const handleClipboard = useEffectEvent((text: string) => onClipboard?.(text));
  const wsRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryCountRef = useRef(0);
  // Consecutive closes where the server refused the pane (1013).
  const refusalsRef = useRef(0);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectRef = useRef<(() => void) | null>(null);
  const desiredRef = useRef<{
    resize: { cols: number; rows: number } | null;
    window: number | null;
    fast: boolean;
  }>({ resize: null, window: null, fast: true });
  const readingRef = useRef(false);
  const telemetrySeenRef = useRef(false);
  // Binary keystrokes and JSON paste messages, in send order.
  const pendingInputRef = useRef<(Uint8Array<ArrayBuffer> | string)[]>([]);
  // Local copy of the pane's scrollback (lib/liveHistory.ts). While it is incomplete the wire window is widened to the
  // full history (`downloadingRef`); otherwise the wire carries the component's live window and the copy is extended
  // from it.
  const historyRef = useRef<HistoryCache | null>(null);
  const downloadingRef = useRef(false);
  const lastDownloadRef = useRef(Number.NEGATIVE_INFINITY);
  const sentWindowRef = useRef<number | null>(null);
  // Whether the frame on screen came from the stream (not a remembered or prefetched stand-in).
  const streamShownRef = useRef(false);

  const { state, setState } = useSnapshotStore(() => INITIAL_STATE);

  const sendIfOpen = useCallback((data: string | ArrayBufferView<ArrayBuffer>) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(data);
  }, []);

  // The window actually requested from the server: the full history while the scrollback copy downloads, the
  // component's live window otherwise.
  const syncWindow = useCallback(() => {
    const lines = downloadingRef.current ? HISTORY_CAP_LINES : desiredRef.current.window;
    const ws = wsRef.current;
    if (lines == null || sentWindowRef.current === lines || ws?.readyState !== WebSocket.OPEN) return;
    sentWindowRef.current = lines;
    ws.send(encodeControl({ type: "window", lines }));
  }, []);

  const setWindowInternal = useCallback(
    (lines: number) => {
      if (desiredRef.current.window === lines) return;
      desiredRef.current.window = lines;
      syncWindow();
    },
    [syncWindow],
  );

  useEffect(() => {
    if (!sessionId) {
      pendingInputRef.current = [];
      return;
    }

    wsRef.current?.close();
    pendingInputRef.current = [];
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    retryCountRef.current = 0;
    refusalsRef.current = 0;
    // A screen this page showed before draws at once while the socket connects, over its remembered scrollback.
    const memoryKey = screenKey(sessionId, wsPath);
    historyRef.current = recallHistory(memoryKey) ?? null;
    downloadingRef.current = false;
    lastDownloadRef.current = Number.NEGATIVE_INFINITY;
    const recalled = recallFittingScreen(sessionId, wsPath);
    streamShownRef.current = false;
    // Display only: a prefetched screen carries no history count, so it must not replace the copy.
    const shown = recalled && historyRef.current ? mergeFrame(historyRef.current, recalled).frame : recalled;
    // Reading mode is the pane's choice (a restored reading position enters it before the stream starts), so the
    // state keeps agreeing with `readingRef`.
    setState(() => ({ ...INITIAL_STATE, frame: shown ?? null, reading: readingRef.current }));

    let disposed = false;
    const stats: LiveStats = { frames: 0, patches: 0, wireBytes: 0, resyncs: 0 };
    let inflater: FrameInflater | null = null;
    const disposeInflater = () => {
      inflater?.dispose();
      inflater = null;
    };
    let lastMessageAt = Date.now();
    let heartbeatSeen = false;
    let lastSilentRedial = Number.NEGATIVE_INFINITY;
    let openTimer: ReturnType<typeof setTimeout> | null = null;
    const detach = (ws: WebSocket) => {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.close();
    };

    /** The current socket is gone (closed, silent, or never opened): redial, or stop for a dead or refused pane. */
    function handleClosed(code: number) {
      disposeInflater();
      if (openTimer) clearTimeout(openTimer);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
      // The session moved to a new tmux name: the same terminal, one redial away.
      if (code === CLOSE_CODE_SESSION_RENAMED && Date.now() - lastSilentRedial >= SILENT_REDIAL_MIN_GAP_MS) {
        lastSilentRedial = Date.now();
        connect();
        return;
      }
      const paneDead = code === CLOSE_CODE_PTY_DEAD;
      if (code === CLOSE_CODE_TRY_AGAIN_LATER) refusalsRef.current += 1;
      const gaveUp = !paneDead && refusalsRef.current >= MAX_RETRIES;
      setState((prev) => ({ ...prev, connected: false, isOwner: false, paneDead, gaveUp }));
      if (paneDead || gaveUp) {
        if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
        setState((prev) => ({
          ...prev,
          reconnecting: false,
          disconnectedLong: false,
          retryCount: retryCountRef.current,
          retryCountdown: 0,
        }));
        return;
      }
      retryCountRef.current += 1;
      const count = retryCountRef.current;
      const delayMs = retryDelayMs(count);
      let countdown = Math.ceil(delayMs / 1000);
      setState((prev) => ({ ...prev, reconnecting: true, retryCount: count, retryCountdown: countdown }));
      bannerTimerRef.current ??= setTimeout(() => {
        bannerTimerRef.current = null;
        setState((prev) => (prev.connected || !prev.reconnecting ? prev : { ...prev, disconnectedLong: true }));
      }, BANNER_DELAY_MS);
      // Past the ladder a hidden tab waits for its visibility event instead of dialing every 10 s.
      if (count > MAX_RETRIES && document.visibilityState === "hidden") return;
      countdownRef.current = setInterval(() => {
        countdown -= 1;
        if (countdown > 0) {
          setState((prev) => ({ ...prev, retryCountdown: countdown }));
        }
      }, 1000);
      retryTimerRef.current = setTimeout(() => {
        if (countdownRef.current) clearInterval(countdownRef.current);
        connect();
      }, delayMs);
    }

    function connect() {
      if (disposed) return;
      disposeInflater();
      heartbeatSeen = false;
      lastMessageAt = Date.now();
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = wsPath.startsWith("/")
        ? `${proto}//${location.host}${wsPath}`
        : `${proto}//${location.host}/sessions/${sessionId}/${wsPath}`;
      const token = getToken();
      let bindingSecret: string | null = null;
      try {
        bindingSecret = getOrCreateDeviceBindingSecret();
      } catch {
        // Storage or crypto unavailable; let the server reject.
      }
      const protocols: string[] = ["aoe-auth"];
      if (token) protocols.push(token);
      if (bindingSecret) protocols.push(`aoe-device.${bindingSecret}`);
      const ws = new WebSocket(url, protocols);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      sentWindowRef.current = null;
      if (openTimer) clearTimeout(openTimer);
      openTimer = setTimeout(() => {
        if (wsRef.current !== ws || ws.readyState !== WebSocket.CONNECTING) return;
        detach(ws);
        handleClosed(0);
      }, CONNECT_TIMEOUT_MS);

      const flushPendingInput = () => {
        if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return;
        const pending = pendingInputRef.current;
        pendingInputRef.current = [];
        for (const data of pending) ws.send(data);
      };

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        if (openTimer) clearTimeout(openTimer);
        if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
        bannerTimerRef.current = null;
        lastMessageAt = Date.now();
        if (!telemetrySeenRef.current) {
          telemetrySeenRef.current = true;
          reportTelemetrySeen("web_terminal");
        }
        setState((prev) => ({
          ...prev,
          connected: true,
          reconnecting: false,
          disconnectedLong: false,
          gaveUp: false,
          paneDead: false,
        }));
        ws.send(encodeControl({ type: "claim_if_vacant" }));
        const desired = desiredRef.current;
        if (desired.resize) {
          ws.send(encodeControl({ type: "resize", ...desired.resize }));
        }
        // The pane may still have the size of whoever showed it last: its first screens wait for the resize.
        hold = { queue: [], replies: 0 };
        holdTimer = setTimeout(() => releaseHold(true), FIRST_SCREEN_HOLD_MS);
        syncWindow();
        ws.send(encodeControl({ type: "cadence", fast: desired.fast }));
        ws.send(encodeControl({ type: "caps", deflate: supportsFrameDeflate(), patch: true }));
        flushPendingInput();
      };

      let hasReceivedData = false;
      let lastSeq: number | null = null;
      // The last frame as the server sent it: patches apply to these rows, not to the rendered copy.
      let wireLines: string[] | null = null;
      let resyncPending = false;
      // Screens withheld since this socket opened, until the server has answered this page's resize (the reply to
      // `claim_if_vacant`, then the reply to `resize`, sent on open or once the terminal has measured itself) and,
      // when this page controls the size, a screen at that size arrived.
      let hold: { queue: LiveDataMessage[]; replies: number } | null = null;
      let owner = false;
      let holdTimer: ReturnType<typeof setTimeout> | null = null;
      const releaseHold = (force: boolean) => {
        if (!hold || wsRef.current !== ws) return;
        if (!force) {
          if (hold.replies < 2) return;
          const last = hold.queue.at(-1);
          if (owner && last?.rows !== desiredRef.current.resize?.rows) return;
        }
        const queue = hold.queue;
        hold = null;
        if (holdTimer) clearTimeout(holdTimer);
        holdTimer = null;
        for (const msg of queue) applyData(msg);
      };
      const handleMessageText = (text: string) => {
        if (wsRef.current !== ws) return;
        let msg: LiveServerMessage;
        try {
          msg = JSON.parse(text) as LiveServerMessage;
        } catch {
          return;
        }
        if (msg.type === "hb") {
          heartbeatSeen = true;
          return;
        }
        if (msg.type === "size_owner") {
          owner = msg.is_owner;
          const isOwner = owner;
          setState((prev) => (prev.isOwner === isOwner ? prev : { ...prev, isOwner }));
          if (hold) {
            hold.replies += 1;
            releaseHold(false);
          }
          return;
        }
        if (msg.type === "transport") {
          const transport = msg.grid ? "grid" : "snapshot";
          setState((prev) => (prev.transport === transport ? prev : { ...prev, transport }));
          return;
        }
        if (msg.type === "clipboard") {
          if (msg.text.length === 0) return;
          handleClipboard(msg.text);
          return;
        }
        if (msg.type !== "frame" && msg.type !== "patch") return;
        if (hold) {
          hold.queue.push(msg);
          releaseHold(false);
          return;
        }
        applyData(msg);
      };
      const applyData = (msg: LiveDataMessage) => {
        if (!hasReceivedData) {
          hasReceivedData = true;
          retryCountRef.current = 0;
          refusalsRef.current = 0;
        }
        let content: string;
        let lines: string[];
        if (msg.type === "patch") {
          if (wireLines == null || lastSeq == null || msg.base !== lastSeq) {
            if (!resyncPending) {
              resyncPending = true;
              stats.resyncs += 1;
              ws.send(encodeControl({ type: "resync" }));
            }
            return;
          }
          lines = applyPatch(wireLines, msg.shift, msg.lines);
          content = lines.join("\n") + "\n";
          stats.patches += 1;
        } else {
          content = msg.content;
          lines = frameLines(content);
          resyncPending = false;
          stats.frames += 1;
        }
        lastSeq = msg.seq;
        wireLines = lines;
        const grid = desiredRef.current.resize;
        const received: LiveFrame = {
          content,
          lines,
          seq: msg.seq,
          receivedAt: performance.now(),
          rows: msg.rows,
          history: msg.history,
          cursor: msg.cursor,
          altScreen: msg.altScreen,
          mouse: msg.mouse,
          mouseSgr: msg.mouseSgr,
          pane0: msg.pane0,
          grid: owner && grid && grid.rows === msg.rows ? { ...grid } : null,
        };
        streamShownRef.current = true;
        rememberScreen(memoryKey, received);
        // Splice the frame onto the local scrollback copy, and download the whole history (one wide frame) whenever
        // the copy is incomplete.
        const merged = mergeFrame(historyRef.current, received);
        historyRef.current = merged.cache;
        if (merged.cache) rememberHistory(memoryKey, merged.cache);
        const incoming = merged.frame;
        const now = Date.now();
        if (merged.complete) {
          if (downloadingRef.current) lastDownloadRef.current = now;
          downloadingRef.current = false;
        } else if (!downloadingRef.current && now - lastDownloadRef.current >= MIN_REDOWNLOAD_MS) {
          downloadingRef.current = true;
        }
        syncWindow();
        setState((prev) => ({
          ...prev,
          retryCount: retryCountRef.current,
          retryCountdown: 0,
          frame: incoming,
          stats: { ...stats },
        }));
      };

      ws.onmessage = (event: MessageEvent) => {
        if (wsRef.current !== ws) return;
        lastMessageAt = Date.now();
        if (typeof event.data === "string") {
          stats.wireBytes += event.data.length;
          handleMessageText(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          stats.wireBytes += event.data.byteLength;
          inflater ??= createFrameInflater(handleMessageText, () => ws.close());
          inflater.push(event.data);
        }
      };

      ws.onclose = (event: CloseEvent) => {
        if (disposed || wsRef.current !== ws) return;
        handleClosed(event.code);
      };
    }
    connectRef.current = connect;
    connect();

    // A socket can stay OPEN long after its network path died (sleep, a changed network): the browser reports
    // nothing, keys go nowhere. Silence past the heartbeat window is the only signal.
    const redialIfStale = () => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !heartbeatSeen) return false;
      if (Date.now() - lastMessageAt < STALE_AFTER_MS) return false;
      detach(ws);
      handleClosed(0);
      return true;
    };
    const staleTimer = setInterval(redialIfStale, STALE_CHECK_MS);

    const tryAutoReconnect = () => {
      if (redialIfStale()) return;
      const readyState = wsRef.current?.readyState;
      if (readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING) return;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
      retryCountRef.current = 0;
      refusalsRef.current = 0;
      connect();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") tryAutoReconnect();
    };
    const stopVisibility = listen(onVisibility, [document, "visibilitychange"]);
    const stopNetwork = listen(tryAutoReconnect, [window, "online"], [window, "pageshow"]);

    return () => {
      disposed = true;
      disposeInflater();
      stopVisibility();
      stopNetwork();
      clearInterval(staleTimer);
      if (openTimer) clearTimeout(openTimer);
      if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = null;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.close();
      }
      wsRef.current = null;
      connectRef.current = null;
    };
  }, [sessionId, wsPath, setState, syncWindow]);

  /** Whether `message` was sent or queued while connecting. Size ownership only controls resizing. */
  const sendInput = useCallback((message: Uint8Array<ArrayBuffer> | string): boolean => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(message);
      return true;
    }
    const size = (item: Uint8Array | string) =>
      typeof item === "string" ? new TextEncoder().encode(item).byteLength : item.byteLength;
    const pending = pendingInputRef.current;
    const used = pending.reduce((total, item) => total + size(item), 0);
    if (size(message) > MAX_PENDING_INPUT_BYTES - used) return false;
    pending.push(message);
    return true;
  }, []);

  const sendData = useCallback((data: string) => sendInput(new TextEncoder().encode(data)), [sendInput]);

  /** tmux pastes `text` (bracketed only if the pane asked for it), then presses Enter when `submit`. */
  const sendPaste = useCallback(
    (text: string, submit: boolean) => sendInput(encodeControl({ type: "paste", text, submit })),
    [sendInput],
  );

  const forwardWheel = useCallback(
    (up: boolean, sgr: boolean, col: number, row: number) => sendIfOpen(wheelMouseBytes(up, sgr, col, row)),
    [sendIfOpen],
  );

  const forwardButton = useCallback(
    (baseButton: number, release: boolean, motion: boolean, sgr: boolean, col: number, row: number) =>
      sendIfOpen(buttonMouseBytes(baseButton, release, motion, sgr, col, row)),
    [sendIfOpen],
  );

  const sendResize = useCallback(
    (cols: number, rows: number) => {
      const prev = desiredRef.current.resize;
      if (prev && prev.cols === cols && prev.rows === rows) return;
      // tmux re-wraps its whole history to a new width, so the copy is stale.
      if (prev && prev.cols !== cols) historyRef.current = null;
      desiredRef.current.resize = { cols, rows };
      noteGrid(wsPath, { cols, rows });
      // A stand-in drawn at another size comes down; the stream's first screen replaces it.
      if (!streamShownRef.current && sessionId && !recallFittingScreen(sessionId, wsPath)) {
        setState((prev) => (prev.frame ? { ...prev, frame: null } : prev));
      }
      sendIfOpen(encodeControl({ type: "resize", cols, rows }));
    },
    [sendIfOpen, sessionId, wsPath, setState],
  );

  const setWindow = useCallback((lines: number) => setWindowInternal(lines), [setWindowInternal]);

  const setCadence = useCallback(
    (fast: boolean) => {
      if (desiredRef.current.fast === fast) return;
      desiredRef.current.fast = fast;
      sendIfOpen(encodeControl({ type: "cadence", fast }));
    },
    [sendIfOpen],
  );

  /** The user left the live edge. Nothing goes to the server: the history they scroll through is the local copy. */
  const enterReading = useCallback(() => {
    if (readingRef.current) return;
    readingRef.current = true;
    setState((prev) => ({ ...prev, reading: true }));
  }, [setState]);

  const returnToLive = useCallback(
    (rows: number) => {
      if (!readingRef.current) return;
      readingRef.current = false;
      if (rows > 0) setWindowInternal(rows);
      setState((prev) => ({ ...prev, reading: false }));
    },
    [setState, setWindowInternal],
  );

  const manualReconnect = useCallback(() => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
    retryCountRef.current = 0;
    refusalsRef.current = 0;
    setState((prev) => ({
      ...prev,
      connected: false,
      reconnecting: true,
      gaveUp: false,
      retryCount: 0,
      retryCountdown: 0,
    }));
    const ws = wsRef.current;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connectRef.current?.();
    } else {
      ws.close();
    }
  }, [setState]);

  return {
    state,
    sendData,
    sendPaste,
    forwardWheel,
    forwardButton,
    sendResize,
    setWindow,
    setCadence,
    enterReading,
    returnToLive,
    manualReconnect,
    maxRetries: MAX_RETRIES,
  };
}

export function frameLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function applyPatch(prev: readonly string[], shift: number, changed: readonly [number, string][]): string[] {
  const n = prev.length;
  const k = Math.max(0, Math.min(n, Math.trunc(shift)));
  const next = prev.slice(k).concat(prev.slice(0, k).map(() => ""));
  for (const [i, row] of changed) {
    if (i >= 0 && i < n) next[i] = row;
  }
  return next;
}
