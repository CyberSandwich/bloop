import { describe, expect, it } from "vitest";
import { PROFILES } from "../../src/worker/convert/profile.ts";
import { buildStubOutputs } from "../../src/worker/convert/stub-outputs.ts";
import { RECORD_KEY } from "../../src/worker/do/converter-schema.ts";
import { begin, derived, drive, harness } from "./convert-harness.ts";

const prefix = "u/u1/f1/v1";

describe("pptx to slides: the whole path over the stub container", () => {
  it("reaches done with every key in the layout, packs by range, notes only under n/", async () => {
    const h = harness();
    await begin(h);
    await drive(h);
    const row = derived(h);
    expect(row).toMatchObject({
      status: "done",
      stage: null,
      error: null,
      pages: 3,
      has_notes: 1,
      has_motion: 0,
      attempts: 1,
    });
    expect(h.bucket.keys(prefix).filter((k) => k !== `${prefix}/orig`)).toEqual([
      `${prefix}/d/doc.pdf`,
      `${prefix}/d/s/1/1920.webp`,
      `${prefix}/d/s/1/3840.webp`,
      `${prefix}/d/s/1/480.webp`,
      `${prefix}/d/s/1920.pack`,
      `${prefix}/d/s/3840.pack`,
      `${prefix}/d/s/480.pack`,
      `${prefix}/d/slides.json`,
      `${prefix}/d/t.webp`,
      `${prefix}/n/notes.json`,
    ]);
    // packs: offsets from slides.json slice the pack into the container's own pieces, in page order
    const stub = await buildStubOutputs("f1_v1_a1", "pptx", PROFILES.full, "a".repeat(64), { pages: 3, notes: [2] });
    const slides = JSON.parse(new TextDecoder().decode(h.bucket.objects.get(`${prefix}/d/slides.json`))) as {
      v: number;
      offsets: Record<string, [number, number][]>;
      packs: Record<string, { size: number }>;
    };
    expect(slides.v).toBe(2);
    for (const w of [3840, 1920, 480]) {
      const pack = h.bucket.objects.get(`${prefix}/d/s/${w}.pack`) as Uint8Array;
      expect(pack.length).toBe(slides.packs[String(w)]?.size);
      slides.offsets[String(w)]?.forEach(([start, length], i) => {
        expect(pack.slice(start, start + length)).toEqual(stub.files.get(`s/${i + 1}/${w}.webp`));
      });
    }
    const outputs = JSON.parse(String(row?.outputs));
    expect(outputs.groups).toEqual({ slides: true, pdf: true, notes: true, media: false, image: false });
    expect(outputs.files.map((f: { path: string }) => f.path)).toContain("notes.json");
    expect(h.notify.terminal_).toEqual([{ state: "done", code: null }]);
    expect(h.destroys).toBe(1);
    expect(h.spend.released).toBe(1);
  });

  it("spend order: acquire, container seconds, release, refund of the unused seconds, then the done record", async () => {
    const h = harness();
    await begin(h);
    await drive(h);
    expect(h.spend.calls).toEqual([
      "acquire:convert",
      "take:container_seconds",
      "release:lease1",
      "refund:container_seconds",
      "record:conversion_done",
    ]);
    expect(h.spend.refunds[0]?.n).toBeGreaterThan(0);
  });

  it("every alarm sets the next alarm or ends the job", async () => {
    const h = harness();
    await begin(h);
    for (let i = 0; i < 200; i++) {
      const rec = (await h.store.get(RECORD_KEY)) as { phase: string };
      if (rec.phase === "done") break;
      expect(h.store.alarmAt, `phase ${rec.phase}`).not.toBeNull();
      h.clock.t = Math.max(h.clock.t, h.store.alarmAt as number);
      h.store.alarmAt = null;
      await h.runner.alarm();
    }
    expect(((await h.store.get(RECORD_KEY)) as { phase: string }).phase).toBe("done");
  });

  it("CONV-13 progress: frames at most once a second, done only rising, page 1 ready before any pack", async () => {
    const h = harness();
    await begin(h);
    await drive(h);
    const frames = h.notify.progress_;
    expect(frames.length).toBeGreaterThan(0);
    for (let i = 1; i < frames.length; i++) {
      expect((frames[i]?.at ?? 0) - (frames[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(1000);
      expect(frames[i]?.done ?? 0).toBeGreaterThanOrEqual(frames[i - 1]?.done ?? 0);
    }
    const ready = h.events.indexOf("notify pageReady");
    expect(ready).toBeGreaterThan(h.events.indexOf(`put ${prefix}/d/s/1/1920.webp`));
    expect(ready).toBeLessThan(h.events.findIndex((e) => e.endsWith(".pack") && e.startsWith("put")));
  });
});
