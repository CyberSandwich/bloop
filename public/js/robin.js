// Draws the low-poly robin (BLP1 mesh from tools/pack.py) with plain WebGL 1: one program, one draw call.
// Loaded on idle after the load event; the poster <img> stays under the canvas, which fades in after its
// first frame (class is-live), so any failure leaves the poster. Frames run only while something moves,
// the canvas is on screen and the tab is visible, at most 30 a second.
// Invariants: flat shading from per-face normals computed at load (the mesh ships none); GLSL ES 1.00
// cannot build a mat3 from a mat4, so the rotation is its own uniform.
import {
  CAMERA,
  ease,
  hopLift,
  modelMatrix,
  parseDuration,
  parseMesh,
  projectionView,
  rotation,
} from "./core/robin-math.js";
import { clamp, dragOffset, lerpPose, resolvePose, turnKey, turnOffset } from "./core/robin-pose.js";

/** @import { Pose, PoseName, PoseWeights } from "./core/robin-pose.js" */

const TURN_HOLD_MS = 1200;
/** About 14 CSS px in the hero box. */
const HOP_HEIGHT = 0.035;
/** Pointer tilt limits: 6 degrees yaw, 4 pitch. */
const TILT = [(6 * Math.PI) / 180, (4 * Math.PI) / 180];

const VS = `attribute vec3 p,n,c;uniform mat4 M,P;uniform mat3 R;varying vec3 v;
void main(){vec3 N=normalize(R*n);float d=max(dot(N,normalize(vec3(${CAMERA.light.join(",")}))),0.);
v=c*(.58+.42*d+.06*N.y);gl_Position=P*M*vec4(p,1.);}`;
const FS = "precision mediump float;varying vec3 v;void main(){gl_FragColor=vec4(v,1.);}";

/**
 * @typedef {object} RobinOptions
 * @property {HTMLElement} [control] drag surface; takes arrows and Home when focused
 * @property {HTMLElement} [tiltArea] a fine pointer over it tilts the robin slightly
 * @property {PoseName} [pose] first pose, default perch
 * @property {(offset: number) => void} [onTurn] yaw offset in radians after each change
 */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {string} src URL of robin.bin
 * @param {RobinOptions} [opts]
 */
