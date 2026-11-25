// Runs the fixture corpus against the built image. The harness is in lib.mjs, the macro cases in
// macros.mjs, the rest in cases.mjs.
//
// Usage: IMAGE=bloop-converter:ci node container/test/corpus.mjs
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  caseDeck,
  caseExternal,
  caseIsolation,
  caseLinks,
  caseMedia,
  caseOneCpuTiming,
  casePdfActive,
  caseTimeoutAndCaps,
  caseUploadContract,
  expectRefusal,
} from "./cases.mjs";
import { check, failures, GEN, timings } from "./lib.mjs";
import { caseMacro, LEGACY, macroProof, makeLegacyMacros } from "./macros.mjs";

async function main() {
  if (process.platform !== "linux") throw new Error("the corpus needs Linux (nsenter)");
  for (const f of ["plain.pptx", "bomb.pptx"]) {
    if (!existsSync(join(GEN, f))) throw new Error(`missing ${f}: run node container/fixtures/make.mjs first`);
  }
  await caseDeck("plain.pptx", "pptx", 2, (got) => {
    check(
      got.notes.notes.length === 0 && got.slides.motion === false && got.slides.media === false,
      "plain.pptx: no notes, no motion, no media",
    );
    check(got.meta.fontsMissing.length === 0, `plain.pptx: no missing fonts (got ${got.meta.fontsMissing})`);
  });
  await caseDeck("animated.pptx", "pptx", 3, (got) =>
    check(got.slides.motion === true, "animated.pptx: motion is flagged"),
  );
  await caseDeck("notes.pptx", "pptx", 3, (got) => {
    const [a, b] = got.notes.notes;
    check(
      got.notes.notes.length === 2 &&
        a.n === 1 &&
        a.text === "Open with the numbers.\nPause here." &&
        b.n === 3 &&
        b.text.length === 4000,
      `notes.pptx: notes ${JSON.stringify(got.notes.notes).slice(0, 200)}`,
    );
  });
  await caseDeck("hidden.pptx", "pptx", 2, (got) =>
    check(
      JSON.stringify(got.notes.notes) === JSON.stringify([{ n: 2, text: "Thirdslide\nnote" }]),
      `hidden.pptx: the hidden slide takes no number, and control characters leave the note (got ${JSON.stringify(got.notes.notes)})`,
    ),
  );
  await caseDeck(
    "notes-late.pptx",
    "pptx",
    3,
    (got) =>
      check(
        JSON.stringify(got.notes.notes) === JSON.stringify([{ n: 2, text: "kept" }]),
        `notes-late.pptx: a note past the page cap is dropped (got ${JSON.stringify(got.notes.notes)})`,
      ),
    { env: { BLOOP_MAX_PAGES: "3" }, total: 5 },
  );
  await caseDeck("aptos.pptx", "pptx", 2, (got) =>
    check(
      got.meta.fontsMissing.includes("Aptos") && got.meta.fontsMissing.includes("Aptos Display"),
      `aptos.pptx: fontsMissing ${got.meta.fontsMissing}`,
    ),
  );
  await caseDeck("deck-20.pptx", "pptx", 20, null, { timing: true });
  await caseDeck("deck-100.pptx", "pptx", 100, null, { timing: true, strictEarly: true });
  await caseDeck("plain.pptx", "pptx", 2, null, { env: { BLOOP_WIDTHS: "1280,640,320" }, widths: [1280, 640, 320] });
  await caseDeck("pages-301.pdf", "pdf", 40, null, { env: { BLOOP_MAX_PAGES: "40" }, total: 301 });
  await caseOneCpuTiming("deck-100.pptx", 100);
  await caseOneCpuTiming("deck-300.pptx", 300);
  await casePdfActive();
  await caseMedia();
  for (const f of ["macro.odp", "macro.odt", "macro.ods"]) {
    await caseMacro(join(GEN, f), f.split(".")[1]);
    macroProof(join(GEN, f));
  }
  const legacy = makeLegacyMacros();
  check(
    legacy.length === LEGACY.length,
    `legacy macro fixtures: ${legacy.length} of ${LEGACY.length} carry a VBA storage`,
  );
  for (const f of legacy) {
    await caseMacro(f, f.split(".").pop());
    console.log(`  legacy control ${f}: ${JSON.stringify(macroProof(f, { mustFire: false }))}`);
  }
  await caseExternal("external.pptx", "pptx");
  await caseExternal("external.docx", "docx");
  await caseLinks();
  await expectRefusal("bomb.pptx", "pptx", "bomb");
  await expectRefusal("bad-magic.pptx", "pptx", "bad_magic");
  await caseUploadContract();
  await caseTimeoutAndCaps();
  await caseIsolation();

  const summary = ["## Corpus timings", "", ...timings.map((t) => `- ${t}`)].join("\n");
  console.log(`\n${summary}`);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, { flag: "a" });
  if (failures.length) {
    console.log(`\n${failures.length} failure(s):\n${failures.map((f) => `- ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log("\ncorpus passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
