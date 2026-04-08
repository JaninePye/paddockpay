// Generates icons without needing canvas npm package
// Uses pure Node.js to write a valid PNG file from scratch

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function writePNG(width, height, pixels, outPath) {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type = RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Raw image data (filter byte 0 before each row)
  const raw = Buffer.allocUnsafe(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0; // filter type None
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 3;
      const dst = y * (1 + width * 3) + 1 + x * 3;
      raw[dst] = pixels[src];
      raw[dst + 1] = pixels[src + 1];
      raw[dst + 2] = pixels[src + 2];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  function chunk(type, data) {
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32BE(data.length, 0);
    const typeB = Buffer.from(type, 'ascii');
    const crcData = Buffer.concat([typeB, data]);
    const crcVal = crc32(crcData);
    const crcB = Buffer.allocUnsafe(4);
    crcB.writeUInt32BE(crcVal >>> 0, 0);
    return Buffer.concat([len, typeB, data, crcB]);
  }

  const png = Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  fs.writeFileSync(outPath, png);
}

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })());
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function generateIconPixels(size) {
  const pixels = new Uint8Array(size * size * 3);

  // Background colour: #1A1008
  const bgR = 0x1A, bgG = 0x10, bgB = 0x08;
  // Circle colour: #D4A843 (wheat gold)
  const circR = 0xD4, circG = 0xA8, circB = 0x43;

  const cx = size / 2, cy = size / 2;
  const circleRadius = size * 0.35;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 3;
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < circleRadius) {
        // Inside circle — blend wheat gold
        const t = Math.max(0, 1 - dist / circleRadius) * 0.25;
        pixels[idx]   = Math.round(bgR * (1 - t) + circR * t);
        pixels[idx+1] = Math.round(bgG * (1 - t) + circG * t);
        pixels[idx+2] = Math.round(bgB * (1 - t) + circB * t);
      } else {
        pixels[idx]   = bgR;
        pixels[idx+1] = bgG;
        pixels[idx+2] = bgB;
      }
    }
  }

  // Draw "P" letterform manually using a pixel mask scaled to size
  // We'll draw it as a simple thick stroked letter
  const letterHeight = Math.floor(size * 0.52);
  const letterWidth = Math.floor(size * 0.32);
  const startX = Math.floor(cx - letterWidth * 0.35);
  const startY = Math.floor(cy - letterHeight * 0.5);
  const strokeW = Math.max(2, Math.floor(size * 0.065));

  // Vertical stroke of P
  for (let y = startY; y < startY + letterHeight; y++) {
    for (let sw = 0; sw < strokeW; sw++) {
      const px = startX + sw;
      if (px >= 0 && px < size && y >= 0 && y < size) {
        const idx = (y * size + px) * 3;
        pixels[idx]   = circR;
        pixels[idx+1] = circG;
        pixels[idx+2] = circB;
      }
    }
  }

  // Bow of P (top half, right side arc)
  const bowHeight = Math.floor(letterHeight * 0.52);
  const bowRadius = Math.floor(letterWidth * 0.68);
  const bowCY = startY + bowRadius;
  const bowStartX = startX + strokeW - 1;

  for (let angle = -Math.PI / 2; angle <= Math.PI / 2; angle += 0.01) {
    for (let r = bowRadius - strokeW; r <= bowRadius; r++) {
      const px = Math.round(bowStartX + r * Math.cos(angle));
      const py = Math.round(bowCY + r * Math.sin(angle));
      if (px >= 0 && px < size && py >= 0 && py < size) {
        const idx = (py * size + px) * 3;
        pixels[idx]   = circR;
        pixels[idx+1] = circG;
        pixels[idx+2] = circB;
      }
    }
  }

  // Top and mid horizontal bars of P
  for (let bar = 0; bar < 2; bar++) {
    const barY = bar === 0 ? startY : startY + bowHeight - strokeW;
    for (let sw = 0; sw < strokeW; sw++) {
      for (let bx = startX; bx < startX + letterWidth; bx++) {
        const by = barY + sw;
        if (bx >= 0 && bx < size && by >= 0 && by < size) {
          const idx = (by * size + bx) * 3;
          pixels[idx]   = circR;
          pixels[idx+1] = circG;
          pixels[idx+2] = circB;
        }
      }
    }
  }

  return pixels;
}

const outDir = path.join(__dirname, 'icons');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

for (const size of [192, 512]) {
  const pixels = generateIconPixels(size);
  const outPath = path.join(outDir, `icon-${size}.png`);
  writePNG(size, size, pixels, outPath);
  console.log(`Generated ${outPath}`);
}

console.log('Done.');
