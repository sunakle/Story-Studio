// Проверяем, можно ли отвязать SVG-граф от лэйаута документа: явные размеры
// у <svg> и разные режимы изоляции (contain) на хосте и на самом svg.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (v) => Math.round(v * 10) / 10;

const res = await window.sf.file.openPath('demo/stress-overview.sfproj');
store.setProject(JSON.parse(res.content), { filePath: null, dirty: false });
await wait(300);
store.setSelection({ kind: 'node', id: store.project.startNodeId });
await wait(200);

const out = [];
const add = (name, info) => out.push({ ok: true, name, info });
const host = document.getElementById('graphHost');
const svg = document.getElementById('graph');
const body = document.getElementById('inspectorBody');
const hostW = Math.round(host.getBoundingClientRect().width);
const hostH = Math.round(host.getBoundingClientRect().height);
add('хост', `${hostW}×${hostH}`);
add('svg', `width=${svg.getAttribute('width')} height=${svg.getAttribute('height')} viewBox=${svg.getAttribute('viewBox')} элементы=${svg.querySelectorAll('*').length}`);

function reset() {
  for (const el of [host, svg, body]) el.removeAttribute('style');
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
}

async function cost(n = 5) {
  const area = body.querySelector('textarea[data-focus="text"]');
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    area.value += 'а';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    void body.offsetHeight;
    samples.push(performance.now() - t0);
    await wait(40);
  }
  area.value = area.value.slice(0, -n);
  return R(samples.reduce((a, b) => a + b, 0) / samples.length);
}

reset();
add('как есть', `${await cost()} мс`);

// 1. явные пиксельные размеры у svg
svg.setAttribute('width', String(hostW));
svg.setAttribute('height', String(hostH));
add('svg с явными width/height', `${await cost()} мс`);

// 2. + contain: strict на хосте
host.style.contain = 'strict';
host.style.width = `${hostW}px`;
host.style.height = `${hostH}px`;
add('+ contain:strict на хосте', `${await cost()} мс`);

// 3. + contain: strict на самом svg
svg.style.contain = 'strict';
add('+ contain:strict на svg', `${await cost()} мс`);

// 4. contain: size layout paint на svg
reset();
svg.setAttribute('width', String(hostW));
svg.setAttribute('height', String(hostH));
svg.style.contain = 'size layout paint';
add('svg: contain size layout paint', `${await cost()} мс`);

// 5. content-visibility:hidden на svg (контроль, граф не виден)
reset();
svg.setAttribute('width', String(hostW));
svg.setAttribute('height', String(hostH));
svg.style.contentVisibility = 'hidden';
add('svg content-visibility:hidden (контроль)', `${await cost()} мс`);

reset();
__sfOut = { summary: { total: out.length, passed: out.length, failed: 0 }, failed: [], jsErrors: [], checks: out };