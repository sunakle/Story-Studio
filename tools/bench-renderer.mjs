// Native Electron benchmark. Run via --selftest --selftest-file=tools/bench-renderer.mjs
// in an isolated profile. Output is the normal .logs/selftest.json of that copy.
const { store, ui } = window.__sfTest;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const painted = async () => { await frame(); await frame(); };
const round = value => Math.round(value * 10) / 10;
const percentile = (values, fraction) => round([...values].sort((a, b) => a - b)[Math.ceil(fraction * values.length) - 1]);
const measure = async task => {
  const start = performance.now();
  await task();
  return performance.now() - start;
};
const q = selector => document.querySelector(selector);
const check = (value, msg) => { if (!value) throw Error(msg); };

const stressFile = await window.sf.file.openPath('demo/stress-overview.sfproj');
const demoFile = await window.sf.file.demo();
const stress = JSON.parse(stressFile.content);
const example = JSON.parse(demoFile.content);
const results = [];
for (const kind of ['stress201', 'synthetic1000', 'media201']) {
  const p = structuredClone(stress);
  if (kind === 'synthetic1000') {
    for (let i = p.nodes.length; i < 1000; i++) {
      p.nodes.push({ ...structuredClone(stress.nodes[0]), id: 'bench_' + i,
        next: i < 999 ? 'bench_' + (i + 1) : '', position: { x: (i % 40) * 300, y: Math.floor(i / 40) * 160 } });
    }
  }
  if (kind === 'media201') {
    const image = Object.values(example.media)[0];
    for (let i = 0; i < 100; i++) {
      const id = 'bench_media_' + i;
      p.media[id] = { ...image, id };
      p.nodes[i].media = [id];
      p.nodes[i].previewId = id;
    }
  }
  store.setProject(p);
  const line = p.nodes.find(n => n.type === 'line');
  ui.setLeftTab('script');
  ui.selectNode(line.id);
  ui.graph.setZoom(1);
  ui.graph.centerOn(line.id);
  await wait(450);
  const open = [], pan = [], input = [], search = [], save = [];
  const openCpu = [], panHandler = [], inputHandler = [], idle = [];
  const counts = { nodes: p.nodes.length, images: Object.keys(p.media || {}).length,
    storyEdges: p.nodes.reduce((sum, n) => sum + Number(Boolean(n.next)) +
      (n.choices || []).filter(c => c.next).length + (n.branches || []).filter(b => b.next).length, 0),
    bytesCompact: new TextEncoder().encode(JSON.stringify(p)).length,
    bytesProject: new TextEncoder().encode(JSON.stringify(p, null, 2)).length };
  for (let i = 0; i < 5; i++) {
    open.push(await measure(async () => {
      const command = performance.now();
      ui.visualizer.open();
      openCpu.push(performance.now() - command);
      await painted();
      check(q('#vizRoot canvas')?.getBoundingClientRect().width && ui.visualizer.isOpen(), 'Обзор не показан');
    }));
    counts.overviewVertices = ui.visualizer.stats.nodes;
    counts.overviewLinks = ui.visualizer.stats.links;
    ui.visualizer.close();
    await wait(70);
  }
  const svg = q('#graph');
  const pos = svg.getBoundingClientRect();
  check(pos.width && pos.height, 'Граф скрыт');
  // The synthetic pointer is dispatched to the same handlers as a captured
  // physical pointer; Chromium cannot capture a synthetic pointer ID.
  const capture = svg.setPointerCapture;
  svg.setPointerCapture = () => {};
  for (let run = 0; run < 3; run++) {
    const init = { clientX: pos.left + 50, clientY: pos.top + 50, bubbles: true, button: 1,
      buttons: 4, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const view = () => q('#sfViewport').getAttribute('transform');
    const before = view();
    svg.dispatchEvent(new PointerEvent('pointerdown', init));
    let previous = await frame();
    for (let i = 1; i <= 32; i++) {
      const moved = performance.now();
      window.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: init.clientX + i * 3 }));
      panHandler.push(performance.now() - moved);
      const now = await frame(); pan.push(now - previous); previous = now;
    }
    check(before !== view(), 'Панорама не сдвинулась');
    window.dispatchEvent(new PointerEvent('pointerup', init));
  }
  svg.setPointerCapture = capture;

  const field = '#inspectorBody [data-focus="text"]';
  q(field)?.focus();
  await wait(200);
  let lostInputs = 0;
  for (let i = 0; i < 24; i++) {
    const box = q(field);
    check(box, 'Инспектор не открыл текст');
    box.focus();
    const value = box.value + 'я';
    const started = performance.now();
    {
      box.value = value;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      inputHandler.push(performance.now() - started);
      await painted();
      while (q(field)?.value !== value && performance.now() - started < 1000) await frame();
      if (q(field)?.value === value) input.push(performance.now() - started);
      else lostInputs++;
    }
  }
  q(field).blur();
  await wait(420);

  ui.setLeftTab('search');
  const searchTerms = ['Лифт останавливается', 'На полу мелом'];
  for (let i = 0; i < 8; i++) {
    const term = searchTerms[i % 2];
    const needle = p.nodes.find(n => n.text?.includes(term)).id;
    search.push(await measure(async () => {
      const box = q('#panelSearchInput'); box.focus(); box.value = term;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      const deadline = performance.now() + 5000;
      do {
        await frame();
        if (performance.now() > deadline) throw Error('Не найден результат поиска: ' + term);
      } while (q('#panelSearchInput')?.getAttribute('value') !== term || !q('#leftBody [data-node="' + needle + '"]'));
      await frame();
    }));
  }
  const tmp = new URLSearchParams(location.search).get('tmp');
  check(tmp, 'Нужен временный файл тестового профиля');
  for (let i = 0; i < 5; i++) {
    save.push(await measure(async () => {
      const result = await window.sf.file.save(tmp, JSON.stringify(store.project, null, 2));
      check(result?.ok, result?.error || 'Не удалось сохранить');
    }));
  }

  if (typeof globalThis.gc === 'function') globalThis.gc();
  const heapBefore = performance.memory?.usedJSHeapSize;
  for (let i=0; i<20; i++) {
    store.apply([{op:'updateNode', id:line.id, patch:{title:'Замер ' + i}}]);
  }
  for (let i=0; i<10; i++) store.undo();
  await wait(450); 
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const heapAfter = performance.memory?.usedJSHeapSize;
  ui.setLeftTab('script');
  await wait(250);
  let lastIdle = await frame();
  for (let i=0; i<40; i++) {
    const now = await frame(); idle.push(now-lastIdle); lastIdle=now;
  }
  results.push({ kind, counts,
    idleP95Ms: percentile(idle,.95), openCallMedianMs: percentile(openCpu,.5),
    panHandlerP95Ms: percentile(panHandler,.95), inputHandlerP95Ms: percentile(inputHandler,.95),
    lostInputs, openMedianMs: percentile(open,.5), openColdMs: round(open[0]),
    panP95Ms: percentile(pan,.95), inputP95Ms: percentile(input,.95),
    searchMedianMs: percentile(search,.5), saveMedianMs: percentile(save,.5),
    heapAfter20EditsAnd10UndoMiB: round(heapAfter/1048576), heapDeltaMiB: round((heapAfter-heapBefore)/1048576),
    samples: { open: open.map(round), pan: pan.map(round), input: input.map(round), search: search.map(round),
      save: save.map(round), idle: idle.map(round), panHandler: panHandler.map(round), inputHandler: inputHandler.map(round) } });
}
const __sfOut = { recordedAt: new Date().toISOString(), versions: window.sf.versions,
  width: innerWidth, height: innerHeight, outerWidth, outerHeight, devicePixelRatio, gcExposed: typeof globalThis.gc === 'function',
  method: 'Interactive and input bounds: action to two animation frames. Pan: 3×32 successive rAF intervals at zoom 1, SVG translation verified. Search: 8 alternating literal queries from field input to matching row + frame, includes debounce. Save: 5 serialize + real IPC writes in private QA folder. JS heap measured after 20 distinct edits and 10 undo. Idle cadence is 40 frames following a 250 ms settling period. Dispatch CPU records the synchronous part of the event only.',
  results };
