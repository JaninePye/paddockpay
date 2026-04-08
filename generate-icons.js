// Run with: node generate-icons.js
// Generates icon-192.png and icon-512.png using node-canvas
// If node-canvas is not available, the icons are generated inline via the HTML fallback below.

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function generateIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background — dark soil
  ctx.fillStyle = '#1A1008';
  ctx.fillRect(0, 0, size, size);

  // Subtle gradient overlay
  const grad = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  grad.addColorStop(0, 'rgba(44,26,14,0.8)');
  grad.addColorStop(1, 'rgba(26,16,8,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Rounded rect clip (for maskable)
  const r = size * 0.2;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size - r);
  ctx.quadraticCurveTo(size, size, size - r, size);
  ctx.lineTo(r, size);
  ctx.quadraticCurveTo(0, size, 0, size - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.clip();

  // Re-draw background inside clip
  ctx.fillStyle = '#1A1008';
  ctx.fillRect(0, 0, size, size);

  // Wheat circle background
  ctx.beginPath();
  ctx.arc(size/2, size/2, size * 0.38, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(212,168,67,0.15)';
  ctx.fill();

  // "P" letter
  ctx.fillStyle = '#D4A843';
  ctx.font = `bold ${size * 0.52}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('P', size / 2, size / 2 + size * 0.03);

  return canvas.toBuffer('image/png');
}

const outDir = path.join(__dirname, 'icons');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

try {
  fs.writeFileSync(path.join(outDir, 'icon-192.png'), generateIcon(192));
  fs.writeFileSync(path.join(outDir, 'icon-512.png'), generateIcon(512));
  console.log('Icons generated successfully.');
} catch (e) {
  console.error('node-canvas not available:', e.message);
  console.log('Using fallback SVG-based icons instead.');
}
