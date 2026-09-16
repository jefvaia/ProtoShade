// litegraph.js 0.7.18 ships no types and is loaded as a classic <script> (see index.html),
// so its API arrives as globals. Declared as-needed - widen these as the editor grows.
export {};

declare global {
  class LGraph {
    constructor(o?: object);
    /** Live node list. graph.ts compiles straight off this, no serialize() round trip. */
    _nodes: LGraphNode[];
    /** Link id -> link. Only what the compiler reads is declared. */
    links: Record<number, { origin_id: number; origin_slot: number } | null | undefined>;
    add(node: LGraphNode): void;
    clear(): void;
    start(interval?: number): void;
    stop(): void;
    serialize(): object;
    configure(data: object, keepOld?: boolean): boolean;
  }

  class LGraphNode {
    id: number;
    type: string;
    title: string;
    pos: [number, number];
    color: string;
    bgcolor: string;
    properties: Record<string, unknown>;
    inputs?: { name: string; link: number | null }[];
    outputs?: { name: string; links: number[] | null }[];
    widgets?: { name: string; value: unknown }[];
    addInput(name: string, type: string, extra?: object): void;
    addOutput(name: string, type: string, extra?: object): void;
    addWidget(
      type: string,
      name: string,
      value: unknown,
      callback?: ((value: unknown) => void) | string,
      options?: object,
    ): { name: string; value: unknown };
    /** Sets the property AND any widget bound to it. Prefer it over properties[name] = v. */
    setProperty(name: string, value: unknown): void;
    /** Called by setProperty and by a widget the property is bound to. */
    onPropertyChanged?: (name: string, value: unknown) => void;
    connect(slot: number | string, target: LGraphNode, targetSlot: number | string): boolean;
  }

  class LGraphCanvas {
    constructor(canvas: HTMLCanvasElement | string, graph?: LGraph, options?: object);
    /** litegraph's built-in fps/node-count overlay. */
    show_info: boolean;
    resize(width?: number, height?: number): void;
    draw(forceCanvas?: boolean, forceBg?: boolean): void;
  }

  const LiteGraph: {
    VERSION: number;
    createNode(type: string, title?: string, options?: object): LGraphNode | null;
    registerNodeType(type: string, base: unknown): void;
    clearRegisteredTypes(): void;
    /** Closes any open value/right-click menu. They are DOM elements, not canvas drawing. */
    closeAllContextMenus(ref_window?: Window): void;
    [key: string]: unknown;
  };
}
