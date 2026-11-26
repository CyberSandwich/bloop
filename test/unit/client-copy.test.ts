import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SESSION_ENDED, WAITLIST_FORM } from "../../public/js/core/copy.js";
import { CHECK } from "../../public/js/core/copy-check.js";
import { TYPED_LETTERS, typedError } from "../../public/js/core/copy-code.js";
import { phoneCopy, refusalToast, uploadLine, videoTime } from "../../public/js/core/copy-phone.js";
import { endLine, screenCopy } from "../../public/js/core/copy-screen.js";
import { screenNet } from "../../public/js/core/net-states.js";
import { RESULTS } from "../../public/js/core/states.js";
import { SUPPORT } from "../../public/js/shared/errors.js";
import type { PhoneStateKey, ScreenStateKey } from "../../src/shared/protocol.ts";

const SCREEN_KEYS: ScreenStateKey[] = [
  "waiting",
  "scanned",
  "choosing",
  "approved",
  "opening",
  "open",
  "open_fallback",
  "pdf_fallback",
  "pdf_file",
  "guest_open",
  "ended",
  "offline",
  "service_down",
  "network_blocked",
  "error",
  "phone_width",
  "rate_limited",
  "demo_open",
];
const PHONE_KEYS: PhoneStateKey[] = [
  "checking",
  "match",
  "choose",
  "approve",
  "approve_demo",
  "unregistered",
  "first_use",
  "needs_admin",
  "empty",
  "approving",
  "opening",
  "open",
  "open_fallback",
  "pdf_fallback",
  "pdf_file",
  "ended",
  "canceled",
  "expired",
  "taken",
  "offline",
  "error",
  "typed_wrong",
  "framed",
  "rate_limited",
  "busy",
  "guest_add",
  "guest_confirm",
  "guest_sending",
  "guest_refused",
  "guest_sent",
  "guest_pass_needed",
  "guest_off",
  "service_down",
  "network_blocked",
];

const sf = {
  room: "Room 2.14",
  file: "Lecture 4.pptx",
  endsAt: "11:35",
  guest: false,
};
const pf = { room: "Room 2.14", file: "Lecture 4.pptx" };

/** Voice rules of design.md section 3 that a string can break on its own. */
function expectVoice(text: string) {
  expect(text).not.toMatch(/[–—!]/); // no en or em dash, no exclamation mark
  expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  // "Session Ended" is the one string allowed to name the session (design.md section 3).
  expect(text === SESSION_ENDED ? "" : text).not.toMatch(/\b(oops|uh-oh|we|our|session|token|tenant)\b/i);
  expect(text).not.toMatch(/\bsecure\b/i);
}

const allText = (c: object) =>
  Object.values(c).flatMap((v) =>
    typeof v === "string"
      ? [v]
      : Array.isArray(v)
        ? v.flatMap((a) => (typeof a?.label === "string" ? [a.label] : []))
        : [],
  );

describe("Check This Room copy", () => {
  const strings = (v: unknown): string[] =>
    typeof v === "string" ? [v] : typeof v === "function" ? [v(7)] : Object.values(v as object).flatMap(strings);
  const all = strings(CHECK);
  const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

  it("follows the voice rules, in sentences of 20 words or fewer", () => {
    expect(all.length).toBeGreaterThan(10);
    for (const text of all) {
      expectVoice(text);
      expect(words(text), text).toBeLessThanOrEqual(20);
    }
  });

  it("labels are Title Case and at most 5 words", () => {
    for (const label of [CHECK.link, CHECK.title, CHECK.button, CHECK.running.replace("…", "")]) {
      expect(words(label), label).toBeLessThanOrEqual(5);
      expect(label.split(" ").filter((w) => /^[a-z]/.test(w))).toEqual([]);
    }
  });

  it("never says whether PowerPoint is installed, and a number is only ever an argument", () => {
    for (const text of all) expect(text, text).not.toMatch(/powerpoint/i);
    expect(JSON.stringify(Object.values(CHECK).filter((v) => typeof v !== "function"))).not.toMatch(/\d/);
  });
});

