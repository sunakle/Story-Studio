import { ui } from "../../shared/language";
import { setLanguage } from "../../shared/language";
import {
  newDocument,
  uid,
  validateDocument,
  type DesignDocument,
  type IllustratorArtwork,
} from "../../shared/model";
import { loadPreferences } from "./preferences";

// Each sandboxed frame owns one design and only communicates with its embedding workbench.
let session = "";
let pendingEdit: DesignDocument | null = null;
let cameraTimer: ReturnType<typeof setTimeout> | undefined;
const nativeRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

function post(kind: string, data: Record<string, unknown> = {}) {
  parent.postMessage(
    { type: "storyforge:gigma-" + kind, session, ...data },
    "*",
  );
}
function sendEdit() {
  clearTimeout(cameraTimer);
  cameraTimer = undefined;
  const document = pendingEdit;
  pendingEdit = null;
  if (session && document) post("change", { document });
}
export function publishEdit(document: DesignDocument, immediate = true) {
  pendingEdit = document;
  if (immediate) sendEdit();
  else if (!cameraTimer) cameraTimer = setTimeout(sendEdit, 150);
}
export function requestSave(saveAs = false) {
  sendEdit();
  post("save", { saveAs });
}
export function importWorkspace(value: DesignDocument) {
  post("import", { document: validateDocument(value) });
}

type IllustratorJob = {
  mode: "export";
  document: DesignDocument;
  selection?: string[];
};
function callIllustrator(
  action: "open" | "export",
  job?: IllustratorJob,
): Promise<unknown> {
  const requestId = uid();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      nativeRequests.delete(requestId);
      reject(
        new Error(
          ui(
            "Illustrator не завершил операцию. Повторите её из меню редактора.",
            "Illustrator did not finish. Try the command again from the editor menu.",
          ),
        ),
      );
    }, 240000);
    nativeRequests.set(requestId, { resolve, reject, timeout });
    post("illustrator", { requestId, action, ...(job && { job }) });
  });
}
export const illustrator = {
  open: () => callIllustrator("open") as Promise<IllustratorArtwork | null>,
  export: (job: IllustratorJob) =>
    callIllustrator("export", job) as Promise<Uint8Array>,
};

function appearance(message: { theme?: string; language?: string }) {
  if (message.theme === "dark" || message.theme === "light")
    document.documentElement.dataset.theme = message.theme;
  const lang = message.language === "en" ? "en" : "ru";
  document.documentElement.lang = lang;
  setLanguage(lang);
}
export function bindWorkspace(
  open: (document: DesignDocument) => void,
  finish: () => DesignDocument | null,
  report: (reason: Error) => void,
) {
  let loaded = false;
  const receive = (event: MessageEvent) => {
    const msg = event.data;
    if (
      event.source !== parent ||
      !msg ||
      typeof msg !== "object" ||
      typeof msg.session !== "string" ||
      !msg.session ||
      msg.session.length > 200
    )
      return;
    try {
      if (msg.type === "storyforge:gigma-load") {
        if (loaded) return;
        session = msg.session;
        appearance(msg);
        loadPreferences(msg.preferences);
        const fresh = msg.document === null;
        const design = fresh
          ? newDocument(String(msg.name || "Gigma").slice(0, 200))
          : validateDocument(msg.document);
        open(design);
        loaded = true;
        post("loaded", fresh ? { document: design } : {});
      } else if (msg.session === session && loaded) {
        if (msg.type === "storyforge:gigma-flush" && msg.requestId != null) {
          const document = finish();
          if (!document)
            throw Error(
              ui(
                "Редактор ещё не готов к сохранению.",
                "The editor is not ready to save yet.",
              ),
            );
          sendEdit();
          post("flushed", { requestId: msg.requestId, document });
        } else if (msg.type === "storyforge:gigma-appearance") {
          appearance(msg);
        } else if (msg.type === "storyforge:gigma-illustrator-result") {
          const job = nativeRequests.get(msg.requestId);
          if (!job) return;
          nativeRequests.delete(msg.requestId);
          clearTimeout(job.timeout);
          if (msg.error) job.reject(new Error(String(msg.error)));
          else job.resolve(msg.result);
        }
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      report(err);
      post("error", { message: err.message, requestId: msg.requestId });
    }
  };
  const prefs = (event: Event) => {
    if (loaded)
      post("preferences", { preferences: (event as CustomEvent).detail });
  };
  window.addEventListener("message", receive);
  window.addEventListener("gigma-preferences", prefs);
  post("ready");
  return () => {
    window.removeEventListener("message", receive);
    window.removeEventListener("gigma-preferences", prefs);
    clearTimeout(cameraTimer);
    for (const job of nativeRequests.values()) {
      clearTimeout(job.timeout);
      job.reject(
        new Error(
          ui("Окно макета закрыто.", "The design workspace was closed."),
        ),
      );
    }
    nativeRequests.clear();
  };
}
