// The robin's pure math: easing, durations, the hop, rotation and model matrices, the projection, and the
// BLP1 mesh parser. No DOM, so it is unit tested (test/unit/robin-pose.test.ts); only robin.js loads it.
import { clamp } from "./robin-pose.js";

/** @import { Pose } from "./robin-pose.js" */
/** Fixed framing shared with tools/render-stills.py (a unit test compares them). */
export const CAMERA = Object.freeze({ fovHalf: 0.32, distance: 1.7, light: Object.freeze([-0.4, 0.8, 0.6]) });
/** Puts the feet near the box floor; the same in render-stills.py. */
export const BASE_DROP = 0.06;

/** CSS cubic-bezier timing at t, solved by bisection. @param {number[]} c x1 y1 x2 y2 @param {number} t */
export function cubicBezier([x1 = 0, y1 = 0, x2 = 1, y2 = 1], t) {
  const k = clamp(t, 0, 1);
  if (k === 0 || k === 1) return k;
  /** @param {number} a @param {number} b @param {number} s */
  const at = (a, b, s) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  let lo = 0;
  let hi = 1;
  let s = k;
  for (let i = 0; i < 30; i++) {
    s = (lo + hi) / 2;
    if (at(x1, x2, s) < k) lo = s;
    else hi = s;
  }
  return at(y1, y2, s);
}

/** The house --ease. @param {number} t */
export const ease = (t) => cubicBezier([0.2, 0, 0, 1], t);

/** "400ms" or "0.4s" to ms. @param {string} value @param {number} fallback */
export function parseDuration(value, fallback) {
  const m = /^\s*([\d.]+)\s*(ms|s)\s*$/.exec(value);
  const n = m ? Number(m[1]) * (m[2] === "s" ? 1000 : 1) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Hop height as a share of its peak: up over the first half, down over the second. @param {number} elapsed @param {number} duration */
export function hopLift(elapsed, duration) {
  if (elapsed <= 0 || elapsed >= duration) return 0;
  const half = duration / 2;
  return elapsed < half ? ease(elapsed / half) : 1 - ease((elapsed - half) / half);
}

/**
 * Column-major Rz(roll) * Rx(pitch) * Ry(yaw), as uniformMatrix3fv reads it.
 * @param {number} yaw @param {number} pitch @param {number} roll
 */
export function rotation(yaw, pitch, roll) {
  const [cy, sy, cp, sp, cr, sr] = [
    Math.cos(yaw),
    Math.sin(yaw),
    Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(roll),
    Math.sin(roll),
  ];
  const r0 = [cy, 0, sy];
  const r1 = [sp * sy, cp, -sp * cy];
  const r2 = [-cp * sy, sp, cp * cy];
  const top = r0.map((x, i) => cr * x - sr * (r1[i] ?? 0));
  const mid = r0.map((x, i) => sr * x + cr * (r1[i] ?? 0));
  return [0, 1, 2].flatMap((col) => [top[col] ?? 0, mid[col] ?? 0, r2[col] ?? 0]);
}

/** Column-major model matrix: pose, drag offset, hop. @param {Pose} pose @param {number} [yawOffset] @param {number} [hop] */
export function modelMatrix(pose, yawOffset = 0, hop = 0) {
  const r = rotation(pose.yaw + yawOffset, pose.pitch, pose.roll);
  return [...r.slice(0, 3), 0, ...r.slice(3, 6), 0, ...r.slice(6, 9), 0, pose.shift, pose.lift + hop - BASE_DROP, 0, 1];
}

/** Projection times the camera's translation, column-major. @param {number} aspect */
export function projectionView(aspect) {
  const f = 1 / Math.tan(CAMERA.fovHalf);
  const zz = -10.1 / 9.9;
  const zw = -2 / 9.9;
  return new Float32Array([
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    zz,
    -1,
    0,
    0,
    -CAMERA.distance * zz + zw,
    CAMERA.distance,
  ]);
}

/**
 * BLP1 to interleaved position, face normal and color: 9 floats per corner.
 * @param {ArrayBuffer} buf
 */
export function parseMesh(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 36 || dv.getUint32(0, true) !== 0x31504c42) throw new Error("not BLP1");
  const [nv, nt, nc] = [dv.getUint16(4, true), dv.getUint16(6, true), dv.getUint8(8)];
  if (buf.byteLength < 36 + nv * 6 + nt * 7 + nc * 3) throw new Error("BLP1 truncated");
  const lo = [0, 1, 2].map((k) => dv.getFloat32(12 + 4 * k, true));
  const hi = [0, 1, 2].map((k) => dv.getFloat32(24 + 4 * k, true));
  const size = Math.max(...hi.map((h, k) => h - (lo[k] ?? 0)));
  /** @param {number} i @param {number} k */
  const at = (i, k) => {
    const [l = 0, h = 0] = [lo[k], hi[k]];
    return (((dv.getInt16(36 + (3 * i + k) * 2, true) + 32767) / 65534) * (h - l) + l - (l + h) / 2) / size;
  };
  const faceAt = 36 + nv * 6 + nt * 6;
  const out = new Float32Array(nt * 27);
  for (let t = 0, o = 0; t < nt; t++) {
    const v = [0, 1, 2].map((j) => {
      const i = dv.getUint16(36 + nv * 6 + (3 * t + j) * 2, true);
      if (i >= nv) throw new Error("BLP1 index out of range");
      return [at(i, 0), at(i, 1), at(i, 2)];
    });
    const [[a0 = 0, a1 = 0, a2 = 0] = [], [b0 = 0, b1 = 0, b2 = 0] = [], [c0 = 0, c1 = 0, c2 = 0] = []] = v;
    const [u0, u1, u2, w0, w1, w2] = [b0 - a0, b1 - a1, b2 - a2, c0 - a0, c1 - a1, c2 - a2];
    const n = [u1 * w2 - u2 * w1, u2 * w0 - u0 * w2, u0 * w1 - u1 * w0];
    const face = dv.getUint8(faceAt + t);
    if (face >= nc) throw new Error("BLP1 color out of range");
    const c = [0, 1, 2].map((k) => dv.getUint8(faceAt + nt + 3 * face + k) / 255);
    for (const p of v) {
      out.set(p, o);
      out.set(n, o + 3);
      out.set(c, o + 6);
      o += 9;
    }
  }
  return out;
}
