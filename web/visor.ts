// A 3D view of the visor: the same canvas the flat preview shows, wrapped onto the two
// panels of a head. Left half of the canvas is one side, right half the other, and the
// halves meet at the nose - so the middle columns of your graph are the nose bridge, which
// is the one thing a flat preview cannot show you.
//
// It draws whatever is in the preview canvas, so it follows the simulated run and the
// mirrored head over USB alike without knowing which one it is looking at.
//
// Drag to turn, scroll to zoom. No matrix library: the vertex shader takes yaw, pitch and
// distance and does the three lines of trigonometry itself.

/** Top view of one side, nose to back: a quadratic Bezier, x outward, z towards the viewer. */
const NOSE: readonly [number, number] = [0, 0.9];
const BEND: readonly [number, number] = [0.45, 0.55];
const BACK: readonly [number, number] = [1.05, -0.45];
const SEGMENTS = 40;
/**
 * Half the gap at the nose. The two matrices do not touch on a real head - there is a nose
 * piece between them - so each side starts this far off the centre line. It costs no texels:
 * both panels still show their whole half of the canvas, the space is simply not a panel.
 */
const NOSE_GAP = 0.09;

export interface VisorGeometry {
  /** xyz, y is ±0.5 and gets scaled by the texture aspect at draw time. */
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  idx: Uint16Array;
  /** World length of one side's arc - what a texel is wide. */
  arc: number;
}

/**
 * Two mirrored strips. The panels are flat top to bottom, so two rows of vertices is the
 * whole mesh: all the shape is in the horizontal bend.
 */
export function visorGeometry(segments = SEGMENTS): VisorGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let arc = 0;

  for (const side of [1, -1]) {
    const base = pos.length / 3;
    for (let i = 0; i <= segments; i++) {
      const a = i / segments;
      const k = 1 - a;
      const x = k * k * NOSE[0] + 2 * k * a * BEND[0] + a * a * BACK[0];
      const z = k * k * NOSE[1] + 2 * k * a * BEND[1] + a * a * BACK[1];
      // Tangent of the same curve; the outward normal is it turned a quarter.
      const dx = 2 * (k * (BEND[0] - NOSE[0]) + a * (BACK[0] - BEND[0]));
      const dz = 2 * (k * (BEND[1] - NOSE[1]) + a * (BACK[1] - BEND[1]));
      const len = Math.hypot(dx, dz) || 1;
      if (side === 1 && i > 0) {
        const px = pos[pos.length - 6];
        const pz = pos[pos.length - 4];
        arc += Math.hypot(x - px, z - pz);
      }
      for (const y of [0.5, -0.5]) {
        pos.push(side * (x + NOSE_GAP), y, z);
        nrm.push((side * -dz) / len, 0, dx / len);
        uv.push(0.5 + side * 0.5 * a, 0.5 - y); // u=0.5 is the nose, v=0 the top row
      }
    }
    for (let i = 0; i < segments; i++) {
      const q = base + i * 2;
      idx.push(q, q + 1, q + 2, q + 2, q + 1, q + 3);
    }
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), idx: new Uint16Array(idx), arc };
}

const VERT = `
attribute vec3 p; attribute vec3 n; attribute vec2 t;
uniform vec2 rot; uniform float dist, aspect, hgt;
varying vec2 vT; varying vec3 vN, vE;
vec3 orbit(vec3 v) {
  float cy = cos(rot.x), sy = sin(rot.x), cp = cos(rot.y), sp = sin(rot.y);
  v = vec3(cy * v.x + sy * v.z, v.y, cy * v.z - sy * v.x);
  return vec3(v.x, cp * v.y - sp * v.z, sp * v.y + cp * v.z);
}
void main() {
  vec3 e = orbit(vec3(p.x, p.y * hgt, p.z));
  e.z -= dist;
  vT = t; vN = orbit(n); vE = e;
  // Perspective by hand: 50 degree fov, near 0.1, far 50.
  gl_Position = vec4(2.1 * e.x / aspect, 2.1 * e.y, -1.004 * e.z - 0.2004, -e.z);
}`;

