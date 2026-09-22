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
// The same cable also carries a .bin the other way, which is how a computer with no WiFi
// flashes a head - see flash() at the bottom. The head answers in lines of log text, so the
// parser hands back everything that was not a frame as well as the frames.
//
// Logs and frames share the port, so the parser resynchronises on the magic rather than
// assuming the stream starts clean. ponytail: no checksum. A dropped byte costs one garbled
// frame and the next magic recovers it; add a CRC here and in streamFrame() if a long cable
// ever makes that a real problem.

export const FRAME_MAGIC = [0x50, 0x53, 0x46, 0x52]; // "PSFR"
export const FRAME_HEADER = 10;
const MAX_DIMENSION = 512; // format::kMaxDimension - a bigger header is a corrupt header
const MAX_TEXT = 8192; // log kept between takeText() calls

/** 0x02 "PSUP" length_u32_le - what upload::receiveOverSerial() is waiting for. */
export function flashHeader(length: number): Uint8Array {
  const head = new Uint8Array(9);
  head[0] = 0x02;
  head.set([0x50, 0x53, 0x55, 0x50], 1); // "PSUP"
  new DataView(head.buffer).setUint32(5, length, true);
  return head;
}

/** One write between acks. Matches kSerialChunk in upload_mode.cpp; smaller is fine, bigger is not. */
export const FLASH_CHUNK = 1024;

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
  private text = "";

  push(chunk: Uint8Array): SerialFrame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const frames: SerialFrame[] = [];
    for (;;) {
      const start = this.findMagic();
      if (start < 0) {
        // Nothing but text so far. Hold back only a tail that could be the beginning of a
        // magic split across two reads - "P", "PS", "PSF" - and let everything else through
        // as log. Holding a fixed three bytes instead would keep the last three characters
        // of whatever the head said, and during a flash its answer is the last thing it says
        // before going quiet: the line would never finish and the editor would call a
        // successful write a timeout.
        const keep = this.buf.length - this.magicTail();
        this.keepText(this.buf.subarray(0, keep));
        this.buf = this.buf.slice(keep);
        return frames;
      }
      if (start > 0) {
        this.keepText(this.buf.subarray(0, start));
        this.buf = this.buf.slice(start);
      }
      if (this.buf.length < FRAME_HEADER) return frames;

      const w = this.buf[4] | (this.buf[5] << 8);
      const h = this.buf[6] | (this.buf[7] << 8);
      const format = this.buf[8];
      if (w < 1 || h < 1 || w > MAX_DIMENSION || h > MAX_DIMENSION || format !== 0) {
        // "PSFR" that is not a frame header - text, or the tail of a corrupted one. Step
        // past this magic and keep looking rather than trusting the length that follows.
        this.keepText(this.buf.subarray(0, FRAME_MAGIC.length));
        this.buf = this.buf.slice(FRAME_MAGIC.length);
        continue;
      }

      const need = FRAME_HEADER + w * h * 3;
      if (this.buf.length < need) return frames; // mid-frame, wait for the rest
      frames.push({ w, h, rgb: this.buf.slice(FRAME_HEADER, need) });
      this.buf = this.buf.slice(need);
    }
  }

  /**
   * Everything in the stream that was not part of a frame, since the last call: the head's
   * own log lines, which is also how it answers during a flash. Latin-1 rather than UTF-8
   * because the bytes in between can be the tail of a corrupted frame, and a decoder that
   * throws on those would take the log with it.
   */
  takeText(): string {
    const text = this.text;
    this.text = "";
    return text;
  }

  private keepText(bytes: Uint8Array): void {
    for (const b of bytes) this.text += String.fromCharCode(b);
    // A device nobody is listening to must not grow this without bound.
    if (this.text.length > MAX_TEXT) this.text = this.text.slice(-MAX_TEXT);
  }

  /** How many trailing bytes could still turn into the frame magic once more arrive. */
  private magicTail(): number {
    for (let k = Math.min(FRAME_MAGIC.length - 1, this.buf.length); k > 0; k--) {
      let match = true;
      for (let i = 0; i < k; i++) {
        if (this.buf[this.buf.length - k + i] !== FRAME_MAGIC[i]) match = false;
      }
      if (match) return k;
    }
    return 0;
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
  // The head's log, split into lines. flash() reads its answers out of here; everything
  // else the head says goes past unread, which is what the serial monitor is for.
  private lines: string[] = [];
  private partial = "";

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
            if (!value) continue;
            for (const frame of parser.push(value)) onFrame(frame);
            this.absorb(parser.takeText());
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

  /** A single-letter command the sketch understands, e.g. "p" to stream frames - or raw bytes. */
  async send(command: string | Uint8Array): Promise<void> {
    const writable = this.port?.writable;
    if (!writable) return;
    const writer = writable.getWriter();
    try {
      await writer.write(typeof command === "string" ? new TextEncoder().encode(command) : command);
    } finally {
      writer.releaseLock();
    }
  }

  /**
   * Writes a .bin into the head's flash over this cable, which is the way in on a computer
   * with no WiFi: no access point to join, no browser hop, and the face is back a second
   * later. Resolves with the head's own summary of what it is now running.
   *
   * One chunk is in flight at a time and each waits for the head's ack. That is not
   * politeness: a sector write takes tens of milliseconds and the device's receive buffer is
   * a few hundred bytes, so the head has to say when it is ready for more. It also means a
   * transfer that dies halfway stops, instead of quietly storing a truncated program.
   */
  async flash(bin: Uint8Array, onProgress?: (sent: number, total: number) => void): Promise<string> {
    if (!this.port) throw new Error("connect to the head first");
    this.lines.length = 0;
    this.partial = "";

    await this.send(flashHeader(bin.length));
    // Generous because the head reads the port once per loop, and one turn of that loop is a
    // whole frame: a slow display driver can hold it for seconds. Five was not enough on a
    // head whose panels take their time, and a head that is genuinely not listening says so
    // just as clearly ten seconds later.
    await this.expect("psflash ready", 10000);
    for (let sent = 0; sent < bin.length; ) {
      const end = Math.min(sent + FLASH_CHUNK, bin.length);
      await this.send(bin.subarray(sent, end));
      // Generous: this covers erasing the partition, which happens inside the first chunk.
      await this.expect("psflash ack", 10000);
      sent = end;
      onProgress?.(sent, bin.length);
    }
    return (await this.expect("psflash done", 10000)).replace("psflash done ", "");
  }

  /** Waits for a line from the head, and gives up on one that starts with psflash error. */
  private async expect(prefix: string, timeoutMs: number): Promise<string> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      while (this.lines.length > 0) {
        const line = this.lines.shift() as string;
        if (line.startsWith(prefix)) return line;
        if (line.startsWith("psflash error")) {
          throw new Error(line.replace(/^psflash error\s*-?\s*/, "the head refused it: "));
        }
      }
      if (performance.now() > deadline) {
        throw new Error(
          `the head went quiet waiting for "${prefix}" - is it running this firmware, and is` +
            " Tools > USB CDC On Boot enabled?",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private absorb(text: string): void {
    if (!text) return;
    const parts = (this.partial + text).split("\n");
    this.partial = (parts.pop() ?? "").slice(-1024); // an unterminated line must not grow
    for (const line of parts) this.lines.push(line.trim());
    if (this.lines.length > 200) this.lines.splice(0, this.lines.length - 200);
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
