// Just enough of an element for ui.js, loader.js, pill.js and the upload binding to build and touch.
type Listener = (e?: unknown) => void;

/** The element with the keyboard's focus; document.activeElement reads it. */
export const focus: { on: FakeNode | null } = { on: null };

export class FakeNode {
  tag: string;
  attrs = new Map<string, string>();
  kids: FakeNode[] = [];
  classes = new Set<string>();
  listeners = new Map<string, Listener[]>();
  hidden = false;
  removed = false;
  parent: FakeNode | null = null;
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
      } else {
        n.parent = this;
        this.kids.push(n);
      }
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
  // A dialog's: closing a modal one gives focus back to what had it when it opened, as a browser does, whether or not
  // focus was inside, and a removed element takes none.
  open = false;
  opener: FakeNode | null = null;
  showModal() {
    this.open = true;
    this.opener = focus.on;
  }
  close() {
    if (!this.open) return;
    this.open = false;
    const back = this.opener;
    this.opener = null;
    if (back && !back.gone) focus.on = back;
    else if (focus.on && this.contains(focus.on)) focus.on = null;
  }
  remove() {
    this.removed = true;
  }
  /** Removed itself, or inside something that was. */
  get gone(): boolean {
    return this.removed || (this.parent?.gone ?? false);
  }
  focused = 0;
  focus() {
    this.focused++;
    focus.on = this;
  }
  contains(other: FakeNode): boolean {
    return this === other || this.kids.some((k) => k.contains(other));
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
