// Just enough of a document for core/notes.js, ui.js's el and icon: nodes with attributes, classes, children, a
// selector matcher for `.class` and `[attr]` lists, capture-phase click listeners and a focus.
type Listener = (e: FakeEvent) => void;

export class FakeEvent {
  stopped = false;
  constructor(public target: FakeNode) {}
  stopPropagation() {
    this.stopped = true;
  }
}

export const doc: { active: FakeNode | null; root: FakeNode | null } = { active: null, root: null };

export class FakeNode {
  attrs = new Map<string, string>();
  kids: FakeNode[] = [];
  parent: FakeNode | null = null;
  listeners: { type: string; fn: Listener; capture: boolean }[] = [];
  hidden = false;
  scrollTop = 0;
  own = "";
  /** How often a script forced a layout: a restarted animation needs one between the class off and on. */
  reflows = 0;
  constructor(public tag: string) {}

  getBoundingClientRect() {
    this.reflows++;
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  get classes(): string[] {
    return (this.attrs.get("class") ?? "").split(" ").filter(Boolean);
  }
  classList = {
    add: (c: string) => this.setAttribute("class", [...new Set([...this.classes, c])].join(" ")),
    remove: (c: string) => this.setAttribute("class", this.classes.filter((x) => x !== c).join(" ")),
    contains: (c: string) => this.classes.includes(c),
    toggle: (c: string, on?: boolean) =>
      (on ?? !this.classes.includes(c)) ? this.classList.add(c) : this.classList.remove(c),
  };
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  get textContent(): string {
    return this.own + this.kids.map((k) => k.textContent).join("");
  }
  set textContent(v: string) {
    for (const k of this.kids) k.parent = null;
    this.kids = [];
    this.own = v;
  }
  /** Everything written as HTML would show up here: the component must never reach for it. */
  set innerHTML(_: string) {
    throw new Error("innerHTML");
  }
  append(...nodes: (FakeNode | string)[]) {
    for (const n of nodes) {
      if (typeof n === "string") {
        const text = new FakeNode("#text");
        text.own = n;
        text.parent = this;
        this.kids.push(text);
      } else {
        n.remove();
        n.parent = this;
        this.kids.push(n);
      }
    }
  }
  before(...nodes: FakeNode[]) {
    const parent = this.parent as FakeNode;
    for (const n of nodes) n.remove();
    const at = parent.kids.indexOf(this);
    for (const n of nodes) n.parent = parent;
    parent.kids.splice(at, 0, ...nodes);
  }
  remove() {
    if (!this.parent) return;
    this.parent.kids = this.parent.kids.filter((k) => k !== this);
    this.parent = null;
  }
  get isConnected(): boolean {
    return this === doc.root || (this.parent?.isConnected ?? false);
  }
  get nextElementSibling(): FakeNode | null {
    const siblings = this.parent?.kids ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  contains(other: FakeNode | null): boolean {
    return !!other && (this === other || this.kids.some((k) => k.contains(other)));
  }
  disabled = false;
  get children(): FakeNode[] {
    return this.kids;
  }
  get parentElement(): FakeNode | null {
    return this.parent;
  }
  replaceChildren(...nodes: (FakeNode | string)[]) {
    this.textContent = "";
    this.append(...nodes);
  }
  prepend(node: FakeNode) {
    node.remove();
    node.parent = this;
    this.kids.unshift(node);
  }
  after(node: FakeNode) {
    const parent = this.parent as FakeNode;
    node.remove();
    node.parent = parent;
    parent.kids.splice(parent.kids.indexOf(this) + 1, 0, node);
  }
  /** `.class`, `[attr]` and `[attr='value']`, comma separated. */
  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const s = part.trim();
      if (s.startsWith(".")) return this.classes.includes(s.slice(1));
      if (!s.startsWith("[")) return this.tag === s;
      const [name, value] = s.slice(1, -1).split("=");
      return value === undefined
        ? this.attrs.has(name as string)
        : this.attrs.get(name as string) === value.replace(/'/g, "");
    });
  }
  querySelectorAll(selector: string): FakeNode[] {
    return this.kids.flatMap((k) => [...(k.matches(selector) ? [k] : []), ...k.querySelectorAll(selector)]);
  }
  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  closest(selector: string): FakeNode | null {
    return this.matches(selector) ? this : (this.parent?.closest(selector) ?? null);
  }
  addEventListener(type: string, fn: Listener, capture = false) {
    this.listeners.push({ type, fn, capture });
  }
  focus() {
    doc.active = this;
  }
  /** A click as the browser walks it: capture on the way down, then the bubble, each stoppable. */
  click() {
    const path: FakeNode[] = [];
    for (let n: FakeNode | null = this; n; n = n.parent) path.unshift(n);
    const e = new FakeEvent(this);
    for (const phase of [true, false]) {
      for (const n of phase ? path : [...path].reverse()) {
        if (e.stopped) return;
        for (const l of n.listeners) if (l.type === "click" && l.capture === phase) l.fn(e);
      }
    }
  }
}
