// Throwaway (ci/u-client-shots only, never merged): mounts the real upload binding on a page served by the real Worker
// and drives a scene with the real engine against the real routes. Parts past `hold` are never sent, so a shot can
// wait on an upload that is still moving.
const q = new URLSearchParams(location.search);
const scene = q.get("scene") ?? "uploading";
const MIB = 1024 * 1024;

const hold = ["uploading", "waiting", "batch", "cancel"].includes(scene) ? 3 : Infinity;
const Real = window.XMLHttpRequest;
window.XMLHttpRequest = class extends Real {
  open(method, url, ...rest) {
    this.part = Number(/parts\/(\d+)$/.exec(String(url))?.[1] ?? 0);
    return super.open(method, url, ...rest);
  }
  send(body) {
    if (this.part > hold) return;
    return super.send(body);
  }
};

const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const text = (s) => new TextEncoder().encode(s);
const box = (type, payload) => new Blob([u32(8 + payload.size), text(type), payload]);
/** A minimal ISO media file the server's validator accepts. */
const mp4 = (name, payload) => {
  const mdat = new Uint8Array(payload);
  for (let i = 0; i < mdat.length; i++) mdat[i] = i % 251;
  const ftyp = box("ftyp", new Blob([text("isom"), u32(0), text("isom")]));
  return new File([ftyp, box("moov", new Blob([new Uint8Array(16)])), box("mdat", new Blob([mdat]))], name, {
    type: "video/mp4",
    lastModified: 1_700_000_000_000,
  });
};
const bad = (name) => new File([new Uint8Array(10)], name, { lastModified: 1_700_000_000_000 });

const { mountUploads } = await import("/js/core/upload-pill.js");
const up = await mountUploads({
  maxMB: 500,
  upNext: scene === "saved" ? async () => {} : null,
  trigger: document.getElementById("add"),
});

const files = {
  uploading: () => [mp4("Lecture 5.mp4", 40 * MIB)],
  cancel: () => [mp4("Lecture 5.mp4", 40 * MIB)],
  waiting: () => [mp4("Lecture 5.mp4", 40 * MIB)],
  checking: () => [mp4("Lecture 5.mp4", MIB)],
  saved: () => [mp4("Lecture 5.mp4", 1000)],
  batch: () => [mp4("Lecture 5.mp4", 40 * MIB), mp4("Lecture 6.mp4", 8 * MIB), mp4("Lecture 7.mp4", 8 * MIB)],
  refusal: () => [bad("Setup.exe")],
  refusals: () => [bad("Setup.exe"), bad("Notes.bin"), bad("Run.exe")],
}[scene]?.();
if (files?.length) up.add(files);
if (scene === "waiting") setTimeout(() => dispatchEvent(new Event("offline")), 2500);
if (scene === "saved") {
  // Holds the pill as a pointer on it would, so a shot has time to be taken.
  setTimeout(() => document.querySelector(".up-pill")?.dispatchEvent(new Event("pointerenter")), 300);
}
document.body.dataset.ready = "1";