export async function mountRobin(canvas, src, opts = {}) {
  const gl = canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: true });
  if (!gl) throw new Error("no webgl");
  const res = await fetch(src);
  if (!res.ok) throw new Error(`mesh ${res.status}`);
  const data = parseMesh(await res.arrayBuffer());
  const prog = gl.createProgram();
  for (const [type, text] of /** @type {const} */ ([
    [gl.VERTEX_SHADER, VS],
    [gl.FRAGMENT_SHADER, FS],
  ])) {
    const s = gl.createShader(type);
    if (!s) throw new Error("no shader");
    gl.shaderSource(s, text);
    gl.compileShader(s);
    gl.attachShader(prog, s);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link failed");
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  ["p", "n", "c"].forEach((name, i) => {
    const loc = gl.getAttribLocation(prog, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 36, i * 12);
  });
  const uM = gl.getUniformLocation(prog, "M");
  const uP = gl.getUniformLocation(prog, "P");
  const uR = gl.getUniformLocation(prog, "R");
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);

  const css = getComputedStyle(document.documentElement);
  const d3 = parseDuration(css.getPropertyValue("--d3"), 400);
  const d4 = parseDuration(css.getPropertyValue("--d4"), 500);
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const first = resolvePose(opts.pose ?? "perch");
  const s = {
    base: first,
    anchor: first,
    /** @type {{from: Pose, to: Pose, at: number} | null} */ tween: null,
    offset: 0,
    /** @type {{from: number, to: number, at: number, dur: number} | null} */ spin: null,
    returnAt: 0,
    /** @type {{x: number, from: number, width: number, id: number} | null} */ drag: null,
    hopAt: 0,
    tilt: [0, 0],
    aim: [0, 0],
    last: 0,
    on: false,
    visible: true,
    dead: false,
  };

  /** Advances every motion to `now`; true while anything still moves. @param {number} now */
  const advance = (now) => {
    let moving = !!s.drag;
    if (s.tween) {
      const k = (now - s.tween.at) / d3;
      s.base = lerpPose(s.tween.from, s.tween.to, ease(k));
      if (k >= 1) s.tween = null;
      else moving = true;
    }
    if (s.spin) {
      const k = (now - s.spin.at) / s.spin.dur;
      s.offset = s.spin.from + (s.spin.to - s.spin.from) * ease(k);
      if (k >= 1) s.spin = null;
      moving = true;
    } else if (!s.drag && s.offset !== 0) {
      if (now >= s.returnAt) s.spin = { from: s.offset, to: 0, at: now, dur: d4 };
      moving = true;
    }
    if (s.hopAt && now - s.hopAt >= d4) s.hopAt = 0;
    if (s.hopAt) moving = true;
    // The tilt yields to every other motion: at most one thing moves at a time.
    s.tilt = s.tilt.map((x, i) => {
      const aim = moving ? 0 : (s.aim[i] ?? 0);
      if (Math.abs(aim - x) > 1e-4) moving = true;
      return x + (aim - x) * 0.2;
    });
    return moving;
  };

  /** @param {number} now */
  const draw = (now) => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) [canvas.width, canvas.height] = [w, h];
    const pose = { ...s.base, pitch: s.base.pitch + (s.tilt[1] ?? 0) };
    const yaw = s.offset + (s.tilt[0] ?? 0);
    const hop = s.hopAt ? hopLift(now - s.hopAt, d4) * HOP_HEIGHT : 0;
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(uP, false, projectionView(w / h));
    gl.uniformMatrix4fv(uM, false, new Float32Array(modelMatrix(pose, yaw, hop)));
    gl.uniformMatrix3fv(uR, false, new Float32Array(rotation(pose.yaw + yaw, pose.pitch, pose.roll)));
    gl.drawArrays(gl.TRIANGLES, 0, data.length / 9);
    canvas.classList.add("is-live");
  };

  /** @param {number} now */
  const frame = (now) => {
    if (!s.on) return;
    if (now - s.last < 32) return void requestAnimationFrame(frame);
    s.last = now;
    const moving = advance(now);
    draw(now);
    if (moving) requestAnimationFrame(frame);
    else s.on = false;
  };
  const kick = () => {
    if (s.dead || s.on || !s.visible || document.hidden) return;
    s.on = true;
    requestAnimationFrame(frame);
  };

  const io = new IntersectionObserver(([e]) => {
    s.visible = !!e?.isIntersecting;
    kick();
  });
  io.observe(canvas);
  /** @type {[EventTarget, string, (e: any) => void][]} */
  const bound = [[document, "visibilitychange", kick]];

  /** @param {-1 | 0 | 1} dir */
  const turn = (dir) => {
    // Presses add up from where the last one was heading, not from mid-tween.
    const to = turnOffset(s.spin ? s.spin.to : s.offset, dir);
    const now = performance.now();
    if (still) s.offset = to;
    else s.spin = { from: s.offset, to, at: now, dur: d3 };
    s.returnAt = now + d3 + TURN_HOLD_MS;
    opts.onTurn?.(to);
    kick();
  };

  const control = opts.control;
  if (control) {
    /** @param {PointerEvent} e */
    const release = (e) => {
      if (s.drag?.id !== e.pointerId) return;
      s.drag = null;
      s.returnAt = performance.now();
      opts.onTurn?.(0);
      kick();
    };
    bound.push(
      [
        control,
        "pointerdown",
        (/** @type {PointerEvent} */ e) => {
          if (e.button !== 0) return;
          control.setPointerCapture(e.pointerId);
          s.spin = null;
          s.drag = { x: e.clientX, from: s.offset, width: control.clientWidth, id: e.pointerId };
          kick();
        },
      ],
      [
        control,
        "pointermove",
        (/** @type {PointerEvent} */ e) => {
          if (!s.drag || s.drag.id !== e.pointerId) return;
          s.offset = dragOffset(s.drag.from, e.clientX - s.drag.x, s.drag.width);
          opts.onTurn?.(s.offset);
        },
      ],
      [control, "pointerup", release],
      [control, "pointercancel", release],
      [
        control,
        "keydown",
        (/** @type {KeyboardEvent} */ e) => {
          const dir = turnKey(e.key);
          if (dir === null) return;
          e.preventDefault();
          turn(dir);
        },
      ],
    );
  }
  const area = opts.tiltArea;
  if (area && !still && matchMedia("(hover: hover) and (pointer: fine)").matches) {
    bound.push(
      [
        area,
        "pointermove",
        (/** @type {PointerEvent} */ e) => {
          const r = area.getBoundingClientRect();
          s.aim = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height].map(
            (x, i) => clamp(x - 0.5, -0.5, 0.5) * 2 * (TILT[i] ?? 0),
          );
          kick();
        },
      ],
      [
        area,
        "pointerleave",
        () => {
          s.aim = [0, 0];
          kick();
        },
      ],
    );
  }
  bound.push([
    canvas,
    "webglcontextlost",
    () => {
      s.dead = true;
      canvas.classList.remove("is-live");
    },
  ]);
  for (const [target, type, fn] of bound) target.addEventListener(type, fn);
  kick();

  return {
    /**
     * A pose or a weighted mix. With `t`, sits that far from the last settled pose to this one at once
     * (scroll); without it, tweens over --d3.
     * @param {PoseName | PoseWeights} pose
     * @param {{t?: number, yaw?: number}} [how]
     */
    setPose(pose, how = {}) {
      const target = resolvePose(pose);
      if (how.yaw !== undefined) target.yaw = how.yaw;
      if (how.t !== undefined) {
        s.tween = null;
        s.base = lerpPose(s.anchor, target, how.t);
        if (how.t >= 1) s.anchor = target;
      } else {
        s.anchor = target;
        if (still) s.base = target;
        else s.tween = { from: s.base, to: target, at: performance.now() };
      }
      kick();
    },
    turn,
    hop() {
      if (still) return;
      s.hopAt = performance.now();
      kick();
    },
    stop() {
      s.dead = true;
      io.disconnect();
      for (const [target, type, fn] of bound) target.removeEventListener(type, fn);
    },
  };
}
