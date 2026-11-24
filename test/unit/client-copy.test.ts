import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  endLine,
  FOOTER_LINE,
  phoneCopy,
  SESSION_ENDED,
  SIGN_IN_HINT,
  screenCopy,
  TYPED_LETTERS,
  typedError,
} from "../../public/js/core/copy.js";
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
  "guest_choose",
  "guest_confirm",
  "guest_sending",
  "guest_refused",
  "guest_sent",
  "guest_pass_needed",
  "guest_off",
];

const sf = {
  room: "Room 2.14",
  file: "Lecture 4.pptx",
  endsAt: "11:35",
  guest: false,
  offlineLong: false,
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
        const heading = screenCopy(key, { ...one, guest: false, offlineLong: false, demo }).heading;
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

  it("scanned and choosing say Check Your Phone with the digits the phone shows", () => {
    for (const key of ["scanned", "choosing"] as const) {
      expect(screenCopy(key, { ...sf, match: "42" })).toMatchObject({
        heading: "Check Your Phone",
        line: "Your phone shows 42.",
        controls: ["start_over"],
      });
    }
  });

  it("DEMO-01 a tab that holds the claim too finishes approving there, with Back and Continue", () => {
    for (const key of ["scanned", "choosing"] as const) {
      expect(screenCopy(key, { ...sf, match: "42", mine: true })).toMatchObject({
        heading: "Finish Approving",
        line: "",
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
    expect(endLine("phone", { ppt: false, download: null })).toBe("Revoked from the phone.");
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

  it("offline adds the sign-in hint after a while", () => {
    expect(screenCopy("offline", sf).line).toBe("Reconnecting.");
    expect(screenCopy("offline", { ...sf, offlineLong: true }).line).toBe(`Reconnecting. ${SIGN_IN_HINT}`);
    expect(screenCopy("offline", { ...sf, inSession: true }).line).toBe(
      "Reconnecting. You can still end from your phone.",
    );
  });

  it("in a session every transient state keeps End, so Back never leaves a session running", () => {
    for (const key of ["offline", "error", "service_down", "rate_limited"] as const) {
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
    expect(screenCopy("rate_limited", sf).heading).toBe("Too Many Screens Right Now");
  });

  it("the footer line is the one design.md gives", () => {
    expect(FOOTER_LINE).toBe("Phone not with you? Sign in to this PC as usual.");
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

  it("F5 guest states carry the design.md strings, with the room, the file and the size cap filled in", () => {
    const f = { room: "Room 2.14", file: "Talk.pptx", maxMB: 50 };
    expect(phoneCopy("guest_choose", f)).toMatchObject({
      title: "Send a File to Room 2.14?",
      body: "Choose one file from this phone. Only this file goes to the screen.",
    });
    expect(phoneCopy("guest_choose", f).actions.map((a) => a.label)).toEqual(["Cancel", "Choose File"]);
    expect(phoneCopy("guest_confirm", f)).toMatchObject({
      title: "Send Talk.pptx to Room 2.14?",
      body: "bloop deletes its copy when this ends.",
    });
    expect(phoneCopy("guest_confirm", f).actions.map((a) => a.label)).toEqual(["Cancel", "Send"]);
    expect(phoneCopy("guest_sending", f)).toMatchObject({ title: "Sending Talk.pptx", progress: true });
    expect(phoneCopy("guest_sending", f).actions.map((a) => a.label)).toEqual(["Cancel"]);
    expect(phoneCopy("guest_refused", f)).toMatchObject({
      title: "This File Can't Be Sent",
      body: "Choose a .pptx or .pdf file under 50 MB.",
    });
    expect(phoneCopy("guest_refused", { ...f, maxMB: 10 }).body).toContain("under 10 MB");
    expect(phoneCopy("guest_refused", f).actions.map((a) => a.label)).toEqual(["Choose File"]);
    expect(phoneCopy("guest_sent", f)).toMatchObject({
      title: "Sent to Room 2.14",
      body: "Open it on the screen when you're ready.",
    });
    expect(phoneCopy("guest_pass_needed", f).title).toBe("Get a Guest Link First");
  });

  it("a guest drop that is switched off says so plainly, with the way out", () => {
    expect(phoneCopy("guest_off", pf)).toMatchObject({
      title: "This Screen Can't Take Files",
      body: "Sign in to the PC as usual to open your file.",
    });
    expect(phoneCopy("guest_off", pf).actions.map((a) => a.label)).toEqual(["Done"]);
  });

  it("only the sending state shows a progress bar", () => {
    expect(PHONE_KEYS.filter((k) => phoneCopy(k, pf).progress)).toEqual(["guest_sending"]);
  });

  it("the Add a file row closes every list a phone can still tick; with no list, Add a File is a text action", () => {
    expect(PHONE_KEYS.filter((k) => phoneCopy(k, pf).add)).toEqual([
      "choose",
      "approve",
      "approve_demo",
      "unregistered",
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
      "This screen isn't registered. Only approve if you can see it in front of you.",
    );
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

  it("expired and taken offer Enter a Code as a link to /code", () => {
    for (const key of ["expired", "taken"] as const) {
      expect(phoneCopy(key, pf).actions).toEqual([{ id: "code", label: "Enter a Code", kind: "text", href: "/code" }]);
    }
  });

  it("ended takes the screen's title; a cancel says no session began; a live phone is told what the room PC may hold", () => {
    expect(phoneCopy("ended", pf).title).toBe(SESSION_ENDED);
    expect(phoneCopy("canceled", pf)).toMatchObject({ title: "Approval Canceled", body: "Nothing was shared." });
    // The line about the file link is held back until open item 1 passes.
    expect(phoneCopy("ended", pf).body).toBe("Close PowerPoint on the room PC and delete any download there.");
    expect(phoneCopy("ended", { ...pf, demo: true }).body).toBe("Your files left the screen.");
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

  it("the typed-code page gets one line per failure", () => {
    expect(typedError("typed_wrong")).toBe("Check the code on the screen and try again.");
    expect(typedError("offline")).toBe("You're offline. Check your connection, then try again.");
    expect(typedError("expired")).toBe("That code changed. Enter the new code on the screen.");
    expect(typedError("busy")).toBe("Unable to check the code. Try again.");
    expect(TYPED_LETTERS).toBe("Codes don't use 0, 1, I, L, O or U.");
    expectVoice(TYPED_LETTERS);
  });
});
