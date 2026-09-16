// Watching the head's own output in the editor, over USB.
//
// The device renders a frame and writes it to the same serial port it prints logs on; this
// finds the frames in that stream and hands them back. Two implementations of a shader can
// agree on every test and still differ on hardware - a panel that is wired up wrong, a
// sensor reading nothing, a frame rate that only collapses after ten minutes. This is the
// view that shows that, and it needs no extra wiring: the cable is already there.
//
// Web Serial is Chrome/Edge on the desktop, over https or localhost, and needs a click to
// pick the port. Everywhere else the button says so and the local preview carries on.
//
//   device -> browser:   "PSFR" | w u16 | h u16 | format u8 | flags u8 | w*h*3 bytes RGB
//   browser -> device:   one-byte commands, the same ones the serial monitor takes
//
// Logs and frames share the port, so the parser resynchronises on the magic rather than
// assuming the stream starts clean. ponytail: no checksum. A dropped byte costs one garbled
// frame and the next magic recovers it; add a CRC here and in streamFrame() if a long cable
// ever makes that a real problem.

export const FRAME_MAGIC = [0x50, 0x53, 0x46, 0x52]; // "PSFR"
export const FRAME_HEADER = 10;
const MAX_DIMENSION = 512; // format::kMaxDimension - a bigger header is a corrupt header

export interface SerialFrame {
  w: number;
  h: number;
  /** w * h * 3 bytes, row major. A view into the parser's buffer - copy it if you keep it. */
  rgb: Uint8Array;
}

/**
 * Pulls frames out of a byte stream that also carries text. Pure and synchronous, which is
 * why it is the part with a test: framing bugs only show up on a split that happens to land
 * mid-header, and that is hard to hit by hand and trivial to write down.
 */
export class FrameParser {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): SerialFrame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const frames: SerialFrame[] = [];
    for (;;) {
      const start = this.findMagic();
      if (start < 0) {
        // Nothing but text so far. Keep the last three bytes: the magic may be split across
        // this chunk and the next, and dropping the rest is what stops a chatty device from
        // growing this buffer without bound.
        this.buf = this.buf.slice(Math.max(0, this.buf.length - (FRAME_MAGIC.length - 1)));
        return frames;
      }
      if (start > 0) this.buf = this.buf.slice(start);
      if (this.buf.length < FRAME_HEADER) return frames;

      const w = this.buf[4] | (this.buf[5] << 8);
      const h = this.buf[6] | (this.buf[7] << 8);
      const format = this.buf[8];
      if (w < 1 || h < 1 || w > MAX_DIMENSION || h > MAX_DIMENSION || format !== 0) {
        // "PSFR" that is not a frame header - text, or the tail of a corrupted one. Step
        // past this magic and keep looking rather than trusting the length that follows.
        this.buf = this.buf.slice(FRAME_MAGIC.length);
        continue;
      }

      const need = FRAME_HEADER + w * h * 3;
      if (this.buf.length < need) return frames; // mid-frame, wait for the rest
      frames.push({ w, h, rgb: this.buf.slice(FRAME_HEADER, need) });
      this.buf = this.buf.slice(need);
    }
  }

  private findMagic(): number {
    outer: for (let i = 0; i + FRAME_MAGIC.length <= this.buf.length; i++) {
      for (let k = 0; k < FRAME_MAGIC.length; k++) {
        if (this.buf[i + k] !== FRAME_MAGIC[k]) continue outer;
      }
      return i;
    }
    return -1;
  }
}

// ---------------------------------------------------------------------------
// The browser half. Everything above is testable without any of this.
// ---------------------------------------------------------------------------

/** Minimal shape of the Web Serial API - TypeScript's DOM lib does not ship it. */
interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
}
interface SerialLike {
  requestPort(): Promise<SerialPortLike>;
}

const serial = (): SerialLike | undefined => (navigator as unknown as { serial?: SerialLike }).serial;

export const supported = (): boolean => serial() !== undefined;

export class DeviceLink {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closing = false;

  /** Asks the user for a port, then reads until disconnect(). Must follow a click. */
  async connect(onFrame: (frame: SerialFrame) => void, onClose: (why: string) => void): Promise<void> {
    const api = serial();
    if (!api) throw new Error("this browser has no Web Serial - Chrome or Edge on the desktop");

    const port = await api.requestPort();
    // Ignored by USB CDC, which is what an S3 devkit exposes, and respected by a real UART.
    await port.open({ baudRate: 921600 });
    this.port = port;
    this.closing = false;
    void this.read(onFrame, onClose);
  }

  private async read(onFrame: (frame: SerialFrame) => void, onClose: (why: string) => void): Promise<void> {
    const parser = new FrameParser();
    try {
      while (this.port?.readable) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value) for (const frame of parser.push(value)) onFrame(frame);
          }
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
      onClose(this.closing ? "disconnected" : "the device stopped sending");
    } catch (err) {
      onClose(this.closing ? "disconnected" : `serial error: ${String(err)}`);
    }
  }

  /** One of the single-letter commands the sketch understands, e.g. "p" to stream frames. */
  async send(command: string): Promise<void> {
    const writable = this.port?.writable;
    if (!writable) return;
    const writer = writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(command));
    } finally {
      writer.releaseLock();
    }
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* already gone */
    }
    try {
      await this.port?.close();
    } catch {
      /* already gone */
    }
    this.port = null;
  }

  get connected(): boolean {
    return this.port !== null;
  }
}
