import { t as uiText } from './i18n.js';
import { applyOps, uid } from './model.js';

const createKeys = {
  createNode: ['node', 'n_'], createCharacter: ['character', 'c_'],
  createVariable: ['variable', 'v_'], createChapter: ['chapter', 'ch_'],
  createLocation: ['location', 'l_'],
};

// Replaying a planned batch must create the same IDs that earlier tools returned.
function identify(op) {
  if (op.op === 'createGigmaWorkspace' && !op.id) return { ...op, id: uid('gg_') };
  const target = createKeys[op.op];
  if (!target) return op;
  const [key, prefix] = target;
  if (!op[key] || op[key].id) return op;
  return { ...op, [key]: { ...op[key], id: uid(prefix) } };
}

function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
}

// Check only the live fields that the author edited. Array members with stable
// IDs retain identity when a different member is inserted or removed.
function preservesManualFields(before, live, replayed) {
  if (same(before, live) || same(live, replayed)) return true;
  if (before == null || live == null || replayed == null) return false;
  if ([before, live, replayed].every(Array.isArray)) {
    if (![before, live, replayed].every(values => values.every(value => value?.id))) return false;
    const base = new Map(before.map(v => [v.id, v]));
    const after = new Map(replayed.map(v => [v.id, v]));
    const current = new Map(live.map(v => [v.id, v]));
    return [...new Set([...base.keys(), ...current.keys()])].every(id =>
      preservesManualFields(base.get(id), current.get(id), after.get(id)));
  }
  if (![before, live, replayed].every(value => typeof value === 'object' && !Array.isArray(value))) return false;
  return [...new Set([...Object.keys(before), ...Object.keys(live)])].every(key =>
    preservesManualFields(before[key], live[key], replayed[key]));
}

export function planProjectEdits(store) {
  const generation = store.generation;
  const revision = store.revision;
  // applyOps commits by replacing root fields. Like Store.undo snapshots, these
  // separate roots can share unchanged entities and embedded image data.
  const base = { ...store.project };
  const draft = { ...base };
  const batch = [];
  const readFields = new Set();
  function checkProject() {
    if (store.generation !== generation) throw new Error(uiText("Активный проект сменился. Правки AI отменены.", "The active project changed. AI edits were cancelled."));
  }
  return {
    project: draft,
    generation,
    observe(field) { readFields.add(field); },
    apply(ops) {
      checkProject();
      const identified = ops.map(identify);
      const result = applyOps(draft, identified);
      if (result.ok) batch.push(...identified);
      return result;
    },
    commit(label) {
      checkProject();
      if (!batch.length) return;
      if (store.revision !== revision) {
        for (const field of readFields) {
          if (!same(base[field], store.project[field])) {
            throw new Error(uiText("Исходный сценарий изменён вручную. Повторите запрос с актуальным текстом.", "The source screenplay was edited manually. Retry with its current text."));
          }
        }
        const merged = { ...store.project };
        const result = applyOps(merged, batch);
        if (!result.ok || !preservesManualFields(base, store.project, merged)) {
          throw new Error(uiText("Проект изменён вручную в тех же полях. Пакет AI отменён. Повторите запрос с текущей версией.", "The same fields were edited manually. AI edits were cancelled. Try again with the current project."));
        }
      }
      const result = store.apply(batch, { label });
      if (!result.ok) throw new Error(result.error);
    },
  };
}
