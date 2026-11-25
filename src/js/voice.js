import { t as uiText } from './i18n.js';
// Озвучка диалогов: панель «Озвучка» — настройка голоса, прослушивание
// реплик и экспорт в WAV. Синтез — порт Dialogue Voice Studio (voice/render.js).

import { icon } from './icons.js';
import { FACTORY_VOICES, SPECS, diffFromPreset, resolveParams, specById } from './voice/params.js';
import { synthesize } from './voice/job.js';
import { formatSeconds } from './voice/wav.js';
import { LINE_TARGET, clearSampleCache, effectiveVoice, packSample, sampleAudio, takeSeed, voiceOperation, voiceTarget } from './voice/profile.js';

// Параметры, которые показываем в панели (остальные — в «Дополнительно»).
const MAIN_IDS = ['pitch', 'speed', 'duration', 'release', 'every', 'spread', 'jitter', 'source', 'blend'];
const EXTRA_GROUPS = ['voice', 'fx', 'eq', 'diction'];

const slug = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'replika';

export function createVoice({ root, store, ui }) {
  const state = {
    target: '', // '' — голос проекта, иначе id персонажа
    dir: (ui.settings && ui.settings.voiceDir) || '',

    busy: false,
    playing: null,
    progress: '',
    showAll: false,
  };

  const $ = (sel) => root.querySelector(sel);
  const esc = (v) => ui.escapeHTML(String(v == null ? '' : v));
  const project = () => store.project;
  const lineNodes = () =>
    (project().nodes || []).filter((n) => n.type === 'line' && String(n.text || '').trim());
  const speakerName = (node) => {
    const ch = (project().characters || []).find((c) => c.id === node.speakerId);
    return ch ? ch.name || uiText("Без имени", "Untitled") : '';
  };

  // ------------------------------------------------------------- голос

  const selectedLine = () => store.selection?.kind === 'node'
    ? project().nodes.find(n => n.id === store.selection.id && n.type === 'line') : null;
  const currentVoice = () => voiceTarget(project(), state.target, selectedLine())?.voice;
  const voice = () => effectiveVoice(project(), state.target, selectedLine());
  const effectiveParams = () => resolveParams(voice());
  const setVoice = (value) => {
    const op = voiceOperation(state.target, selectedLine(), value);
    const res = store.apply([op], uiText("Настройка голоса", "Voice settings"));
    if (!res.ok) ui.toast(res.error, 'bad');
    return res.ok;
  };
  const saveParams = (next, extras = {}) => {
    const preset = next.preset ?? voice().preset;
    return setVoice({ ...voice(), ...extras, preset, params: diffFromPreset(next, preset) });
  };

  const setPreset = (index) => {
    const params = resolveParams({ preset: index });
    saveParams({ ...params, preset: index });
  };

  // ------------------------------------------------------------- звук

  let ctx = null;
  const audio = () => {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  };

  let operation = new AbortController();
  const stop = () => {
    operation.abort();
    operation = new AbortController();
    state.busy = false;
    if (state.playing) {
      try {
        state.playing.onended = null;
        state.playing.stop();
      } catch {
        /* уже остановлен */
      }
      state.playing = null;
      state.playingId = '';
      render();
    }
  };

  const play = (rendered, id = '') => {
    const ac = audio();
    if (ac.state === 'suspended') ac.resume();
    const buffer = ac.createBuffer(2, rendered.left.length, rendered.rate);
    buffer.copyToChannel(rendered.left, 0);
    buffer.copyToChannel(rendered.right, 1);
    const source = ac.createBufferSource();
    source.buffer = buffer;
    source.connect(ac.destination);
    source.onended = () => {
      if (state.playing === source) {
        state.playing = null;
        state.playingId = '';
        render();
      }
    };
    source.start();
    state.playing = source;
    state.playingId = id;
    render();
  };

  const renderNode = (node, signal, wav) => {
    const profile = effectiveVoice(project(), LINE_TARGET, node);
    return synthesize({
      params: resolveParams(profile),
      sample: sampleAudio(profile.sample),
      text: wav ? node.text : node.text.slice(0, 600),
      seed: takeSeed(node, profile),
      mode: 'line',
    }, {
      signal,
      wav: wav && profile.output
        ? { targetRate: profile.output.rate, channels: profile.output.channels, bits: profile.output.bits }
        : wav,
    });
  };

  const playNode = async (id) => {
    ui.flushEdits?.();
    const node = (project().nodes || []).find((n) => n.id === id);
    if (!node || !String(node.text || '').trim()) {
      ui.toast(uiText("В этом узле нет текста для озвучки", "This node has no text to voice"), 'warn');
      return;
    }
    const replaying = state.playingId === id;
    stop();
    if (replaying) return;
    const signal = operation.signal;
    try {
      state.busy = true;
      render();
      const rendered = await renderNode(node, signal);
      if (!signal.aborted) play(rendered, node.id);
    } catch (err) {
      if (!signal.aborted) ui.toast(err.message, 'bad');
    } finally {
      if (!signal.aborted) state.busy = false;
      render();
    }
  };

  const fileNameFor = (node, index) => {
    const speaker = speakerName(node);
    return `${String(index + 1).padStart(2, '0')}_${slug(speaker || 'replika')}_${slug(node.id)}.wav`;
  };

  const ensureDir = async () => {
    if (state.dir) return state.dir;
    const res = await window.sf.voice.chooseDir(state.dir || '');
    if (!res.ok) return '';
    state.dir = res.dir;
    ui.saveSettings({ voiceDir: res.dir });
    render();
    return state.dir;
  };

  const exportNode = async (id) => {
    ui.flushEdits?.();
    stop();
    const signal = operation.signal;
    const nodes = lineNodes();
    const index = nodes.findIndex((n) => n.id === id);
    if (index < 0) {
      ui.toast(uiText("Нечего озвучивать", "No text to voice"), 'warn');
      return;
    }
    const dir = await ensureDir();
    if (!dir || signal.aborted) return;
    const node = nodes[index];
    try {
      state.busy = true;
      render();
      const rendered = await renderNode(node, signal, true);
      signal.throwIfAborted();
      const bytes = rendered.bytes;
      const res = await window.sf.voice.writeWav(dir, fileNameFor(node, index), bytes);
      if (signal.aborted) return;
      if (res.ok) ui.toast(`${uiText("Реплика сохранена", "Line saved")}: ${formatSeconds(rendered.seconds)}`, 'good');
      else ui.toast(res.error, 'bad');
    } catch (err) {
      if (!signal.aborted) ui.toast(err.message, 'bad');
    } finally {
      if (!signal.aborted) state.busy = false;
      render();
    }
  };

  const exportAll = async () => {
    ui.flushEdits?.();
    stop();
    const signal = operation.signal;
    const nodes = lineNodes();
    if (!nodes.length) {
      ui.toast(uiText("В проекте нет реплик с текстом", "The project has no lines with text"), 'warn');
      return;
    }
    const dir = await ensureDir();
    if (!dir || signal.aborted) return;
    state.busy = true;
    let written = 0;
    let failed = 0;
    try {
      for (let i = 0; i < nodes.length; ++i) {
        if (signal.aborted) return;
        state.progress = `${i + 1} ${uiText("из", "of")} ${nodes.length}`;
        render();
        try {
          const rendered = await renderNode(nodes[i], signal, true);
          signal.throwIfAborted();
          const bytes = rendered.bytes;
          const res = await window.sf.voice.writeWav(dir, fileNameFor(nodes[i], i), bytes);
          if (res.ok) written++;
          else failed++;
        } catch {
          failed++;
        }
        await new Promise((r) => setTimeout(r, 0));
      }
      if (signal.aborted) return;
      ui.toast(
        failed ? `${uiText("Готово", "Done")}: ${written}, ${uiText("не удалось", "failed")} ${failed}` : `${uiText("Озвучено реплик", "Lines rendered")}: ${written}`,
        failed ? 'warn' : 'good',
      );
    } finally {
      if (!signal.aborted) state.busy = false;
      state.progress = '';
      render();
    }
  };

  const loadSample = async () => {
    const signal = operation.signal;
    const res = await window.sf.voice.pickSample();
    if (signal.aborted) return;
    if (!res.ok) {
      if (res.error) ui.toast(res.error, 'bad');
      return;
    }
    try {
      const sample = packSample(res.bytes, res.name);
      const params = effectiveParams();
      if (saveParams({ ...params, source: params.source || 2 }, { sample })) {
        render();
        ui.toast(uiText("Сэмпл загружен", "Sample loaded"), 'good');
      }
    } catch (err) {
      ui.toast(err.message, 'bad');
    }
  };

  const clearSample = () => {
    const { sample, ...withoutSample } = voice();
    if (setVoice(withoutSample)) render();
  };

  // ------------------------------------------------------------- разметка

  const control = (id) => {
    const spec = specById(id);
    if (!spec) return '';
    const params = effectiveParams();
    const value = params[id];
    if (spec.names) {
      const options = spec.names
        .map((name, i) => `<option value="${i}"${Number(value) === i ? ' selected' : ''}>${esc(name)}</option>`)
        .join('');
      return `<label class="field voice-field">
        <span class="field-label">${esc(spec.label)}</span>
        <select class="select select-sm" data-voice-param="${id}">${options}</select>
      </label>`;
    }
    const step = spec.step || 1;
    return `<label class="field voice-field">
      <span class="field-label">${esc(spec.label)}${spec.unit ? ` <span class="voice-unit">${esc(spec.unit)}</span>` : ''}</span>
      <span class="voice-slider">
        <input class="input input-sm" type="range" min="${spec.min}" max="${spec.max}" step="${step}" value="${Number(value)}" data-voice-param="${id}">
        <output class="voice-value">${Number(value)}</output>
      </span>
    </label>`;
  };

  const voiceCard = () => {
    const own = currentVoice();
    const params = effectiveParams();
    const line = selectedLine();
    const profile = voice();
    const targetName = state.target
      ? ((project().characters || []).find((c) => c.id === state.target)?.name || uiText("Персонаж", "Character"))
      : uiText("Проект", "Project");
    const inherits = state.target && !own;
    const options = (project().characters || [])
      .map((c) => `<option value="${esc(c.id)}"${state.target === c.id ? ' selected' : ''}>${esc(c.name || uiText("Без имени", "Untitled"))}</option>`)
      .join('');
    const presets = FACTORY_VOICES.map(
      (v, i) => `<option value="${i}"${profile.preset === i ? ' selected' : ''}>${esc(v.name)}</option>`,
    ).join('');

    const sampleRow = profile.sample
      ? `<div class="voice-sample">
           <span class="voice-sample-name">${esc(profile.sample.name)}</span>
           <button class="btn btn-sm btn-ghost" data-voice-act="sample-clear">${uiText("Убрать", "Remove")}</button>
         </div>`
      : `<button class="btn btn-sm" data-voice-act="sample-load">${icon('plus', 12)} ${uiText("Загрузить", "Load")} WAV</button>`;

    return `<div class="card voice-card">
      <div class="card-head">
        <span class="card-title">${uiText("Голос", "Voice")}</span>
        <select class="select select-sm" data-voice-target>
          <option value=""${state.target ? '' : ' selected'}>${uiText("Проект — для всех", "Project default for all characters")}</option>
          ${line ? `<option value="${LINE_TARGET}"${state.target === LINE_TARGET ? ' selected' : ''}>${uiText('Выбранная реплика', 'Selected line')} · ${esc(line.title || line.id)}</option>` : ''}
          ${options}
        </select>
      </div>
      <div class="card-body">
        ${inherits ? `<p class="hint-text">${state.target === LINE_TARGET ? uiText("Реплика наследует голос персонажа или проекта.", "This line inherits the character or project voice.") : `${esc(targetName)} · ${uiText("Голос проекта", "Project voice")}`}</p>` : ''}
        <div class="voice-row">
          <label class="field">
            <span class="field-label">${uiText("Характер", "Personality")}</span>
            <select class="select select-sm" data-voice-preset>${presets}</select>
          </label>
          ${state.target ? `<button class="btn btn-sm" data-voice-act="reset">${icon('target', 12)} ${uiText("Наследовать", "Inherit")}</button>` : ''}
        </div>
        <p class="hint-text">${esc(FACTORY_VOICES[profile.preset]?.hint || '')}</p>
        <div class="voice-grid">${MAIN_IDS.map(control).join('')}</div>
        <div class="voice-row">${sampleRow}</div>
        <button class="btn btn-sm btn-ghost" data-voice-act="more">${state.showAll ? uiText("Свернуть", "Collapse") : uiText("Все параметры", "All parameters")}</button>
        ${state.showAll ? EXTRA_GROUPS.map((g) => groupBlock(g)).join('') : ''}
        <p class="hint-text">${uiText("Длительность слога", "Syllable length")}: ${esc(formatSeconds((params.duration || 0) / 1000))} · ${uiText("темп", "tempo")} ${Number(params.speed)} ${uiText("букв/с", "chars/s")}</p>
      </div>
    </div>`;
  };

  const groupBlock = (group) => {
    const items = SPECS.filter((s) => s.group === group);
    if (!items.length) return '';
    const titles = { voice: uiText("Источник", "Source"), fx: uiText("Эффекты", "Effects"), eq: uiText("Эквалайзер", "Equalizer"), diction: uiText("Дикция", "Diction") };
    return `<div class="voice-group">
      <div class="voice-group-title">${esc(titles[group] || group)}</div>
      <div class="voice-grid">${items.map((s) => control(s.id)).join('')}</div>
    </div>`;
  };

  const nodeList = () => {
    const nodes = lineNodes();
    if (!nodes.length) {
      return `<div class="empty">${uiText("Реплик пока нет. Добавьте узлы типа «Реплика» — озвучка появится здесь", "No dialogue lines yet. Add a Dialogue node to voice it here")}.</div>`;
    }
    const selected = store.selection && store.selection.kind === 'node' ? store.selection.id : '';
    const rows = nodes
      .map((n, i) => {
        const playing = state.playing && state.playingId === n.id;
        return `<div class="list-item voice-item${selected === n.id ? ' active' : ''}" data-voice-node="${esc(n.id)}">
          <div class="li-main">
            <div class="li-title"><span class="voice-num">${i + 1}</span>${esc(speakerName(n) || uiText("Без спикера", "No speaker"))}</div>
            <div class="li-sub voice-text">${esc(n.text)}</div>
          </div>
          <button class="btn btn-icon btn-sm" data-voice-act="play" data-id="${esc(n.id)}" title="${playing ? uiText("Остановить", "Stop") : uiText("Прослушать", "Listen")}">${icon(playing ? 'stop' : 'spark', 14)}</button>
          <button class="btn btn-icon btn-sm" data-voice-act="wav" data-id="${esc(n.id)}" title="${uiText("Сохранить", "Save")} WAV">${icon('copy', 14)}</button>
        </div>`;
      })
      .join('');
    return `<div class="voice-list">${rows}</div>`;
  };

  function render() {
    if (!root) return;
    if (state.target && !voiceTarget(project(), state.target, selectedLine())) state.target = '';
    const nodes = lineNodes();
    const busy = state.busy ? ' aria-busy="true"' : '';
    root.innerHTML = `<div class="voice-panel${state.busy ? ' is-busy' : ''}"${busy}>
      <div class="voice-studio-entry">
        <button class="btn btn-sm btn-primary" data-voice-act="studio">${icon('spark', 14)} ${uiText("Студия голоса", "Voice Studio")}</button>
        <span class="hint-text">${uiText("Полный интерфейс: вкладки, волна сэмпла, эквалайзер, эффекты, экспорт", "Full interface with tabs, sample waveform, equalizer, effects and export")} WAV</span>
      </div>
      ${voiceCard()}
      <div class="card voice-export">
        <div class="card-head"><span class="card-title">${uiText("Экспорт озвучки", "Export voice audio")}</span></div>
        <div class="card-body">
          <div class="voice-row">
            <button class="btn btn-sm" data-voice-act="dir">${icon('target', 12)} ${uiText("Папка", "Folder")}</button>
            <button class="btn btn-sm btn-primary" data-voice-act="all"${state.busy ? ' disabled' : ''}>${uiText("Озвучить все", "Render all lines")} (${nodes.length})</button>
            ${state.dir ? `<button class="btn btn-sm btn-ghost" data-voice-act="reveal" title="${uiText("Открыть папку", "Open folder")}">${icon('right', 12)}</button>` : ''}
          </div>
          <p class="hint-text voice-dir">${esc(state.dir || uiText("Папка не выбрана — спросим при первом экспорте", "Choose a folder on first export"))}</p>
          ${state.progress ? `<p class="hint-text">${uiText("Идёт озвучка", "Rendering voice")}: ${esc(state.progress)}</p>` : ''}
        </div>
      </div>
      <div class="voice-nodes-title">${uiText("Реплики", "Lines")} <span class="count-pill">${nodes.length}</span></div>
      ${nodeList()}
    </div>`;

    bind();
  }

  function bind() {
    root.querySelectorAll('[data-voice-act="studio"]').forEach((button) => {
      button.addEventListener('click', () => {
        if (ui.studio) ui.studio.open(state.target || (selectedLine() ? LINE_TARGET : ''));
        else ui.toast(uiText("Студия голоса не инициализирована", "Voice Studio is not ready"), 'bad');
      });
    });

    root.querySelectorAll('[data-voice-param]').forEach((input) => {
      input.addEventListener('input', () => {
        const id = input.getAttribute('data-voice-param');
        const spec = specById(id);
        if (!spec) return;
        const value = Number(input.value);
        const out = input.parentElement && input.parentElement.querySelector('.voice-value');
        if (out) out.textContent = String(Math.round(value * 100) / 100);
        saveParams({ ...effectiveParams(), [id]: value });
      });
    });

    const preset = $('[data-voice-preset]');
    if (preset) preset.addEventListener('change', () => setPreset(Number(preset.value)));

    const target = $('[data-voice-target]');
    if (target) {
      target.addEventListener('change', () => {
        stop();
        state.target = target.value;
        render();
      });
    }

    root.querySelectorAll('[data-voice-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.getAttribute('data-voice-act');
        const id = btn.getAttribute('data-id');
        if (act === 'play') playNode(id);
        else if (act === 'wav') exportNode(id);
        else if (act === 'all') exportAll();
        else if (act === 'dir') ensureDir();
        else if (act === 'reveal') window.sf.voice.reveal(state.dir);
        else if (act === 'sample-load') loadSample();
        else if (act === 'sample-clear') clearSample();
        else if (act === 'more') {
          state.showAll = !state.showAll;
          render();
        } else if (act === 'reset') {
          if (setVoice(null)) render();
        }
      });
    });

    root.querySelectorAll('[data-voice-node]').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const id = row.getAttribute('data-voice-node');
        ui.selectNode(id);
      });
    });
  }

  let generation = store.generation;
  store.subscribe(event => {
    if (generation !== store.generation) {
      generation = store.generation;
      clearSampleCache();
      state.target = '';
      stop();
    } else if (event.type === 'selection' || event.type === 'project' || event.type === 'change') {
      stop();
    }
  });

  return {
    render,
    playNode,
    stop,
    exportNode,
    exportAll,
    get isBusy() {
      return state.busy;
    },
    get dir() {
      return state.dir;
    },
  };
}
