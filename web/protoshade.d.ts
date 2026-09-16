// Hand-written types for the emscripten glue that build.bat emits (dist/protoshade.js).
// TypeScript resolves main.ts's `import ... from "./protoshade.js"` to this file.
export interface ProtoShadeRuntime {
  pixel(x: number, y: number, ms: number): number;
  width(): number;
  height(): number;
  delete(): void;
}

export interface ProtoShadeModule {
  ProtoShadeRuntime: new (width: number, height: number) => ProtoShadeRuntime;
}

export default function createModule(): Promise<ProtoShadeModule>;
