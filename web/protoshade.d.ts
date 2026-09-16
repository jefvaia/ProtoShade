// Hand-written types for the emscripten glue that build.bat emits (dist/protoshade.js).
// TypeScript resolves main.ts's `import ... from "./protoshade.js"` to this file.
// Mirrors wasm/bindings.cpp - keep the two in step.

/** protoshade::Status */
export const enum Status {
  Ok = 0,
  NoProgram = 1,
  TooSmall = 2,
  BadMagic = 3,
  BadVersion = 4,
  BadLayout = 5,
  BadResolution = 6,
}

export interface ProtoShadeRuntime {
  /** Load a .bin container (header + code + assets). Copied into wasm memory. */
  load(program: Uint8Array): boolean;
  unload(): void;
  status(): Status;
  hasProgram(): boolean;
  setResolution(width: number, height: number): boolean;
  width(): number;
  height(): number;
  assetCount(): number;
  /** Render a frame at time `ms`. false means a program blew its step budget. */
  render(ms: number): boolean;
  /**
   * RGB bytes of the last render, as a view onto wasm memory - not a copy.
   * Invalidated by setResolution() or wasm memory growth, so re-read it, never cache it.
   */
  pixels(): Uint8Array;
  /** One pixel. Slow across the JS/wasm boundary - use render() for whole frames. */
  sample(x: number, y: number, ms: number): { r: number; g: number; b: number };
  /** Emscripten-owned objects are not garbage collected; call this to free one. */
  delete(): void;
}

export interface ProtoShadeModule {
  ProtoShadeRuntime: new () => ProtoShadeRuntime;
}

export default function createModule(): Promise<ProtoShadeModule>;
