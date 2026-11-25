import { describe, expect, it } from "vitest";
import { createToaster } from "../../public/js/core/toast.js";

class FakeNode {
  className = "";
  textContent = "";
  attrs: Record<string, string> = {};
  kids: FakeNode[] = [];
  classes = new Set<string>();
  listeners: Record<string, () => void> = {};
  gone = false;
  classList = { add: (c: string) => this.classes.add(c) };
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  append(...n: FakeNode[]) {
    this.kids.push(...n);
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners[type] = fn;
  }
  remove() {
    this.gone = true;
  }
}

function setup() {
  const body = new FakeNode();
  const doc = { body, createElement: () => new FakeNode() } as never;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const show = createToaster(
    doc,
    (fn, ms) => {
      timers.set(next, { fn, ms });
      return next++;
    },
    (t) => timers.delete(t as number),
  );
  const live = () => body.kids.filter((n) => !n.gone);
  const fire = () => {
    const [id, t] = [...timers.entries()][0] ?? [];
    if (id === undefined || !t) throw new Error("no timer");
    timers.delete(id);
    t.fn();
  };
  return { body, show, timers, live, fire };
}

describe("toast", () => {
  it("shows a title and a line as a status", () => {
    const { show, live } = setup();
    show({ title: "File Too Large", body: "The demo takes files up to 25 MB." });
    const [node] = live();
    expect(node?.attrs.role).toBe("status");
    expect(node?.kids.map((k) => k.textContent)).toEqual(["File Too Large", "The demo takes files up to 25 MB."]);
  });

  it("announces an error as an alert", () => {
    const { show, live } = setup();
    show({ title: "T", body: "B", error: true });
    expect(live()[0]?.attrs.role).toBe("alert");
  });

  it("leaves after 5 s and is gone 200 ms later", () => {
    const { show, live, timers, fire } = setup();
    show({ title: "T", body: "B" });
    expect([...timers.values()].map((t) => t.ms)).toEqual([5000]);
    fire();
    expect(live()[0]?.classes.has("out")).toBe(true);
    expect([...timers.values()].map((t) => t.ms)).toEqual([200]);
    fire();
    expect(live()).toHaveLength(0);
    expect(timers.size).toBe(0);
  });

  it("dismisses on a tap, once", () => {
    const { show, live, timers } = setup();
    show({ title: "T", body: "B" });
    live()[0]?.listeners.click?.();
    live()[0]?.listeners.click?.();
    expect(live()[0]?.classes.has("out")).toBe(true);
    expect(timers.size).toBe(1);
  });

  it("a toast tapped away tells its owner; one that times out or gives way does not", () => {
    const { show, live, fire } = setup();
    let tapped = 0;
    const one = { title: "One", body: "a", tappedAway: () => (tapped += 1) };
    show(one);
    fire();
    show(one);
    show({ title: "Two", body: "b" });
    expect(tapped).toBe(0);
    show(one);
    live()[0]?.listeners.click?.();
    expect(tapped).toBe(1);
  });

  it("shows one at a time: a new toast replaces the old one and its timer", () => {
    const { show, live, timers } = setup();
    show({ title: "One", body: "a" });
    show({ title: "Two", body: "b" });
    expect(live().map((n) => n.kids[0]?.textContent)).toEqual(["Two"]);
    expect(timers.size).toBe(1);
  });

  it("an action is one button that runs it, and the toast stays until tapped", () => {
    const { show, live, timers } = setup();
    let ran = 0;
    show({ title: "T", body: "B", action: { label: "Reload", run: () => (ran += 1) } });
    const button = live()[0]?.kids[2];
    expect(button?.textContent).toBe("Reload");
    button?.listeners.click?.();
    expect(ran).toBe(1);
    expect(timers.size).toBe(0);
    live()[0]?.listeners.click?.();
    expect(live()[0]?.classes.has("out")).toBe(true);
  });

  it("a stale leave timer never removes the next toast", () => {
    const { show, live, fire } = setup();
    show({ title: "One", body: "a" });
    fire();
    show({ title: "Two", body: "b" });
    expect(live().map((n) => n.kids[0]?.textContent)).toEqual(["Two"]);
  });
});
