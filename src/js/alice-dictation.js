import { t, onLanguageChange } from './i18n.js';

// Session state belongs to one loaded document. A Save As changes its path
// but keeps its generation; opening, restoring or creating a project changes it.
export function createAliceDictation(store, ui, { changed = () => {}, now = Date.now } = {}) {
  let session = null;
  const retired = new Map();
  const state = (ok, code) => ({ok, ...(code && {code}), active: !!session, lastSeq: session?.seq || 0});
  const inactive = id => ({ok:false, code:'inactive', active:false, lastSeq:retired.get(id) || 0});
  function stop() {
    if (!session) return;
    retired.set(session.id, session.seq);
    session = null;
    changed(false);
  }
  function expire() {
    if (session && (store.generation !== session.generation || now() - session.heartbeat > 90000)) stop();
  }
  function handle(command) {
    expire();
    const { action, session:id } = command;
    if (action === 'start') {
      if (session?.id === id) {
        session.heartbeat = now();
        return state(true);
      }
      if (retired.has(id)) return inactive(id);
      if (session) return {ok:false, code:'busy', active:false};
      ui.flushEdits();
      ui.workbench.openScreenplay();
      session = {id, generation:store.generation, heartbeat:now(), seq:0};
      changed(true);
      return state(true);
    }
    if (!session || session.id !== id) {
      if (action === 'stop' && !retired.has(id)) retired.set(id, 0);
      return inactive(id);
    }
    session.heartbeat = now();
    if (action === 'status') return state(true);
    if (action === 'stop') {
      const lastSeq = session.seq;
      stop();
      return {ok:true, active:false, lastSeq};
    }
    if (action !== 'append' || !Number.isSafeInteger(command.seq) || command.seq < 1 ||
      typeof command.text !== 'string' || !command.text.trim()) return state(false, 'invalid');
    if (command.seq <= session.seq) return state(true);
    if (command.seq !== session.seq + 1) return state(false, 'out_of_order');
    ui.flushEdits();
    const previous = store.project.screenplay;
    const phrase = command.text.trim();
    const gap = previous && !/\s$/.test(previous) && !/^[.,;:!?…]/.test(phrase) ? ' ' : '';
    const result = store.apply({op:'setScreenplay', text:previous + gap + phrase}, {
      label:t('Диктовка Алисы', 'Alice dictation'),
    });
    if (!result.ok) return state(false, 'invalid');
    session.seq = command.seq;
    return state(true);
  }
  return {handle, stop, expire};
}

export function bindAliceDictation(store, ui) {
  const bridge = window.sf.dictation;
  if (!bridge) return null;
  const bar = document.getElementById('aliceDictation');
  const label = bar.querySelector('[role="status"]');
  const button = bar.querySelector('button');
  function renderLabel() {
    label.textContent = t('Идёт диктовка', 'Dictation active');
    button.textContent = t('Остановить', 'Stop');
  }
  let watchdog;
  const controller = createAliceDictation(store, ui, {
    changed(active) {
      bar.hidden = !active;
      clearInterval(watchdog);
      if (active) watchdog = setInterval(controller.expire, 5000);
    },
  });
  renderLabel();
  onLanguageChange(renderLabel);
  button.addEventListener('click', controller.stop);
  store.subscribe(controller.expire);
  bridge.onCommand(command => {
    if (command.action === 'start' && document.querySelector('#modalRoot:not(.hidden), #studioRoot:not(.hidden)')) {
      return {ok:false, code:'busy', active:false};
    }
    return controller.handle(command);
  });
  return controller;
}
