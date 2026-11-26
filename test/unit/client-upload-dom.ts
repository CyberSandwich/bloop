// Just enough of an element for ui.js, loader.js, pill.js and the upload binding to build and touch.
type Listener = (e?: unknown) => void;

export class FakeNode {
  tag: string;
  attrs = new Map<string, string>();
  kids: FakeNode[] = [];
  classes = new Set<string>();
  listeners = new Map<string, Listener[]>();
  hidden = false;
  removed = false;
  own = "";
  props = new Map<string, string>();
  // What loader.js writes the fill into.
  style = {
    setProperty: (k: string, v: string) => this.props.set(k, v),
    removeProperty: (k: string) => this.props.delete(k),
  };
  constructor(tag: string) {
    this.tag = tag;
  }
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, on?: boolean) => ((on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c)),
  };
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
    if (k === "class") for (const c of v.split(" ")) this.classes.add(c);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  append(...nodes: (FakeNode | string)[]) {
    for (const n of nodes) {
      if (typeof n === "string") {
        const text = new FakeNode("#text");
        text.own = n;
        this.kids.push(text);
      } else this.kids.push(n);
    }
  }
  replaceChildren(...nodes: (FakeNode | string)[]) {
    this.kids = [];
    this.own = "";
    this.append(...nodes);
  }
  get textContent(): string {
    return this.own + this.kids.map((k) => k.textContent).join("");
  }
  set textContent(v: string) {
    this.kids = [];
    this.own = v;
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  click() {
    for (const fn of this.listeners.get("click") ?? []) fn();
  }
  // A dialog's.
  open = false;
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  remove() {
    this.removed = true;
  }
  find(pred: (n: FakeNode) => boolean): FakeNode | undefined {
    if (pred(this)) return this;
    for (const k of this.kids) {
      const hit = k.find(pred);
      if (hit) return hit;
    }
  }
  byClass(c: string) {
    return this.find((n) => n.classes.has(c));
  }
}