const FRAG = `
precision mediump float;
uniform sampler2D tex; uniform vec2 res;
varying vec2 vT; varying vec3 vN, vE;
void main() {
  vec2 g = abs(fract(vT * res) - 0.5) * 2.0;        // 0 at a texel centre, 1 at its edge
  float lit = 1.0 - 0.45 * pow(max(g.x, g.y), 8.0); // dark seams between the LEDs
  float face = 0.75 + 0.25 * abs(dot(normalize(vN), normalize(-vE)));
  // The LEDs are the only light there is, but a hair of ambient keeps the shape readable
  // when the shader is drawing black.
  gl_FragColor = vec4(texture2D(tex, vT).rgb * lit * face + 0.015, 1.0);
}`;

function shader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader failed");
  return s;
}

function buffer(gl: WebGLRenderingContext, prog: WebGLProgram, name: string, data: Float32Array, size: number): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, name);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
}

export class Visor {
  private yaw = 0.35;
  private pitch = 0.22;
  private dist = 3.6;

  /** null when the browser has no WebGL - the flat preview is still the real one. */
  static create(canvas: HTMLCanvasElement): Visor | null {
    const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
    try {
      return gl ? new Visor(canvas, gl) : null;
    } catch {
      return null; // a driver that refuses to compile the shader is not worth a broken page
    }
  }

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGLRenderingContext,
  ) {
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link failed");
    gl.useProgram(prog);

    const geo = visorGeometry();
    buffer(gl, prog, "p", geo.pos, 3);
    buffer(gl, prog, "n", geo.nrm, 3);
    buffer(gl, prog, "t", geo.uv, 2);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geo.idx, gl.STATIC_DRAW);
    this.count = geo.idx.length;
    this.arc = geo.arc;
    this.u = {
      rot: gl.getUniformLocation(prog, "rot")!,
      dist: gl.getUniformLocation(prog, "dist")!,
      aspect: gl.getUniformLocation(prog, "aspect")!,
      hgt: gl.getUniformLocation(prog, "hgt")!,
      res: gl.getUniformLocation(prog, "res")!,
    };

    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    // NEAREST + CLAMP, which is also what makes a non-power-of-two panel legal in WebGL 1.
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    gl.enable(gl.DEPTH_TEST); // the two sides overlap once you turn the head

    // Not passive: the wheel zooms here rather than scrolling the sidebar out from under it.
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.dist = Math.min(8, Math.max(1.3, this.dist * Math.exp(e.deltaY * 0.001)));
    }, { passive: false });
    canvas.addEventListener("pointerdown", (e) => canvas.setPointerCapture(e.pointerId));
    canvas.addEventListener("pointermove", (e) => {
      if (!e.buttons) return;
      this.yaw += e.movementX * 0.01;
      this.pitch = Math.min(1.3, Math.max(-1.3, this.pitch + e.movementY * 0.01));
    });
  }

  private readonly count: number;
  private readonly arc: number;
  private readonly u: Record<"rot" | "dist" | "aspect" | "hgt" | "res", WebGLUniformLocation>;

  /** Draws whatever is in `src` - the interpreter's frame, or the head's, whichever the preview drew. */
  draw(src: HTMLCanvasElement): void {
    const gl = this.gl;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);

    gl.uniform2f(this.u.rot, this.yaw, this.pitch);
    gl.uniform1f(this.u.dist, this.dist);
    gl.uniform1f(this.u.aspect, w / h);
    // Square texels: one side's half of the canvas is `arc` wide, so the panel is as tall
    // as that makes it. A 128x32 head is a letterbox and should look like one.
    gl.uniform1f(this.u.hgt, (2 * this.arc * src.height) / src.width);
    gl.uniform2f(this.u.res, src.width, src.height); // uv spans the whole canvas, so one cell per texel

    gl.clearColor(0.05, 0.05, 0.06, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
  }
}
