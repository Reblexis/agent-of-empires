// @vitest-environment node
//
// Client half of the compressed live-frame stream. The server side is a
// connection-lifetime raw-deflate stream sync-flushed per frame
// (FrameDeflater in src/server/live_ws.rs, unit-tested there); node's zlib
// speaks the same format, so these tests produce real sync-flushed chunks
// and assert the inflater re-splits the plaintext records correctly.

import { describe, expect, it, vi } from "vitest";
import zlib from "node:zlib";
import { createFrameInflater, supportsFrameDeflate } from "./frameStream";

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/** Streaming raw-deflate that emits one sync-flushed chunk per frame,
 *  mirroring the server's FrameDeflater (shared dictionary across calls). */
function makeDeflater() {
  const stream = zlib.createDeflateRaw();
  const pending: Buffer[] = [];
  stream.on("data", (c: Buffer) => pending.push(c));
  return (json: string): Promise<Uint8Array> => {
    const body = Buffer.from(json, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(body.length, 0);
    stream.write(Buffer.concat([len, body]));
    return new Promise((resolve) => {
      stream.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        resolve(new Uint8Array(Buffer.concat(pending.splice(0))));
      });
    });
  };
}

describe("frameStream", () => {
  it("advertises support where DecompressionStream exists", () => {
    expect(supportsFrameDeflate()).toBe(true);
  });

  it("decodes sequential frames in order through one stream", async () => {
    const deflate = makeDeflater();
    const frames: string[] = [];
    const onError = vi.fn();
    const inflater = createFrameInflater((f) => frames.push(f), onError);
    const f1 = JSON.stringify({ type: "frame", content: "line one\n".repeat(50), rows: 24 });
    const f2 = JSON.stringify({ type: "frame", content: "line one\n".repeat(49) + "line two\n", rows: 24 });
    inflater.push(toArrayBuffer(await deflate(f1)));
    inflater.push(toArrayBuffer(await deflate(f2)));
    await vi.waitFor(() => expect(frames).toEqual([f1, f2]));
    expect(onError).not.toHaveBeenCalled();
    inflater.dispose();
  });

  it("reassembles a record split across pushed chunks", async () => {
    const deflate = makeDeflater();
    const frames: string[] = [];
    const inflater = createFrameInflater(
      (f) => frames.push(f),
      () => {},
    );
    const f1 = JSON.stringify({ type: "frame", content: "x".repeat(4000) });
    const compressed = await deflate(f1);
    const mid = Math.floor(compressed.length / 2);
    inflater.push(toArrayBuffer(compressed.subarray(0, mid)));
    inflater.push(toArrayBuffer(compressed.subarray(mid)));
    await vi.waitFor(() => expect(frames).toEqual([f1]));
    inflater.dispose();
  });

  it("survives byte-at-a-time delivery (header and body split across every boundary)", async () => {
    const deflate = makeDeflater();
    const frames: string[] = [];
    const inflater = createFrameInflater(
      (f) => frames.push(f),
      () => {},
    );
    const f1 = JSON.stringify({ type: "frame", content: "abc\n".repeat(300) });
    const f2 = JSON.stringify({ type: "frame", content: "def\n".repeat(7) });
    const compressed = new Uint8Array(Buffer.concat([await deflate(f1), await deflate(f2)]));
    for (let i = 0; i < compressed.length; i += 1) {
      inflater.push(toArrayBuffer(compressed.subarray(i, i + 1)));
    }
    await vi.waitFor(() => expect(frames).toEqual([f1, f2]));
    inflater.dispose();
  });

  it("drains several records that arrive in one push", async () => {
    const deflate = makeDeflater();
    const frames: string[] = [];
    const inflater = createFrameInflater(
      (f) => frames.push(f),
      () => {},
    );
    const expected = [];
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 5; i += 1) {
      const f = JSON.stringify({ type: "frame", seq: i, content: `row ${i}\n` });
      expected.push(f);
      parts.push(await deflate(f));
    }
    inflater.push(toArrayBuffer(new Uint8Array(Buffer.concat(parts))));
    await vi.waitFor(() => expect(frames).toEqual(expected));
    inflater.dispose();
  });

  it("handles a large low-entropy frame whose inflate output spans many chunks", async () => {
    // ~2MB of repetitive plaintext inflates from a few KB of deflate input
    // into dozens of DecompressionStream output chunks; the record must
    // reassemble exactly once, whole.
    const deflate = makeDeflater();
    const frames: string[] = [];
    const inflater = createFrameInflater(
      (f) => frames.push(f),
      () => {},
    );
    const f1 = JSON.stringify({ type: "frame", content: "the same line of scrollback\n".repeat(75_000) });
    inflater.push(toArrayBuffer(await deflate(f1)));
    await vi.waitFor(() => expect(frames).toEqual([f1]), { timeout: 10_000 });
    inflater.dispose();
  });

  it("reports a corrupt stream once via onError", async () => {
    const onError = vi.fn();
    const inflater = createFrameInflater(() => {}, onError);
    inflater.push(toArrayBuffer(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x00, 0x01, 0x02])));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    inflater.dispose();
  });

  it("dispose silences teardown races instead of surfacing them as errors", async () => {
    const deflate = makeDeflater();
    const onError = vi.fn();
    const inflater = createFrameInflater(() => {}, onError);
    inflater.push(toArrayBuffer(await deflate('{"type":"frame"}')));
    inflater.dispose();
    await new Promise((r) => setTimeout(r, 20));
    expect(onError).not.toHaveBeenCalled();
  });
});
