import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BASE_DROP,
  CAMERA,
  cubicBezier,
  ease,
  hopLift,
  modelMatrix,
  parseDuration,
  parseMesh,
  rotation,
} from "../../public/js/core/robin-math.js";
import {
  bandFromTops,
  clamp,
  containProgress,
  DRAG_SPAN,
  dragOffset,
  isPoseName,
  lerpPose,
  MAX_OFFSET,
  POSES,
  REST_YAW,
  resolvePose,
  STEPS,
  scrollPose,
  stepProgress,
  TURN_STEP,
  turnKey,
  turnOffset,
} from "../../public/js/core/robin-pose.js";

const root = (rel: string) => new URL(`../../${rel}`, import.meta.url);
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

describe("poses", () => {
  it("rest is the perch at -0.7 rad (design.md section 8)", () => {
    expect(REST_YAW).toBe(-0.7);
    expect(POSES.perch.yaw).toBe(-0.7);
  });

  it("match tools/robin-poses.json, which the still renderer reads", () => {
    const json = JSON.parse(readFileSync(root("tools/robin-poses.json"), "utf8"));
    expect(json).toEqual(POSES);
  });

  it("the still renderer uses the live camera and drop", () => {
    const py = readFileSync(root("tools/render-stills.py"), "utf8");
    expect(py).toContain(`FOV_HALF = ${CAMERA.fovHalf}`);
    expect(py).toContain(`DISTANCE = ${CAMERA.distance}`);
    expect(py).toContain(`LIGHT = (${CAMERA.light.join(", ")})`);
    expect(py).toContain(`BASE_DROP = ${BASE_DROP}`);
  });

  it("the explorer steps are Scan look, Check turn, Present carry, End away", () => {
    expect(STEPS).toEqual(["look", "turn", "carry", "away"]);
  });

  it("isPoseName refuses prototype keys", () => {
    expect(isPoseName("look")).toBe(true);
    expect(isPoseName("toString")).toBe(false);
    expect(isPoseName("__proto__")).toBe(false);
  });
});

describe("resolvePose", () => {
  it("returns a copy of a named pose", () => {
    const p = resolvePose("look");
    expect(p).toEqual(POSES.look);
    p.yaw = 9;
    expect(POSES.look.yaw).toBe(-1.3);
  });

  it("normalizes weights", () => {
    expect(resolvePose({ look: 2, turn: 2 }).yaw).toBeCloseTo((POSES.look.yaw + POSES.turn.yaw) / 2);
    expect(resolvePose({ carry: 0.25 })).toEqual(POSES.carry);
  });

  it("ignores negative weights and refuses unknown names or an all-zero mix", () => {
    expect(resolvePose({ look: 1, turn: -5 })).toEqual(POSES.look);
    expect(() => resolvePose("wave" as never)).toThrow(/unknown pose/);
    expect(() => resolvePose({ wave: 1 } as never)).toThrow(/unknown pose/);
    expect(() => resolvePose({ look: 0 })).toThrow(/sum to 0/);
    expect(() => resolvePose({})).toThrow(/sum to 0/);
  });

  it("a mix always stays within the range of its poses (property)", () => {
    const names = Object.keys(POSES) as (keyof typeof POSES)[];
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0.001, max: 10, noNaN: true }), { minLength: 5, maxLength: 5 }), (ws) => {
        const mix = resolvePose(Object.fromEntries(names.map((n, i) => [n, ws[i]])));
        for (const key of ["yaw", "pitch", "roll", "lift", "shift"] as const) {
          const values = names.map((n) => POSES[n][key]);
          expect(mix[key]).toBeGreaterThanOrEqual(Math.min(...values) - 1e-9);
          expect(mix[key]).toBeLessThanOrEqual(Math.max(...values) + 1e-9);
        }
      }),
    );
  });
});

describe("lerpPose", () => {
  it("hits both ends and clamps t", () => {
    expect(lerpPose(POSES.perch, POSES.away, 0)).toEqual(POSES.perch);
    expect(lerpPose(POSES.perch, POSES.away, 1)).toEqual(POSES.away);
    expect(lerpPose(POSES.perch, POSES.away, -3)).toEqual(POSES.perch);
    expect(lerpPose(POSES.perch, POSES.away, 7)).toEqual(POSES.away);
    expect(lerpPose(POSES.perch, POSES.turn, 0.5).yaw).toBeCloseTo((POSES.perch.yaw + POSES.turn.yaw) / 2);
  });
});

