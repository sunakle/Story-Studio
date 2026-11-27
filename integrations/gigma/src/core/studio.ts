import { ui } from "../../shared/language";
import { publishEdit } from "./workspace";
import {
  validateDocument,
  type DesignDocument,
  type DesignPage,
} from "../../shared/model";
import { descendants, refreshGroups } from "./geometry";
type Snapshot = {
  before: DesignDocument;
  after: DesignDocument;
  bytes: number;
  label: string;
};
type Translation = {
  pageId: string;
  positions: { id: string; x: number; y: number }[];
  dx: number;
  dy: number;
  bytes: number;
  label: string;
};
type Entry = Snapshot | Translation;
export class Studio {
  artworkVersion = 0;
  private cameraFrame = 0;
  private revealedPage: { id: string; from: string } | null = null;
  private revealedView: { page: DesignPage; view: DesignPage["view"] } | null = null;
  document: DesignDocument | null = null;
  selection: string[] = [];
  version = 0;
  generation = 0;
  listeners = new Set<() => void>();
  undoStack: Entry[] = [];
  redoStack: Entry[] = [];
  before: DesignDocument | null = null;
  label = "";
  historyBytes = 0;
  subscribe = (callback: () => void) => {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  };
  snapshot = () => this.version;
  emit = (artworkChanged = true) => {
    if (artworkChanged) this.artworkVersion++;
    this.version++;
    this.listeners.forEach((fn) => fn());
  };
  get page(): DesignPage | null {
    const doc = this.document;
    if (!doc) return null;
    const id = this.revealedPage?.from === doc.activePageId ? this.revealedPage.id : doc.activePageId;
    return doc.pages.find(p => p.id === id) ?? null;
  }
  // Following a project link must not create an undo entry above the artwork
  // operation which produced that link, even if the host later flushes the iframe.
  revealPage(id: string) {
    if (!this.document || this.page?.id === id) return;
    this.revealedPage = { id, from:this.document.activePageId };
    this.revealedView = null;
    this.emit(false);
  }
  viewFor(page: DesignPage) {
    return this.revealedView?.page === page ? this.revealedView.view : page.view;
  }
  revealView(page: DesignPage, view: DesignPage["view"]) {
    this.revealedView = { page, view };
    this.emit(false);
  }
  select(ids: string[]) {
    if (
      ids.length === this.selection.length &&
      ids.every((id, i) => id === this.selection[i])
    )
      return;
    this.selection = ids;
    this.emit(false);
  }
  begin(label: string) {
    if (!this.document) return;
    if (this.before) this.finish();
    this.before = structuredClone(this.document);
    this.before.cover = "";
    this.label = label;
  }
  finish() {
    if (!this.document || !this.before) return;
    refreshGroups(this.page!.nodes);
    const after = structuredClone(this.document);
    after.cover = "";
    const before = this.before;
    this.before = null;
    const original = JSON.stringify(before),
      current = JSON.stringify(after);
    if (original !== current) {
      this.record({
        before,
        after,
        bytes: (original.length + current.length) * 2,
        label: this.label,
      });
      this.changed();
    }
    this.emit();
  }
  private record(entry: Entry) {
    this.undoStack.push(entry);
    this.redoStack = [];
    this.historyBytes += entry.bytes;
    while (this.historyBytes > 64 * 1024 * 1024 || this.undoStack.length > 128)
      this.historyBytes -= this.undoStack.shift()!.bytes;
  }
  translate(page: DesignPage, ids: string[], dx: number, dy: number) {
    if (page !== this.page || (!dx && !dy)) return;
    if (this.before) this.finish();
    const all = descendants(page.nodes, ids);
    const positions = page.nodes
      .filter((n) => all.has(n.id))
      .map(({ id, x, y }) => ({ id, x, y }));
    if (!positions.length) return;
    const entry = {
      pageId: page.id,
      positions,
      dx,
      dy,
      bytes: 128 + positions.length * 128,
      label: ui("Переместить", "Move"),
    };
    this.record(entry);
    this.applyTranslation(entry, true);
  }
  private applyTranslation(entry: Translation, forward: boolean) {
    const page = this.document?.pages.find((p) => p.id === entry.pageId);
    if (!page) return;
    const nodes = new Map(page.nodes.map((n) => [n.id, n]));
    for (const p of entry.positions) {
      const n = nodes.get(p.id);
      if (n) {
        n.x = p.x + (forward ? entry.dx : 0);
        n.y = p.y + (forward ? entry.dy : 0);
      }
    }
    refreshGroups(page.nodes);
    this.changed();
    this.emit();
  }
  mutate(label: string, fn: (doc: DesignDocument, page: DesignPage) => void) {
    if (!this.document || !this.page) return;
    this.begin(label);
    try {
      fn(this.document, this.page);
      validateDocument(this.document);
      this.finish();
    } catch (e) {
      if (this.before) this.document = this.before;
      this.before = null;
      this.emit();
      throw e;
    }
  }
  changed(immediate = true) {
    if (!this.document) return;
    if (this.revealedPage?.from === this.document.activePageId && this.page) {
      this.document.activePageId = this.page.id;
    }
    this.revealedPage = null;
    this.generation++;
    this.document.revision++;
    this.document.updatedAt = new Date().toISOString();
    this.document.cover = "";
    publishEdit(this.document, immediate);
  }
  activatePage(id: string) {
    if (!this.document) return;
    const previous = this.page?.id;
    this.revealedPage = null;
    if (previous !== id) this.revealedView = null;
    if (this.document.activePageId === id) {
      if (previous !== id) this.emit(false);
      return;
    }
    this.document.activePageId = id;
    this.changed();
    this.emit();
  }
  // Camera events change a few numbers. Batch UI updates and keep full document
  // serialization out of the input handler. Closing the window still flushes the view.
  camera(fn: (page: DesignPage) => void) {
    const page = this.page;
    if (!page) return;
    const { x, y, zoom } = page.view;
    if (this.revealedView?.page === page) page.view = {...this.revealedView.view};
    this.revealedView = null;
    fn(page);
    if (page.view.x === x && page.view.y === y && page.view.zoom === zoom) return;
    this.changed(false);
    if (!this.cameraFrame)
      this.cameraFrame = requestAnimationFrame(() => {
        this.cameraFrame = 0;
        this.emit(false);
      });
  }
  undo() {
    if (this.before) this.finish();
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.historyBytes -= entry.bytes;
    this.redoStack.push(entry);
    if ("positions" in entry) this.replayTranslation(entry, false);
    else this.restore(entry.before);
  }
  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.undoStack.push(entry);
    this.historyBytes += entry.bytes;
    if ("positions" in entry) this.replayTranslation(entry, true);
    else this.restore(entry.after);
  }
  private replayTranslation(entry: Translation, forward: boolean) {
    this.revealedPage = this.revealedView = null;
    if (this.document) this.document.activePageId = entry.pageId;
    this.selection = [];
    this.applyTranslation(entry, forward);
  }
  private restore(doc: DesignDocument) {
    this.revealedPage = this.revealedView = null;
    const revision = this.document?.revision ?? doc.revision;
    this.document = { ...structuredClone(doc), revision };
    this.selection = [];
    this.changed();
    this.emit();
  }
  open(value: DesignDocument) {
    this.revealedPage = this.revealedView = null;
    const doc = validateDocument(value);
    this.before = null;
    this.document = doc;
    this.generation = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.historyBytes = 0;
    this.selection = [];
    this.emit();
  }
}
export const studio = new Studio();
