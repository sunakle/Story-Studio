// Готовит демо-изображение (полоса «настольной лампы») и прикрепляет его к сцене
// демо-проекта — чтобы при первом запуске было видно, как работает превью.
import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

const W = 320;
const H = 180;

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// Полотно: ночной склад — холодный фон, тёплое пятно лампы, пол и стена.
const raw = Buffer.alloc((W * 3 + 1) * H);
const lampX = W * 0.62;
const lampY = H * 0.34;
for (let y = 0; y < H; y += 1) {
  const row = y * (W * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < W; x += 1) {
    const t = y / H;
    let r = Math.round(14 + 22 * t);
    let g = Math.round(18 + 24 * t);
    let b = Math.round(24 + 28 * t);

    // тёплый ореол лампы
    const dx = (x - lampX) / (W * 0.42);
    const dy = (y - lampY) / (H * 0.55);
    const d = Math.sqrt(dx * dx + dy * dy);
    const glow = Math.max(0, 1 - d) ** 2;
    r = Math.min(255, Math.round(r + glow * 210));
    g = Math.min(255, Math.round(g + glow * 150));
    b = Math.min(255, Math.round(b + glow * 74));

    // пол — чуть светлее и с намёком на доски
    if (y > H * 0.72) {
      const plank = Math.sin(x * 0.22) * 3;
      r = Math.min(255, Math.round(r + 12 + plank));
      g = Math.min(255, Math.round(g + 10 + plank));
      b = Math.min(255, Math.round(b + 9 + plank));
    }

    // стеллаж слева: редкие вертикальные тени
    if (x < W * 0.2 && Math.floor(x / 18) % 2 === 0) {
      r = Math.round(r * 0.72);
      g = Math.round(g * 0.74);
      b = Math.round(b * 0.8);
    }

    const p = row + 1 + x * 3;
    raw[p] = r;
    raw[p + 1] = g;
    raw[p + 2] = b;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // бит на канал
ihdr[9] = 2; // truecolor RGB
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
const file = 'demo/demo-project.json';
const project = JSON.parse(readFileSync(file, 'utf8'));
project.media = project.media || {};
project.media.m_demo_warehouse = {
  id: 'm_demo_warehouse',
  name: 'Склад №4.png',
  mime: 'image/png',
  w: W,
  h: H,
  size: png.length,
  data: dataUrl,
};
const scene = project.nodes.find((n) => n.id === 'n_scene_cor');
if (!scene) throw new Error('сцена n_scene_cor не найдена');
scene.media = ['m_demo_warehouse'];
scene.previewId = 'm_demo_warehouse';
writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
console.log(`PNG ${W}×${H}, ${png.length} байт; data-URL ${dataUrl.length} символов; привязан к ${scene.id}`);