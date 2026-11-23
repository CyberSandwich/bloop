import { describe, expect, it } from "vitest";
import { FOOTER_LINE, phoneCopy, SIGN_IN_HINT, screenCopy, typedError } from "../../public/js/core/copy.js";
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
  match: "42",
  file: "Lecture 4.pptx",
  endsAt: "11:35",
  guest: false,
  offlineLong: false,
};
const pf = { room: "Room 2.14", file: "Lecture 4.pptx", endsAt: "11:35" };

/** Voice rules of design.md section 3 that a string can break on its own. */
function expectVoice(text: string) {
  expect(text).not.toMatch(/[–—!]/); // no en or em dash, no exclamation mark
  expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  expect(text).not.toMatch(/\b(oops|uh-oh|we|our|session|token|tenant)\b/i);
  expect(text).not.toMatch(/\bsecure\b/i);
}

const allText = (c: object) => Object.values(c).flatMap((v) => (typeof v === "string" ? [v] : []));

describe("screen copy", () => {
  it.each(SCREEN_KEYS)("%s follows the voice rules", (key) => {
    for (const text of allText(screenCopy(key, sf))) expectVoice(text);
  });

  it("waiting names the room, scanned shows the match code", () => {
    expect(screenCopy("waiting", sf)).toMatchObject({
      heading: "Room 2.14",
      line: "Scan with your phone camera to present your slides.",
    });
    expect(screenCopy("scanned", sf)).toMatchObject({
      heading: "Check your phone.",
      line: "It should show 42.",
      controls: ["start_over"],
      chip: "Scanned",
    });
  });

  it("F10 an original PDF is not told that PowerPoint cannot open it", () => {
    expect(screenCopy("pdf_file", sf)).toMatchObject({
      heading: "Lecture 4.pptx",
      line: "Opened as a PDF.",
      controls: ["end"],
    });
    expect(phoneCopy("pdf_file", pf)).toMatchObject({ title: "Opened as a PDF on Room 2.14.", body: "Lecture 4.pptx" });
  });

  it("Start Over is on scanned, choosing and the guest offer, and nowhere else", () => {
    const withStartOver = SCREEN_KEYS.filter((k) => screenCopy(k, sf).controls.includes("start_over"));
    expect(withStartOver).toEqual(["scanned", "choosing", "guest_open"]);
  });

  it("the guest offer has the Open control", () => {
    expect(screenCopy("guest_open", { ...sf, file: "Talk.pptx" })).toMatchObject({
      heading: "Talk.pptx",
      line: "Sent by a guest. Open it here when you're ready.",
      controls: ["open", "start_over"],
    });
  });

  it("the PDF view is offered only where Download already failed to open PowerPoint", () => {
    expect(SCREEN_KEYS.filter((k) => screenCopy(k, sf).controls.includes("pdf"))).toEqual(["open_fallback"]);
    expect(screenCopy("open_fallback", sf).controls).toEqual(["download", "pdf", "end"]);
  });

  it("open says when it ends by itself, and a guest open drops the unverified deletion claim", () => {
    expect(screenCopy("open", sf).line).toBe("Ends by itself at 11:35.");
    expect(screenCopy("open", { ...sf, guest: true }).line).toBe("bloop deletes its copy when this ends at 11:35.");
  });

  it("offline adds the sign-in hint after a while", () => {
    expect(screenCopy("offline", sf).line).toBe("Reconnecting.");
    expect(screenCopy("offline", { ...sf, offlineLong: true }).line).toBe(`Reconnecting. ${SIGN_IN_HINT}`);
  });

  it("only an error alerts", () => {
    expect(SCREEN_KEYS.filter((k) => screenCopy(k, sf).alert)).toEqual(["error"]);
    expect(screenCopy("error", { ...sf, file: null }).heading).toBe("Unable to open your slides.");
  });

  it("F16 a refused create says the caps are full, demo or live, and points at no other way in", () => {
    expect(screenCopy("rate_limited", { ...sf, demo: true })).toMatchObject({
      heading: "Too many demos open right now.",
      line: "Try again in a few minutes.",
      controls: [],
      alert: false,
    });
    expect(screenCopy("rate_limited", sf).heading).toBe("Too many screens started here.");
  });

  it("the footer line is the one design.md gives", () => {
    expect(FOOTER_LINE).toBe("Phone not with you? Sign in to this PC as usual.");
  });
});