describe("scrollPose (4 equal bands, blend in the first half of each)", () => {
  it.each([
    [0, 0, { perch: 1 }],
    [0.0625, 0, { perch: 0.5, look: 0.5 }],
    [0.125, 0, { look: 1 }],
    [0.2, 0, { look: 1 }],
    [0.25, 1, { look: 1 }],
    [0.375, 1, { turn: 1 }],
    [0.5, 2, { turn: 1 }],
    [0.75, 3, { carry: 1 }],
    [0.875, 3, { away: 1 }],
    [1, 3, { away: 1 }],
  ])("at %d it is step %d with %o", (progress, step, weights) => {
    const out = scrollPose(progress);
    expect(out.step).toBe(step);
    expect(Object.keys(out.weights).sort()).toEqual(Object.keys(weights).sort());
    for (const [k, v] of Object.entries(weights)) expect(out.weights[k as keyof typeof weights]).toBeCloseTo(v);
  });

  it("clamps out-of-range and non-finite progress", () => {
    expect(scrollPose(-1)).toEqual(scrollPose(0));
    expect(scrollPose(2)).toEqual(scrollPose(1));
    expect(scrollPose(Number.NaN)).toEqual(scrollPose(0));
  });

  it("is continuous: a tiny scroll never jumps the robin (property)", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 0.999, noNaN: true }), (p) => {
        const a = resolvePose(scrollPose(p).weights);
        const b = resolvePose(scrollPose(p + 0.001).weights);
        expect(Math.abs(a.yaw - b.yaw)).toBeLessThan(0.05);
      }),
    );
  });

  it("a chip's target progress lands in its band with the pose settled", () => {
    for (let step = 0; step < STEPS.length; step++) {
      const out = scrollPose(stepProgress(step));
      expect(out.step).toBe(step);
      expect(out.weights).toEqual({ [STEPS[step] as string]: 1 });
    }
    expect(stepProgress(-2)).toBe(stepProgress(0));
    expect(stepProgress(9)).toBe(stepProgress(3));
  });
});

describe("explorer scroll progress", () => {
  it("maps cover progress to the pinned range", () => {
    // Scene 2800 tall, viewport 1000: cover spans 3800 px, the pin starts after 1000 and lasts 1800.
    expect(containProgress(1000 / 3800, 2800, 1000)).toBeCloseTo(0);
    expect(containProgress(2800 / 3800, 2800, 1000)).toBeCloseTo(1);
    expect(containProgress(1900 / 3800, 2800, 1000)).toBeCloseTo(0.5);
    expect(containProgress(0, 2800, 1000)).toBe(0);
    expect(containProgress(1, 2800, 1000)).toBe(1);
  });

  it("answers 0 for a scene no taller than the viewport or a missing time", () => {
    expect(containProgress(0.5, 800, 1000)).toBe(0);
    expect(containProgress(0.5, 1000, 1000)).toBe(0);
    expect(containProgress(Number.NaN, 2800, 1000)).toBe(0);
  });

  it("picks the last band sentinel at or above the viewport top", () => {
    expect(bandFromTops([100, 500, 900, 1300])).toBe(0);
    expect(bandFromTops([-10, 500, 900, 1300])).toBe(0);
    expect(bandFromTops([-500, 0, 400, 800])).toBe(1);
    expect(bandFromTops([-1500, -1000, -500, 1])).toBe(3);
    expect(bandFromTops([])).toBe(0);
  });
});

describe("drag and Turn mapping", () => {
  it("a full-width drag turns by DRAG_SPAN, either way", () => {
    expect(dragOffset(0, 400, 400)).toBeCloseTo(DRAG_SPAN);
    expect(dragOffset(0, -200, 400)).toBeCloseTo(-DRAG_SPAN / 2);
    expect(dragOffset(0.5, 0, 400)).toBe(0.5);
  });

  it("never winds past MAX_OFFSET and survives a zero width", () => {
    expect(dragOffset(0, 5000, 100)).toBe(MAX_OFFSET);
    expect(dragOffset(0, -5000, 100)).toBe(-MAX_OFFSET);
    expect(Number.isFinite(dragOffset(0, 10, 0))).toBe(true);
  });

  it("maps arrows and Home, and leaves other keys to the page", () => {
    expect(turnKey("ArrowLeft")).toBe(-1);
    expect(turnKey("ArrowDown")).toBe(-1);
    expect(turnKey("ArrowRight")).toBe(1);
    expect(turnKey("ArrowUp")).toBe(1);
    expect(turnKey("Home")).toBe(0);
    expect(turnKey("Tab")).toBeNull();
    expect(turnKey("Enter")).toBeNull();
  });

  it("a press turns 30 degrees; Home returns to the step's yaw; the offset is bounded", () => {
    expect(TURN_STEP).toBeCloseTo(Math.PI / 6);
    expect(turnOffset(0, 1)).toBeCloseTo(Math.PI / 6);
    expect(turnOffset(0, -1)).toBeCloseTo(-Math.PI / 6);
    expect(turnOffset(1.2, 0)).toBe(0);
    let offset = 0;
    for (let i = 0; i < 20; i++) offset = turnOffset(offset, 1);
    expect(offset).toBe(MAX_OFFSET);
  });
});