describe("screen copy", () => {
  it.each(SCREEN_KEYS)("%s follows the voice rules", (key) => {
    for (const demo of [false, true]) for (const text of allText(screenCopy(key, { ...sf, demo }))) expectVoice(text);
  });

  it("waiting is the room name alone: the code card says how to scan", () => {
    expect(screenCopy("waiting", sf)).toMatchObject({ heading: "Room 2.14", line: "", controls: [] });
  });

  it("headings are Title Case with no period; lines stay sentences", () => {
    // The viewer's heading is the item's own name, not a string of ours.
    for (const key of SCREEN_KEYS.filter((k) => k !== "demo_open")) {
      const c = screenCopy(key, { ...sf, file: null, demo: true });
      expect(c.heading, key).not.toMatch(/\.$/);
      const small = new Set("a an the and but or nor for as at by in of on to with bloop".split(" "));
      const lower = c.heading.split(" ").filter((w) => /^[a-z]/.test(w) && !small.has(w));
      expect(lower, key).toEqual([]);
    }
    for (const key of PHONE_KEYS) expect(phoneCopy(key, pf).title, key).not.toMatch(/\.$/);
  });

  it("headings and labels are at most 5 words (design.md section 3), a room or file name counting as one", () => {
    // One-word stand-ins for the names the person supplies; the cap is on our words around them.
    const one = { room: "Room", file: "Deck.pptx", match: "42", endsAt: "11:35" };
    const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
    for (const key of SCREEN_KEYS.filter((k) => k !== "demo_open")) {
      for (const demo of [false, true]) {
        const heading = screenCopy(key, { ...one, guest: false, demo }).heading;
        expect(words(heading), heading).toBeLessThanOrEqual(5);
      }
    }
    for (const key of PHONE_KEYS) {
      for (const back of [false, true]) {
        const c = phoneCopy(key, { ...one, back, account: true, nocode: true });
        expect(words(c.title), c.title).toBeLessThanOrEqual(5);
        for (const a of c.actions) expect(words(a.label), a.label).toBeLessThanOrEqual(5);
      }
    }
    // The task pages' own headings, before any script runs.
    for (const page of ["s.html", "a.html", "code.html"]) {
      const html = readFileSync(new URL(`../../public/${page}`, import.meta.url), "utf8");
      for (const m of html.matchAll(/<(?:h1|p class="narrow-title")[^>]*>([^<]*)</g)) {
        expect(words(m[1] ?? ""), m[1]).toBeLessThanOrEqual(5);
      }
    }
  });

  it("scanned and choosing keep the room's name as the title, and the line (screen readers only) says the claim waits and the digits the phone shows", () => {
    for (const key of ["scanned", "choosing"] as const) {
      expect(screenCopy(key, { ...sf, match: "42" })).toMatchObject({
        heading: "Room 2.14",
        line: "Waiting for Approval. Your phone shows 42.",
        controls: ["start_over"],
      });
    }
  });

  it("DEMO-01 a tab that holds the claim too finishes there: the room's name, the line, Back and Continue", () => {
    for (const key of ["scanned", "choosing"] as const) {
      expect(screenCopy(key, { ...sf, match: "42", mine: true })).toMatchObject({
        heading: "Room 2.14",
        line: "Finish on this device.",
        controls: ["start_over", "continue"],
      });
    }
  });

  it("F10 an original PDF is not told that PowerPoint cannot open it", () => {
    expect(screenCopy("pdf_file", sf)).toMatchObject({
      heading: "Opened as a PDF",
      line: "Lecture 4.pptx.",
      controls: ["end"],
    });
    expect(phoneCopy("pdf_file", pf)).toMatchObject({ title: "PDF Opened on Room 2.14", body: "Lecture 4.pptx" });
  });

  it("Start Over is on scanned, choosing and the guest offer, and nowhere else", () => {
    const withStartOver = SCREEN_KEYS.filter((k) => screenCopy(k, sf).controls.includes("start_over"));
    expect(withStartOver).toEqual(["scanned", "choosing", "guest_open"]);
  });

  it("the guest offer has the Open control", () => {
    expect(screenCopy("guest_open", { ...sf, file: "Talk.pptx" })).toMatchObject({
      heading: "Sent by a Guest",
      line: "Talk.pptx. Open it here when you're ready.",
      controls: ["open", "start_over"],
    });
  });

  it("the PDF view is offered only where Download already failed to open PowerPoint", () => {
    expect(SCREEN_KEYS.filter((k) => screenCopy(k, sf).controls.includes("pdf"))).toEqual(["open_fallback"]);
    expect(screenCopy("open_fallback", sf).controls).toEqual(["download", "pdf", "end"]);
  });

  it("End is on the screen exactly from approval to open, and opening keeps Download for the ladder", () => {
    const withEnd = SCREEN_KEYS.filter((k) => screenCopy(k, sf).controls.includes("end"));
    expect(withEnd).toEqual(["approved", "opening", "open", "open_fallback", "pdf_fallback", "pdf_file", "demo_open"]);
    expect(screenCopy("opening", sf).controls).toEqual(["end", "download"]);
  });

  it("opening names PowerPoint only for a protocol launch; an image or a PDF view is just Opening", () => {
    expect(screenCopy("opening", { ...sf, openMode: "protocol" }).heading).toBe("Opening in PowerPoint");
    expect(screenCopy("opening", { ...sf, openMode: null }).heading).toBe("Opening in PowerPoint");
    for (const openMode of ["view", "pdf"] as const) {
      expect(screenCopy("opening", { ...sf, openMode }).heading).toBe("Opening");
      expect(screenCopy("opening", { ...sf, openMode, click: true }).line).toBe(
        "Lecture 4.pptx. Click Open to show it.",
      );
    }
  });

  it("open claims PowerPoint only when the screen launched it", () => {
    expect(screenCopy("open", { ...sf, openMode: "protocol" }).heading).toBe("Open in PowerPoint");
    expect(screenCopy("open", { ...sf, openMode: null }).heading).toBe("Opened");
    expect(screenCopy("open", sf).heading).toBe("Opened");
  });

  it("opening names the file, and asks for the click only when the launch needs one", () => {
    expect(screenCopy("opening", sf)).toMatchObject({ heading: "Opening in PowerPoint", line: "Lecture 4.pptx" });
    expect(screenCopy("opening", { ...sf, click: true }).line).toBe("Lecture 4.pptx. Click Open to start PowerPoint.");
  });

  it("DEMO-01 a demo screen offers this device as the phone, and only while it shows a code", () => {
    expect(screenCopy("waiting", { ...sf, demo: true }).controls).toEqual(["here"]);
    expect(screenCopy("waiting", sf).controls).toEqual([]);
    expect(SCREEN_KEYS.filter((k) => screenCopy(k, { ...sf, demo: true }).controls.includes("here"))).toEqual([
      "waiting",
    ]);
  });

  it("DEMO-01 the viewer is headed by the item on the stage, with End, and never claims a launch", () => {
    for (const file of ["Sample deck.pptx", "Dog.jpg", "Vevox"]) {
      expect(screenCopy("demo_open", { ...sf, file, demo: true })).toEqual({
        heading: file,
        line: "",
        controls: ["end"],
        alert: false,
      });
    }
  });

  it("ended is Session Ended with the end line, and the demo's one quiet way to the waitlist", () => {
    expect(screenCopy("ended", sf)).toEqual({ heading: SESSION_ENDED, line: "", controls: [], alert: false });
    expect(screenCopy("ended", { ...sf, endLine: "Time's up." }).line).toBe("Time's up.");
    expect(screenCopy("ended", { ...sf, demo: true }).controls).toEqual(["waitlist"]);
    expect(SESSION_ENDED).toBe("Session Ended");
  });

  it("the end line says why it ended and what this PC may still hold", () => {
    expect(endLine("phone", { ppt: false, download: null })).toBe("");
    expect(endLine("auto", { ppt: true, download: "Lecture 4.pptx" })).toBe(
      "Time's up. Close PowerPoint to take your slides off this PC. Delete Lecture 4.pptx from Downloads before you leave.",
    );
    expect(endLine("screen", { ppt: false, download: null })).toBe("");
    for (const reason of ["phone", "auto", "screen", null] as const) {
      expectVoice(endLine(reason, { ppt: true, download: "Talk.pptx" }));
    }
  });

  it("open says when it ends by itself, and a guest open drops the unverified deletion claim", () => {
    expect(screenCopy("open", sf).line).toBe("Lecture 4.pptx. Ends by itself at 11:35.");
    expect(screenCopy("open", { ...sf, guest: true }).line).toBe(
      "Lecture 4.pptx. bloop deletes its copy when this ends at 11:35.",
    );
  });

  it("offline says it is reconnecting, and in a session that the phone can still end it; no sign-in fallback", () => {
    expect(screenCopy("offline", sf)).toMatchObject({ heading: "Offline", line: "Reconnecting." });
    expect(screenCopy("offline", { ...sf, inSession: true }).line).toBe(
      "Reconnecting. You can still end from your phone.",
    );
  });

  it("S7 no state suggests signing in to the PC: some people are already signed in, some verify on a laptop", () => {
    const facts = [sf, { ...sf, inSession: true }, { ...sf, demo: true }];
    for (const key of SCREEN_KEYS)
      for (const f of facts) for (const text of allText(screenCopy(key, f))) expect(text, key).not.toMatch(/sign in/i);
    for (const key of PHONE_KEYS)
      for (const text of allText(phoneCopy(key, pf))) expect(text, key).not.toMatch(/sign in/i);
    expect(readFileSync(new URL("../../public/s.html", import.meta.url), "utf8")).not.toMatch(/sign in/i);
  });

  it("S7 service down says what is wrong and the way on, once, with the address as text on the screen", () => {
    expect({ ...screenCopy("service_down", sf), ...screenNet("service_down", sf) }).toMatchObject({
      heading: "bloop Isn't Responding",
      line: `Something's wrong on bloop's side. Refresh this page, or email ${SUPPORT}.`,
      controls: [],
    });
    // Until the words load, a plain line, never a blank heading.
    expect(screenCopy("service_down", sf).heading).not.toBe("");
    expect(SUPPORT).toBe("hi@bloop.here");
  });

  it("REL-03 a blocked network names who can fix it: the screen says which address to allow, the phone says what to do", () => {
    const blocked = { ...sf, host: "bloop.here" };
    expect({ ...screenCopy("network_blocked", blocked), ...screenNet("network_blocked", blocked) }).toMatchObject({
      heading: "This Network Blocks bloop",
      line: "Ask IT to allow bloop.here, or try another network.",
      controls: [],
    });
    const phone = phoneCopy("network_blocked", pf);
    expect(phone).toMatchObject({ title: "This Network Blocks bloop", body: "Switch to mobile data, then try again." });
    expect(phone.actions.map((a) => a.label)).toContain("Try Again");
  });

  it("a tap on Session Ended says nothing: the end line is set once, when the end arrives", () => {
    const screen = readFileSync("public/js/screen.js", "utf8");
    expect(screen).not.toContain("FRESH_LINE");
    expect(readFileSync("public/js/core/copy-screen.js", "utf8")).not.toContain("Getting a new code");
    // skipEnded only shortens the hold: it never sets the line.
    const skip = /function skipEnded\(\) \{[\s\S]*?\n\}/.exec(screen)?.[0] ?? "";
    expect(skip).toContain("endedHold = ENDED_QR_RETURN_MS");
    expect(skip).not.toMatch(/\bended = /);
  });

  it("S7 screen is no named thing: Offline, Busy Right Now", () => {
    expect(screenCopy("rate_limited", sf).heading).toBe("Busy Right Now");
    // "The Room's Screen" is how people say it; no heading names a screen as a thing of bloop's.
    for (const key of SCREEN_KEYS.filter((k) => k !== "phone_width"))
      expect(screenCopy(key, { ...sf, demo: false }).heading, key).not.toMatch(/screen/i);
  });

  it("in a session every transient state keeps End, so Back never leaves a session running", () => {
    for (const key of ["offline", "error", "service_down", "network_blocked", "rate_limited"] as const) {
      expect(screenCopy(key, { ...sf, inSession: true }).controls, key).toEqual(["end"]);
      expect(screenCopy(key, sf).controls, key).toEqual([]);
    }
  });

  it("only an error alerts", () => {
    expect(SCREEN_KEYS.filter((k) => screenCopy(k, sf).alert)).toEqual(["error"]);
    expect(screenCopy("error", { ...sf, file: null }).heading).toBe("Unable to Open Your File");
  });

  it("F16 a refused create says the caps are full, demo or live, and points at no other way in", () => {
    expect(screenCopy("rate_limited", { ...sf, demo: true })).toMatchObject({
      heading: "Too Many Demos Right Now",
      line: "Trying again by itself.",
      controls: [],
      alert: false,
    });
    expect(screenCopy("rate_limited", sf).heading).toBe("Busy Right Now");
  });

  it("S7 the screen has no footer line: it sent people to a PC sign-in", () => {
    expect(readFileSync(new URL("../../public/s.html", import.meta.url), "utf8")).not.toContain('class="foot"');
  });
});

