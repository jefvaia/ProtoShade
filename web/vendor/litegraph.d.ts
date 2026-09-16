// litegraph.js 0.7.18 ships no types and is loaded as a classic <script> (see index.html),
// so its API arrives as globals. Declared as-needed - widen these as the editor grows.
export {};

declare global {
  class LGraph {
    constructor(o?: object);
    add(node: LGraphNode): void;
    start(interval?: number): void;
    stop(): void;
    serialize(): object;
    configure(data: object, keepOld?: boolean): boolean;
  }

  class LGraphNode {
    pos: [number, number];
    properties: Record<string, unknown>;
    connect(slot: number | string, target: LGraphNode, targetSlot: number | string): boolean;
  }

  class LGraphCanvas {
    constructor(canvas: HTMLCanvasElement | string, graph?: LGraph, options?: object);
    resize(width?: number, height?: number): void;
    draw(forceCanvas?: boolean, forceBg?: boolean): void;
  }

  const LiteGraph: {
    VERSION: number;
    createNode(type: string, title?: string, options?: object): LGraphNode | null;
    registerNodeType(type: string, base: unknown): void;
    clearRegisteredTypes(): void;
    [key: string]: unknown;
  };
}