describe("easing and durations", () => {
  it("cubicBezier hits the ends, is monotonic for --ease, and is linear for (0,0,1,1)", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    let prev = 0;
    for (let t = 0.05; t < 1; t += 0.05) {
      const v = ease(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(cubicBezier([0, 0, 1, 1], 0.3)).toBeCloseTo(0.3, 4);
    expect(ease(0.5)).toBeGreaterThan(0.5);
  });

  it("parses the motion tokens", () => {
    expect(parseDuration("400ms", 1)).toBe(400);
    expect(parseDuration(" 0.5s ", 1)).toBe(500);
    expect(parseDuration("", 250)).toBe(250);
    expect(parseDuration("fast", 250)).toBe(250);
  });

  it("the hop rises then falls back to 0 over its duration", () => {
    expect(hopLift(0, 500)).toBe(0);
    expect(hopLift(250, 500)).toBeCloseTo(1);
    expect(hopLift(500, 500)).toBe(0);
    expect(hopLift(-5, 500)).toBe(0);
    expect(hopLift(125, 500)).toBeGreaterThan(0);
    expect(hopLift(375, 500)).toBeGreaterThan(0);
  });

  it("clamp", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
  });
});

describe("matrices", () => {
  const col = (m: number[], c: number) => [m[c * 3] ?? 0, m[c * 3 + 1] ?? 0, m[c * 3 + 2] ?? 0];
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

  it("rotation is orthonormal with determinant 1 (property)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -4, max: 4, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        (y, p, r) => {
          const m = rotation(y, p, r);
          for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) expect(close(dot(col(m, i), col(m, j)), i === j ? 1 : 0, 1e-9)).toBe(true);
          }
          const [a, b, c] = [col(m, 0), col(m, 1), col(m, 2)];
          const det =
            (a[0] ?? 0) * ((b[1] ?? 0) * (c[2] ?? 0) - (b[2] ?? 0) * (c[1] ?? 0)) -
            (b[0] ?? 0) * ((a[1] ?? 0) * (c[2] ?? 0) - (a[2] ?? 0) * (c[1] ?? 0)) +
            (c[0] ?? 0) * ((a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0));
          expect(det).toBeCloseTo(1, 9);
        },
      ),
    );
  });

  it("yaw alone turns about the vertical axis, as the research renderer did", () => {
    const y = -0.7;
    const m = rotation(y, 0, 0);
    expect(col(m, 1)).toEqual([0, 1, 0]);
    expect(m[0]).toBeCloseTo(Math.cos(y));
    expect(m[2]).toBeCloseTo(-Math.sin(y));
  });

  it("the model matrix carries the rotation, the drop, lift, hop and shift", () => {
    const m = modelMatrix(POSES.away, 0.3, 0.02);
    const r = rotation(POSES.away.yaw + 0.3, POSES.away.pitch, POSES.away.roll);
    expect(m).toHaveLength(16);
    expect([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]).toEqual(r);
    expect(m[12]).toBe(POSES.away.shift);
    expect(m[13]).toBeCloseTo(POSES.away.lift + 0.02 - BASE_DROP);
    expect(m[15]).toBe(1);
  });
});

describe("parseMesh", () => {
  const bin = readFileSync(root("public/robin.bin"));
  const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);

  it("unpacks the shipped mesh: 1,990 triangles, 9 floats a corner, inside the unit box", () => {
    const data = parseMesh(buf);
    expect(data.length).toBe(1990 * 27);
    for (let i = 0; i < data.length; i += 9) {
      for (let k = 0; k < 3; k++) expect(Math.abs(data[i + k] ?? 9)).toBeLessThanOrEqual(0.5 + 1e-6);
      for (let k = 6; k < 9; k++) {
        expect(data[i + k]).toBeGreaterThanOrEqual(0);
        expect(data[i + k]).toBeLessThanOrEqual(1);
      }
    }
  });

  it("refuses a wrong magic, a truncated file and an index out of range", () => {
    expect(() => parseMesh(new ArrayBuffer(64))).toThrow(/not BLP1/);
    expect(() => parseMesh(buf.slice(0, 200))).toThrow(/truncated/);
    const bad = buf.slice(0);
    const dv = new DataView(bad);
    const nv = dv.getUint16(4, true);
    dv.setUint16(36 + nv * 6, 0xffff, true);
    expect(() => parseMesh(bad)).toThrow(/out of range/);
  });
});