describe("phone copy", () => {
  it.each(PHONE_KEYS)("%s follows the voice rules", (key) => {
    for (const text of allText(phoneCopy(key, pf))) expectVoice(text);
  });

  it("approve is titled by the room over the list to tick, with Cancel then Approve", () => {
    const c = phoneCopy("approve", pf);
    expect(c).toMatchObject({ title: "Room 2.14", room: true, files: "list", add: true });
    expect(c.actions.map((a) => a.label)).toEqual(["Cancel", "Approve"]);
    expect(c.scope).toBe("Only the file you select goes to the screen. The screen never gets your account.");
  });

  it("the demo room is the title too, with no demo line and no account line", () => {
    const c = phoneCopy("approve_demo", { ...pf, room: "Demo Room", demo: true });
    expect(c).toMatchObject({ title: "Demo Room", body: "", scope: "", files: "list", add: true });
    expect(c.actions.map((a) => a.label)).toEqual(["Cancel", "Approve"]);
    expect(phoneCopy("approving", { ...pf, demo: true }).scope).toBe("");
  });

  it("the match digits ride on the button that commits, so the person compares them with the screen", () => {
    for (const key of ["approve", "approve_demo", "unregistered"] as const) {
      expect(phoneCopy(key, { ...pf, match: "42" }).actions.at(-1)).toEqual({
        id: "approve",
        label: "Approve (42)",
        kind: "primary",
        aria: "Approve, code 42 on the screen",
      });
    }
    expect(phoneCopy("guest_confirm", { ...pf, match: "42" }).actions.at(-1)).toMatchObject({
      label: "Send (42)",
      aria: "Send, code 42 on the screen",
    });
    expect(phoneCopy("approve", pf).actions.at(-1)).toEqual({ id: "approve", label: "Approve", kind: "primary" });
  });

  it("one device has nothing to compare: plain Approve when this tab is also the screen", () => {
    expect(phoneCopy("approve_demo", { ...pf, match: "42", back: true }).actions.at(-1)).toEqual({
      id: "approve",
      label: "Approve",
      kind: "primary",
    });
  });

  it("Approve shows disabled while nothing is ticked, and enabled in every state that follows", () => {
    const approve = (key: (typeof PHONE_KEYS)[number]) => phoneCopy(key, pf).actions.find((a) => a.id === "approve");
    expect(approve("choose")).toMatchObject({ kind: "primary", disabled: true });
    expect(phoneCopy("choose", pf).actions.map((a) => a.id)).toEqual(["cancel", "approve"]);
    for (const key of ["approve", "approve_demo", "unregistered", "approving"] as const)
      expect(approve(key)?.disabled, key).toBeUndefined();
  });

  it("side by side the primary comes last; app.css stacks it on top on a phone", () => {
    for (const key of PHONE_KEYS) {
      for (const back of [false, true]) {
        const actions = phoneCopy(key, { ...pf, back }).actions;
        const primary = actions.findIndex((a) => a.kind === "primary");
        if (primary >= 0) expect(primary, key).toBe(actions.length - 1);
      }
    }
  });

  it("AUTH-07 copy: Disconnect OneDrive appears only for a signed-in phone, first and as a text action", () => {
    for (const key of ["choose", "approve", "unregistered"] as const) {
      expect(phoneCopy(key, pf).actions.map((a) => a.id)).not.toContain("disconnect");
      const withAccount = phoneCopy(key, { ...pf, account: true }).actions;
      expect(withAccount.at(0)).toEqual({ id: "disconnect", label: "Disconnect OneDrive", kind: "text" });
    }
    expect(phoneCopy("approve", { ...pf, account: true }).actions.map((a) => a.label)).toEqual([
      "Disconnect OneDrive",
      "Cancel",
      "Approve",
    ]);
    expect(phoneCopy("approve_demo", { ...pf, account: true }).actions.map((a) => a.id)).not.toContain("disconnect");
    expect(phoneCopy("first_use", { ...pf, account: true }).actions.map((a) => a.id)).not.toContain("disconnect");
  });

  it("the size toast names the cap it is given: demo 25 MB, live 90 MB, restated nowhere", () => {
    expect(refusalToast("large", { demo: true, maxMB: 25 })).toEqual({
      title: "File Too Large",
      body: "The demo takes files up to 25 MB.",
      error: true,
    });
    expect(refusalToast("large", { demo: false, maxMB: 90 }).body).toBe("bloop takes files up to 90 MB.");
    // A video's cap reads as recording time at about 1 MB a second (an iPhone's default 1080p30 HEVC).
    expect(refusalToast("large", { demo: true, maxMB: 25, video: true })).toEqual({
      title: "Video Too Long",
      body: "The demo takes videos up to about 20\u00a0seconds (25 MB). Trim it and try again.",
      error: true,
    });
    expect(refusalToast("large", { demo: false, maxMB: 90, video: true }).body).toBe(
      "bloop takes videos up to about 90\u00a0seconds (90 MB). Trim it and try again.",
    );
    for (const file of ["js/core/copy-phone.js", "js/core/drop.js", "js/phone.js"]) {
      expect(readFileSync(new URL(`../../public/${file}`, import.meta.url), "utf8"), file).not.toMatch(/\b(25|90) ?MB/);
    }
  });

  it("every refusal the phone can name has a title and a line, in title case with no dashes", () => {
    for (const p of ["heic", "type", "empty", "large", "several", "photo", "video"] as const) {
      const t = refusalToast(p, { demo: false, maxMB: 90 });
      expect(t.title, p).toMatch(/^[A-Z]/);
      expect(`${t.title} ${t.body}`, p).not.toMatch(/[–—]/);
      expect(t.body.length, p).toBeGreaterThan(0);
    }
    expect(refusalToast("heic", { demo: false, maxMB: 90 })).toEqual({
      title: "This HEIC Photo Can't Be Converted",
      body: "This browser can't read it. Export it as JPEG and try again.",
      error: true,
    });
  });

  it("a video cap reads as seconds under 2 minutes (whole tens once there are 10), else whole minutes", () => {
    expect([1, 5, 10, 25, 59, 90, 119, 120, 179, 720].map(videoTime)).toEqual([
      "1\u00a0second",
      "5\u00a0seconds",
      "10\u00a0seconds",
      "20\u00a0seconds",
      "50\u00a0seconds",
      "90\u00a0seconds",
      "110\u00a0seconds",
      "2\u00a0minutes",
      "2\u00a0minutes",
      "12\u00a0minutes",
    ]);
  });

  it("the upload row says what the phone does first, then the share sent, never 100% before the end", () => {
    expect(uploadLine(null, "photo")).toBe("Compressing");
    expect(uploadLine(null, "video")).toBe("Removing location");
    expect(uploadLine(null, null)).toBe("Sending");
    expect(uploadLine(0, "file")).toBe("0% sent");
    expect(uploadLine(0.426, "file")).toBe("43% sent");
    expect(uploadLine(0.999, "file")).toBe("99% sent");
    expect(uploadLine(1, "file")).toBe("Finishing");
  });

  it("F5 guest states carry the design.md strings, with the room, the file and the size cap filled in", () => {
    const f = { room: "Room 2.14", file: "Talk.pptx", maxMB: 50 };
    // No choose step: the landing is the list with its Add a File row, and the picker opens from that row.
    expect(phoneCopy("guest_add", f)).toMatchObject({
      title: "Room 2.14",
      body: "Add one file from this phone. Only\u00a0this file goes to the screen.",
      files: "list",
      add: true,
      actions: [],
    });
    expect(phoneCopy("guest_add", { ...f, back: true }).body).toContain("this device");
    expect(phoneCopy("guest_confirm", f)).toMatchObject({
      title: "Send Talk.pptx to Room 2.14?",
      body: "bloop deletes its copy when this ends.",
    });
    expect(phoneCopy("guest_confirm", f).actions.map((a) => a.label)).toEqual(["Cancel", "Send"]);
    expect(phoneCopy("guest_sending", f)).toMatchObject({ title: "Sending Talk.pptx", files: "upload" });
    expect(phoneCopy("guest_sending", f).actions.map((a) => a.label)).toEqual(["Cancel"]);
    expect(phoneCopy("guest_refused", f)).toMatchObject({
      title: "This File Can't Be Sent",
      body: "Choose a .pptx, .pdf, .jpg, .png, .mp4 or .mov file under 50 MB.",
    });
    expect(phoneCopy("guest_refused", { ...f, maxMB: 10 }).body).toContain("under 10 MB");
    expect(phoneCopy("guest_refused", f).actions.map((a) => a.label)).toEqual(["Choose File"]);
    // Reached from the list, the refusal keeps the offer's Cancel back to it.
    expect(phoneCopy("guest_refused", { ...f, list: true }).actions.map((a) => a.label)).toEqual([
      "Cancel",
      "Choose File",
    ]);
    expect(phoneCopy("guest_sent", f)).toMatchObject({
      title: "Sent to Room 2.14",
      body: "Open it on the screen when you're ready.",
    });
    expect(phoneCopy("guest_pass_needed", f).title).toBe("Get a Guest Link First");
  });

  it("a guest drop that is switched off says so plainly, with the way out", () => {
    expect(phoneCopy("guest_off", pf)).toMatchObject({
      title: "This Room Can't Take Files",
      body: "Files from phones are off here. Ask your IT team to turn them on.",
    });
    expect(phoneCopy("guest_off", pf).actions.map((a) => a.label)).toEqual(["Done"]);
  });

  it("only the sending state shows the upload row", () => {
    expect(PHONE_KEYS.filter((k) => phoneCopy(k, pf).files === "upload")).toEqual(["guest_sending"]);
  });

  it("the Add a file row closes every list a phone can still tick; with no list, Add a File is a text action", () => {
    expect(PHONE_KEYS.filter((k) => phoneCopy(k, pf).add)).toEqual([
      "choose",
      "approve",
      "approve_demo",
      "unregistered",
      "guest_add",
    ]);
    const withSend = PHONE_KEYS.filter((k) => phoneCopy(k, pf).actions.some((a) => a.id === "send-file"));
    expect(withSend).toEqual(["first_use", "empty"]);
    expect(phoneCopy("empty", pf).actions.find((a) => a.id === "send-file")).toEqual({
      id: "send-file",
      label: "Add a File",
      kind: "text",
    });
  });

  it("approving keeps the buttons, marks the primary as loading, and offers no new row", () => {
    const c = phoneCopy("approving", pf);
    expect(c.loading).toBe(true);
    expect(c.add).toBe(false);
    expect(c.actions.at(-1)).toMatchObject({ id: "approve", label: "Approving..." });
  });

  it("the unregistered screen adds a warning", () => {
    expect(phoneCopy("unregistered", pf).warn).toBe(
      "This room isn't registered. Only approve if you can see the screen in front of you.",
    );
  });

  it("S7 an unregistered room has no name: the list's title is the match digits, and no title names a room", () => {
    const nameless = { ...pf, room: "", match: "42" };
    for (const key of ["match", "choose", "approve", "unregistered", "approving"] as const)
      expect(phoneCopy(key, nameless).title, key).toBe("42");
    expect(phoneCopy("open", nameless).title).toBe("Approved");
    expect(phoneCopy("guest_sent", nameless).title).toBe("Sent");
    expect(phoneCopy("guest_confirm", nameless).title).toBe("Send Lecture 4.pptx?");
    expect(phoneCopy("pdf_fallback", nameless).title).toBe("Showing a PDF");
    expect(phoneCopy("pdf_file", nameless).title).toBe("PDF Opened");
  });

  it("S7 the offer's title keeps a long name's start and extension; the body then holds it whole", () => {
    const file = "Week 7 lecture recording, final cut.mp4";
    const c = phoneCopy("guest_confirm", { ...pf, file });
    expect(c.title).toBe("Send Week 7 lecture reco\u2026 cut.mp4 to Room 2.14?");
    expect(c.name).toBe(file);
    // The name is no sentence: no period is put after it, with or without the deletion line.
    expect(c.body).not.toContain(file);
    expect(c.body.startsWith(".")).toBe(false);
    // 28 characters or fewer stay whole, and the body does not repeat them.
    const short = phoneCopy("guest_confirm", { ...pf, file: "Board.png" });
    expect(short.title).toBe("Send Board.png to Room 2.14?");
    expect(short.body).not.toContain("Board.png");
    expect(short.name).toBe("");
  });

  it("S7 the offer's cut counts code points, so an emoji at either cut stays whole", () => {
    // 29 code points: an emoji is the 19th, the last eight start with one; String.slice would halve both.
    const file = `${"a".repeat(18)}\u{1F3AC}bb\u{1F600}clp.mp4`;
    expect(Array.from(file)).toHaveLength(29);
    const title = phoneCopy("guest_confirm", { ...pf, file }).title;
    expect(title).toBe(`Send ${"a".repeat(18)}\u{1F3AC}\u2026\u{1F600}clp.mp4 to Room 2.14?`);
    expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    // 28 code points stay whole, though their UTF-16 length is over 28.
    const fits = `${"a".repeat(26)}\u{1F3AC}\u{1F600}`;
    expect(phoneCopy("guest_confirm", { ...pf, file: fits }).title).toBe(`Send ${fits} to Room 2.14?`);
  });

  it("S7 service down on the phone: what is wrong, Try Again, and the prefilled support mail", () => {
    const mail = "mailto:hi@bloop.here?subject=bloop%20isn't%20responding";
    const c = phoneCopy("service_down", pf);
    expect(c).toMatchObject({
      title: "bloop Isn't Responding",
      // Its buttons say Try Again and Email bloop, so the line restates neither.
      body: "Something's wrong on bloop's side.",
    });
    expect(c.actions).toEqual([
      { id: "mail", label: "Email bloop", kind: "text", href: mail },
      { id: "retry", label: "Try Again", kind: "primary" },
    ]);
  });

  it("approved is Approved for the room, the items read only, the time left and Revoke in rose", () => {
    for (const key of ["opening", "open"] as const) {
      expect(phoneCopy(key, pf)).toMatchObject({
        title: "Approved for Room 2.14",
        files: "items",
        add: false,
        ends: true,
        actions: [{ id: "end", label: "Revoke", kind: "rose" }],
      });
    }
  });

  it("Revoke ends the session wherever End did, the fallbacks included", () => {
    for (const key of ["open_fallback", "pdf_fallback", "pdf_file"] as const) {
      expect(phoneCopy(key, pf).actions).toEqual([{ id: "end", label: "Revoke", kind: "rose" }]);
    }
    expect(PHONE_KEYS.flatMap((k) => phoneCopy(k, pf).actions).some((a) => a.label === "End")).toBe(false);
  });

  it("DEMO-01 a phone that is also the demo screen offers the way back to it, with Revoke beside it", () => {
    const back = { id: "back", label: "See It on the Screen", kind: "primary", href: "/s?mode=demo" };
    for (const key of ["opening", "open"] as const) {
      expect(phoneCopy(key, { ...pf, back: true }).actions, key).toEqual([
        { id: "end", label: "Revoke", kind: "rose" },
        back,
      ]);
    }
    expect(phoneCopy("guest_sent", { ...pf, back: true }).actions.at(-1)).toEqual(back);
    const withBack = PHONE_KEYS.filter((k) => phoneCopy(k, { ...pf, back: true }).actions.some((a) => a.id === "back"));
    expect(withBack).toEqual(["opening", "open", "guest_sent"]);
    expect(PHONE_KEYS.filter((k) => phoneCopy(k, pf).actions.some((a) => a.id === "back"))).toEqual([]);
  });

  it("expired, taken and a wrong code offer Enter the Code as the one primary link to /code", () => {
    for (const key of ["expired", "taken", "typed_wrong"] as const) {
      expect(phoneCopy(key, pf).actions).toEqual([
        { id: "code", label: "Enter the Code", kind: "primary", href: "/code" },
      ]);
    }
  });

  it("ended takes the screen's title; a cancel says no session began; a live phone is told what the room PC may hold", () => {
    expect(phoneCopy("ended", pf).title).toBe(SESSION_ENDED);
    expect(phoneCopy("canceled", pf)).toMatchObject({ title: "Approval Canceled", body: "Nothing was shared." });
    // The line about the file link is held back until open item 1 passes.
    expect(phoneCopy("ended", pf).body).toBe("Close PowerPoint on the room PC and delete any download there.");
    expect(phoneCopy("ended", { ...pf, demo: true }).body).toBe("");
  });

  it("a demo phone's end leads to the waitlist, Done under it as secondary; a live one has Done alone", () => {
    for (const key of ["ended", "canceled"] as const) {
      expect(phoneCopy(key, pf).actions).toEqual([{ id: "done", label: "Done", kind: "primary" }]);
      // Primary last: stacked, app.css puts it on top.
      expect(phoneCopy(key, { ...pf, demo: true }).actions).toEqual([
        { id: "done", label: "Done", kind: "secondary" },
        {
          id: "waitlist",
          label: "Join the Waitlist",
          kind: "primary",
          href: "https://tally.so/r/Yj4KAN?source=phone",
          waitlist: true,
        },
      ]);
    }
  });

  it("end parity: every phone end state offers the waitlist exactly when the screen's end does", () => {
    for (const demo of [false, true]) {
      const screen = screenCopy("ended", { ...sf, demo }).controls.includes("waitlist");
      for (const key of RESULTS as PhoneStateKey[]) {
        const phone = phoneCopy(key, { ...pf, demo }).actions;
        expect(phone.some((a) => a.id === "waitlist")).toBe(screen);
        // A waitlist action is always the marked same-tab link to the form, never a button.
        for (const a of phone.filter((x) => x.id === "waitlist")) {
          expect(a.href?.startsWith(`${WAITLIST_FORM}?source=`)).toBe(true);
          expect(a.waitlist).toBe(true);
        }
      }
    }
  });

  it("the waitlist form is the one content/site.json names", () => {
    const site = JSON.parse(readFileSync(new URL("../../content/site.json", import.meta.url), "utf8"));
    expect(WAITLIST_FORM).toBe(site.waitlist);
  });

  it("a page opened with no code asks for a scan, not an expired code", () => {
    expect(phoneCopy("expired", { ...pf, nocode: true })).toMatchObject({
      title: "Scan the Code",
      body: "Point your phone camera at the code.",
    });
    expect(phoneCopy("expired", pf).title).toBe("This Code Has Expired");
  });

  it("the match state shows the room over a skeleton list", () => {
    expect(phoneCopy("match", pf)).toMatchObject({ title: "Room 2.14", room: true, files: "skeleton" });
  });

  it("every state with actions has a primary or text action, never two primaries", () => {
    for (const key of PHONE_KEYS) {
      for (const back of [false, true]) {
        const primaries = phoneCopy(key, { ...pf, back }).actions.filter((a) => a.kind === "primary");
        expect(primaries.length, key).toBeLessThanOrEqual(1);
      }
    }
  });

  it("PAIR-12 a failure in an approved session keeps Revoke beside Try Again, so its way out is never a Back", () => {
    for (const key of ["offline", "error"] as const) {
      const labels = (live: boolean) => phoneCopy(key, { room: "Room", file: null, live }).actions.map((a) => a.id);
      expect(labels(true), key).toEqual(["end", "retry"]);
      expect(labels(false), key).toEqual(["retry"]);
      // Revoke's own failure: Revoke alone retries it, never two buttons for one action.
      const revoking = phoneCopy(key, { room: "Room", file: null, live: true, revoking: true });
      expect(
        revoking.actions.map((a) => a.id),
        key,
      ).toEqual(["end"]);
    }
  });

  it("the typed-code page gets one line per failure", () => {
    expect(typedError("typed_wrong")).toBe("Check the code on the screen.");
    expect(typedError("offline")).toBe("You're offline. Check your connection.");
    expect(typedError("expired")).toBe("That code changed. Enter the new one.");
    expect(typedError("busy")).toBe("Unable to check the code. Try again.");
    expect(TYPED_LETTERS).toBe("Codes don't use 0, 1, I, L, O or U.");
    expectVoice(TYPED_LETTERS);
  });

  it("every typed-code sentence fits one line at 390 (38 characters measured 342 wide), so Continue never moves", () => {
    const keys = ["typed_wrong", "expired", "taken", "offline", "rate_limited", "framed", "busy"] as const;
    for (const key of keys) expect(typedError(key).length, key).toBeLessThanOrEqual(38);
    expect(TYPED_LETTERS.length).toBeLessThanOrEqual(38);
  });
});