describe("phone copy", () => {
  it.each(PHONE_KEYS)("%s follows the voice rules", (key) => {
    for (const text of allText(phoneCopy(key, pf))) expectVoice(text);
  });

  it("approve names the file and the room, with Approve then Cancel", () => {
    const c = phoneCopy("approve", pf);
    expect(c.title).toBe("Open Lecture 4.pptx on Room 2.14?");
    expect(c.actions.map((a) => a.label)).toEqual(["Approve", "Cancel", "Send a File Instead"]);
    expect(c.files).toBe("list");
  });

  it("Disconnect OneDrive appears only for a signed-in phone, last and as a text action", () => {
    for (const key of ["choose", "approve", "unregistered"] as const) {
      expect(phoneCopy(key, pf).actions.map((a) => a.id)).not.toContain("disconnect");
      const withAccount = phoneCopy(key, { ...pf, account: true }).actions;
      expect(withAccount.at(-1)).toEqual({ id: "disconnect", label: "Disconnect OneDrive", kind: "text" });
    }
    expect(phoneCopy("approve", { ...pf, account: true }).actions.map((a) => a.label)).toEqual([
      "Approve",
      "Cancel",
      "Send a File Instead",
      "Disconnect OneDrive",
    ]);
    expect(phoneCopy("approve_demo", { ...pf, account: true }).actions.map((a) => a.id)).not.toContain("disconnect");
    expect(phoneCopy("first_use", { ...pf, account: true }).actions.map((a) => a.id)).not.toContain("disconnect");
  });

  it("F5 guest states carry the design.md strings, with the room, the file and the size cap filled in", () => {
    const f = { room: "Room 2.14", file: "Talk.pptx", endsAt: null, maxMB: 50 };
    expect(phoneCopy("guest_choose", f)).toMatchObject({
      title: "Send a file to Room 2.14?",
      body: "Choose one file from this phone. Only this file goes to the screen.",
    });
    expect(phoneCopy("guest_choose", f).actions.map((a) => a.label)).toEqual(["Choose File", "Cancel"]);
    expect(phoneCopy("guest_confirm", f)).toMatchObject({
      title: "Send Talk.pptx to Room 2.14?",
      body: "bloop deletes its copy when this ends.",
    });
    expect(phoneCopy("guest_confirm", f).actions.map((a) => a.label)).toEqual(["Send", "Cancel"]);
    expect(phoneCopy("guest_sending", f)).toMatchObject({ title: "Sending Talk.pptx", progress: true });
    expect(phoneCopy("guest_sending", f).actions.map((a) => a.label)).toEqual(["Cancel"]);
    expect(phoneCopy("guest_refused", f)).toMatchObject({
      title: "This file can't be sent.",
      body: "Choose a .pptx or .pdf file under 50 MB.",
    });
    expect(phoneCopy("guest_refused", { ...f, maxMB: 10 }).body).toContain("under 10 MB");
    expect(phoneCopy("guest_refused", f).actions.map((a) => a.label)).toEqual(["Choose File"]);
    expect(phoneCopy("guest_sent", f)).toMatchObject({
      title: "Sent to Room 2.14.",
      body: "Open it on the screen when you're ready.",
    });
    expect(phoneCopy("guest_pass_needed", f).title).toBe("Ask your host for a guest link.");
  });

  it("a guest drop that is switched off says so plainly, with the way out", () => {
    expect(phoneCopy("guest_off", pf)).toMatchObject({
      title: "This screen can't take files.",
      body: "Sign in to the PC as usual to open your file.",
    });
    expect(phoneCopy("guest_off", pf).actions.map((a) => a.label)).toEqual(["Done"]);
  });

  it("F13 only the ended state shows the 96 px away still", () => {
    expect(PHONE_KEYS.filter((k) => phoneCopy(k, pf).still)).toEqual(["ended"]);
  });

  it("only the sending state shows a progress bar", () => {
    expect(PHONE_KEYS.filter((k) => phoneCopy(k, pf).progress)).toEqual(["guest_sending"]);
  });

  it("Send a File Instead is offered where a phone has nothing to choose, as a text action", () => {
    const withSend = PHONE_KEYS.filter((k) => phoneCopy(k, pf).actions.some((a) => a.id === "send-file"));
    expect(withSend).toEqual(["choose", "approve", "approve_demo", "unregistered", "first_use", "empty"]);
    expect(phoneCopy("approve", pf).actions.find((a) => a.id === "send-file")).toMatchObject({ kind: "text" });
  });

  it("approving keeps the buttons and marks the primary as loading", () => {
    const c = phoneCopy("approving", pf);
    expect(c.loading).toBe(true);
    expect(c.actions[0]).toMatchObject({ id: "approve", label: "Approving..." });
  });

  it("the unregistered screen adds a warning, a demo room says it is a demo", () => {
    expect(phoneCopy("unregistered", pf).warn).toBe(
      "This screen isn't registered. Only approve if you can see it in front of you.",
    );
    expect(phoneCopy("approve_demo", pf).scope).toBe("This is a demo. You don't need an account.");
  });

  it("expired and taken offer Enter a Code as a link to /code", () => {
    for (const key of ["expired", "taken"] as const) {
      expect(phoneCopy(key, pf).actions).toEqual([{ id: "code", label: "Enter a Code", kind: "text", href: "/code" }]);
    }
  });

  it("open says where and when it ends", () => {
    expect(phoneCopy("open", pf)).toMatchObject({
      title: "Open on Room 2.14.",
      body: "Lecture 4.pptx. Ends by itself at 11:35.",
    });
  });

  it("the ended line about the file link is held back until open item 1 passes", () => {
    expect(phoneCopy("ended", pf).body).toBe("");
  });

  it("the match state shows the room and code over a skeleton list", () => {
    expect(phoneCopy("match", pf)).toMatchObject({ room: true, match: true, files: "skeleton" });
  });

  it("every state with actions has a primary or text action, never two primaries", () => {
    for (const key of PHONE_KEYS) {
      const primaries = phoneCopy(key, pf).actions.filter((a) => a.kind === "primary");
      expect(primaries.length, key).toBeLessThanOrEqual(1);
    }
  });

  it("the typed-code page gets one line per failure", () => {
    expect(typedError("typed_wrong")).toBe("Check the code on the screen and try again.");
    expect(typedError("offline")).toBe("You're offline. Connect to Wi-Fi or mobile data, then try again.");
  });
});
