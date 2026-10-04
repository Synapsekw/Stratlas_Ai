// Paged layout of the house report: fixed A4 page frames filled block by block. A block that
// does not fit starts a new page; headings stay with the block after them; tables repeat their
// header on every page; a paragraph longer than a page is split between sentences. Page numbers
// are known once laid out, so the contents and the register can point at pages.

export interface PageFrame {
  page: HTMLElement;
  /** The content box of the page (fixed height, overflow hidden). */
  body: HTMLElement;
}

export interface PagerOptions {
  root: HTMLElement;
  /** Make an empty page of a section, already in `root`. */
  frame: (section: string) => PageFrame;
  /** Is the body's content taller than its box? (The report page measures the layout.) */
  overflows: (body: HTMLElement) => boolean;
}

/** Split a paragraph's text between sentences, near the middle; null when it cannot be split. */
export function splitSentences(text: string): [string, string] | null {
  const cuts: number[] = [];
  const re = /[.!?;:]\s+(?=\S)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) cuts.push(m.index + m[0].length);
  if (cuts.length === 0) {
    const space = text.lastIndexOf(' ', Math.floor(text.length / 2));
    return space > 0 ? [text.slice(0, space), text.slice(space + 1)] : null;
  }
  const mid = text.length / 2;
  const at = cuts.reduce((best, c) => (Math.abs(c - mid) < Math.abs(best - mid) ? c : best));
  return [text.slice(0, at).trimEnd(), text.slice(at)];
}

export class Pager {
  readonly pages: HTMLElement[] = [];
  private body: HTMLElement | null = null;
  private section = '';
  private readonly opts: PagerOptions;
  /** Blocks on the current page since the last page break that must move with the next block. */
  private held: HTMLElement[] = [];

  constructor(opts: PagerOptions) {
    this.opts = opts;
  }

  /** Start a section on a new page; returns its first page number (1-based). */
  start(section: string): number {
    this.section = section;
    this.held = [];
    this.newPage();
    return this.pages.length;
  }

  /** A page that holds exactly this content (cover, issue page): no flow. */
  fixed(section: string, html: string): HTMLElement {
    this.section = section;
    this.held = [];
    const { page, body } = this.opts.frame(section);
    body.innerHTML = html;
    this.pages.push(page);
    this.body = null;
    return page;
  }

  private newPage(): HTMLElement {
    const { page, body } = this.opts.frame(this.section);
    this.pages.push(page);
    this.body = body;
    return body;
  }

  private current(): HTMLElement {
    return this.body ?? this.newPage();
  }

  private empty(body: HTMLElement): boolean {
    return body.childElementCount === 0;
  }

  /**
   * Add a block. `keep`: keep this block on the page of the next one (a heading). Returns the
   * page number the block landed on.
   */
  add(el: HTMLElement, keep = false): number {
    let body = this.current();
    body.appendChild(el);
    if (this.opts.overflows(body) && !this.onlyHeld(body, el)) {
      body.removeChild(el);
      const moving = this.held;
      for (const h of moving) body.removeChild(h);
      body = this.newPage();
      for (const h of moving) body.appendChild(h);
      body.appendChild(el);
    }
    if (this.opts.overflows(body) && el.tagName === 'P') {
      // taller than a page on its own: split it between sentences
      const first = this.pages.length;
      body.removeChild(el);
      this.splitInto(el);
      this.held = [];
      return first;
    }
    this.held = keep ? [...this.held, el] : [];
    return this.pages.length;
  }

  /** Is `el` alone on the page apart from held blocks (so moving it would not help)? */
  private onlyHeld(body: HTMLElement, el: HTMLElement): boolean {
    return [...body.children].every((c) => c === el || this.held.includes(c as HTMLElement));
  }

  /** Lay out a paragraph too tall for a page, splitting its text between sentences. */
  private splitInto(p: HTMLElement): void {
    const text = p.textContent;
    const parts = splitSentences(text);
    const make = (t: string) => {
      const q = p.cloneNode(false) as HTMLElement;
      q.textContent = t;
      return q;
    };
    if (!parts) {
      // one unbreakable run: let it clip rather than loop
      this.current().appendChild(make(text));
      return;
    }
    for (const t of parts) {
      const q = make(t);
      const body = this.current();
      body.appendChild(q);
      if (!this.opts.overflows(body)) continue;
      body.removeChild(q);
      if (!this.empty(body)) {
        this.newPage();
        const next = this.current();
        next.appendChild(q);
        if (!this.opts.overflows(next)) continue;
        next.removeChild(q);
      }
      this.splitInto(q);
    }
  }

  /**
   * A table whose rows flow over pages; the header row repeats on every page. Returns the page
   * number of each row.
   */
  table(
    make: () => { table: HTMLElement; tbody: HTMLElement },
    rows: readonly HTMLElement[],
  ): number[] {
    const out: number[] = [];
    // a heading held for the table moves with it when its first row does not fit
    const heading = this.held;
    let t = make();
    this.add(t.table);
    let body = this.current();
    for (const row of rows) {
      t.tbody.appendChild(row);
      if (this.opts.overflows(body)) {
        const first = t.tbody.childElementCount === 1;
        const moving = first ? [...heading.filter((h) => h.parentElement === body), t.table] : [];
        const alone = first && body.childElementCount === moving.length;
        if (!alone) {
          t.tbody.removeChild(row);
          for (const m of moving) body.removeChild(m);
          body = this.newPage();
          if (first) {
            for (const m of moving) body.appendChild(m);
          } else {
            t = make();
            body.appendChild(t.table);
          }
          t.tbody.appendChild(row);
        }
      }
      out.push(this.pages.length);
    }
    this.held = [];
    return out;
  }
}
