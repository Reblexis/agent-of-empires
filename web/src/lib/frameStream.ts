// Client half of the live-view compressed frame stream (see the `caps`
// entry in src/server/live_ws.rs). The server sends binary WS messages
// carrying one connection-lifetime raw-deflate stream, sync-flushed per
// frame; the decompressed plaintext is a sequence of `u32-LE length ||
// frame JSON` records. One stream rather than per-message compression on
// purpose: consecutive frames are near-identical, so the shared dictionary
// turns each into back-references (delta encoding without diff
// bookkeeping), which is what keeps 60fps scroll bursts to a few hundred
// bytes per frame.

/** True when this browser can inflate the compressed frame stream; gates
 *  the client's `caps` advertisement, so unsupported browsers (and jsdom)
 *  simply keep receiving JSON text frames. */
export function supportsFrameDeflate(): boolean {
  return typeof DecompressionStream === "function";
}

export interface FrameInflater {
  /** Feed one binary WS message's bytes. Ordering is the caller's WS
   *  message order; the stream is inherently sequential. */
  push(chunk: ArrayBuffer): void;
  /** Tear down the stream (connection closed / hook unmounted). */
  dispose(): void;
}

/**
 * One inflater per WS connection. `onFrame` receives each decoded frame's
 * JSON text, in order. `onError` fires once on a corrupt stream (bad
 * record framing, inflate failure); the caller should drop the connection
 * and let its reconnect machinery redial, since a mid-stream inflate state
 * is unrecoverable.
 */
export function createFrameInflater(onFrame: (json: string) => void, onError: (err: unknown) => void): FrameInflater {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const decoder = new TextDecoder();
  // Inflate output accumulates as a chunk list, consumed via an offset
  // into the head chunk. The previous version grew one contiguous buffer
  // with a full realloc+copy per inflate chunk, which made the cost of a
  // frame quadratic in its chunk count: a 4000-line reading-mode frame
  // (~800KB, 13-50 inflate chunks) cycled 6-20MB of Uint8Array through
  // the allocator per frame, at 4 frames/s per terminal. With the list,
  // a record inside one chunk is a zero-copy subarray view and a record
  // spanning chunks allocates exactly its own size, so per-frame cost is
  // linear in frame size.
  let chunks: Uint8Array[] = [];
  let total = 0; // unconsumed bytes across `chunks`, from `offset`
  let offset = 0; // consumed bytes within chunks[0]
  let failed = false;
  const fail = (err: unknown) => {
    if (failed) return;
    failed = true;
    onError(err);
  };

  /** Byte at logical position `i` of the unconsumed stream. Caller
   *  guarantees `i < total`. */
  const byteAt = (i: number): number => {
    let idx = i + offset;
    for (const c of chunks) {
      if (idx < c.length) return c[idx]!;
      idx -= c.length;
    }
    return 0;
  };

  /** Consume `n` bytes. Zero-copy view when they sit inside the head
   *  chunk; otherwise one exact-size allocation. Caller guarantees
   *  `n <= total`. */
  const take = (n: number): Uint8Array => {
    total -= n;
    const head = chunks[0]!;
    if (head.length - offset >= n) {
      const out = head.subarray(offset, offset + n);
      offset += n;
      if (offset === head.length) {
        chunks.shift();
        offset = 0;
      }
      return out;
    }
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const c = chunks[0]!;
      const want = Math.min(c.length - offset, n - filled);
      out.set(c.subarray(offset, offset + want), filled);
      filled += want;
      offset += want;
      if (offset === c.length) {
        chunks.shift();
        offset = 0;
      }
    }
    return out;
  };

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value.length > 0) {
          chunks.push(value);
          total += value.length;
        }
        // Drain complete records; a record split across inflate chunks
        // just waits for the rest.
        while (total >= 4) {
          const len = (byteAt(0) | (byteAt(1) << 8) | (byteAt(2) << 16) | (byteAt(3) << 24)) >>> 0;
          if (total - 4 < len) break;
          take(4);
          onFrame(decoder.decode(take(len)));
        }
      }
    } catch (err) {
      fail(err);
    }
  })();

  // Serialize writes so at most one sits in the stream's queue: the WS
  // can no longer pile chunks into the DecompressionStream faster than
  // the reader loop drains frames on a busy main thread.
  let writeChain: Promise<unknown> = Promise.resolve();
  return {
    push(chunk: ArrayBuffer) {
      writeChain = writeChain.then(() => writer.write(new Uint8Array(chunk))).catch(fail);
    },
    dispose() {
      failed = true; // silence teardown-race errors from the reader loop
      chunks = [];
      total = 0;
      writer.abort().catch(() => {});
      reader.cancel().catch(() => {});
    },
  };
}
