import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const SIZES = [16, 32, 48, 128];
const PINK = [255, 77, 109];
const WHITE = [255, 255, 255];
const SAMPLES = 4;

function inHeart(x, y) {
  const a = x * x + y * y - 1;
  return a * a * a - x * x * y * y * y <= 0;
}

function shade(size, px, py) {
  let r = 0;
  let g = 0;
  let b = 0;
  let hits = 0;
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < SAMPLES; j++) {
      const x = ((px + (i + 0.5) / SAMPLES) / size - 0.5) * 2.5;
      const y = (0.5 - (py + (j + 0.5) / SAMPLES) / size) * 2.5 + 0.1;
      if (!inHeart(x, y)) continue;
      const [cr, cg, cb] = Math.abs(x + y - 0.1) < 0.14 ? WHITE : PINK;
      r += cr;
      g += cg;
      b += cb;
      hits++;
    }
  }
  if (!hits) return [0, 0, 0, 0];
  return [r / hits, g / hits, b / hits, (255 * hits) / (SAMPLES * SAMPLES)].map(Math.round);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      Buffer.from(shade(size, x, y)).copy(raw, y * stride + 1 + x * 4);
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('icons', { recursive: true });
for (const size of SIZES) writeFileSync(`icons/icon${size}.png`, png(size));
console.log(`wrote ${SIZES.map((s) => `icons/icon${s}.png`).join(', ')}`);
