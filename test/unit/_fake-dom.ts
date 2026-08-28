/**
 * A DOM small enough to run the Changed Files webview script against, with no
 * jsdom dependency. It implements only what that script touches, but it
 * implements `textContent` faithfully — assignment drops children and reading
 * concatenates descendants — because the target bar builds itself from a text
 * assignment followed by an appended span, and a naive string field would hide
 * exactly the ordering bug such code invites.
 */
export class FakeElement {
  readonly children: FakeElement[] = [];
  readonly style: Record<string, string> = {};
  private readonly attrs = new Map<string, string>();
  private readonly classes = new Set<string>();
  private ownText = '';
  title = '';
  id = '';
  tagName: string;

  constructor(tagName = 'div') {
    this.tagName = tagName;
  }

  set textContent(value: string) {
    this.children.length = 0;
    this.ownText = String(value);
  }
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }

  /** The script only ever assigns '' to clear the list. */
  set innerHTML(value: string) {
    if (value !== '') throw new Error(`FakeElement.innerHTML only supports '' (got ${value})`);
    this.children.length = 0;
    this.ownText = '';
  }

  set className(value: string) {
    this.classes.clear();
    for (const c of value.split(/\s+/).filter(Boolean)) this.classes.add(c);
  }
  get className(): string {
    return [...this.classes].join(' ');
  }

  readonly classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, force?: boolean) => {
      const on = force ?? !this.classes.has(c);
      if (on) this.classes.add(c);
      else this.classes.delete(c);
      return on;
    },
  };

  appendChild<T extends FakeElement>(child: T): T {
    // Like the real DOM, appending a fragment moves its children in rather
    // than the fragment itself — the script walks `list.children` and
    // `previousElementSibling` expecting the rows to be direct children.
    if (child.tagName === '#fragment') {
      for (const c of child.children) {
        c.parent = this;
        this.children.push(c);
      }
      child.children.length = 0;
      return child;
    }
    child.parent = this;
    this.children.push(child);
    return child;
  }
  parent: FakeElement | null = null;
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  addEventListener(): void {
    /* the script registers listeners at load; tests drive render() directly */
  }
  focus(): void {}
  scrollIntoView(): void {}
  closest(): FakeElement | null {
    return null;
  }
  get nextElementSibling(): FakeElement | null {
    return this.sibling(1);
  }
  get previousElementSibling(): FakeElement | null {
    return this.sibling(-1);
  }
  private sibling(offset: number): FakeElement | null {
    if (!this.parent) return null;
    const i = this.parent.children.indexOf(this);
    return i === -1 ? null : (this.parent.children[i + offset] ?? null);
  }

  /** Depth-first search by CSS class, e.g. '.target-repo'. Tests only. */
  find(selector: string): FakeElement | undefined {
    const cls = selector.replace(/^\./, '');
    for (const child of this.children) {
      if (child.classList.contains(cls)) return child;
      const hit = child.find(selector);
      if (hit) return hit;
    }
    return undefined;
  }
}

export interface FakeDom {
  /** Elements by id, created on demand so the script can wire any id it likes. */
  byId: Map<string, FakeElement>;
  document: unknown;
  window: { addEventListener(type: string, cb: (event: { data: unknown }) => void): void };
  /** Deliver a postMessage payload to the script's 'message' listener. */
  send(payload: unknown): void;
  /** Messages the script posted back to the extension host. */
  posted: unknown[];
  vscodeApi: unknown;
  /** What the script last passed to `vscode.setState` (undefined before any call). */
  readonly state: unknown;
}

/** `initialState` is what `vscode.getState()` returns when the script loads. */
export function createFakeDom(initialState?: unknown): FakeDom {
  const byId = new Map<string, FakeElement>();
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const posted: unknown[] = [];
  let state: unknown = initialState;

  const document = {
    getElementById(id: string): FakeElement {
      let el = byId.get(id);
      if (!el) {
        el = new FakeElement();
        el.id = id;
        byId.set(id, el);
      }
      return el;
    },
    createElement: (tag: string) => new FakeElement(tag),
    createDocumentFragment: () => new FakeElement('#fragment'),
    addEventListener: () => {},
  };

  return {
    byId,
    document,
    posted,
    get state() {
      return state;
    },
    window: {
      addEventListener(type: string, cb: (event: { data: unknown }) => void) {
        if (type === 'message') listeners.push(cb);
      },
    },
    send(payload: unknown) {
      for (const cb of listeners) cb({ data: payload });
    },
    vscodeApi: {
      postMessage: (m: unknown) => posted.push(m),
      setState: (s: unknown) => {
        state = s;
      },
      getState: () => state,
    },
  };
}

/** Pull the inlined script body out of the webview HTML. */
export function extractScript(html: string): string {
  const match = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error('no nonce-bearing <script> found in webview HTML');
  return match[1];
}

/** Execute the webview script against a fresh fake DOM and return it. */
export function runWebviewScript(html: string, initialState?: unknown): FakeDom {
  const dom = createFakeDom(initialState);
  const fn = new Function('document', 'window', 'acquireVsCodeApi', extractScript(html));
  fn(dom.document, dom.window, () => dom.vscodeApi);
  return dom;
}
