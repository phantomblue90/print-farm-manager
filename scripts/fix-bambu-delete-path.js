const fs = require('fs');

const path = 'server/drivers/bambu.js';
let source = fs.readFileSync(path, 'utf8');
const before = [
  "  // X1/P1/A1 pre-sliced .gcode.3mf files live in /cache; H2/project",
  "  // containers remain at the SD-card root.",
  "  const remotePath = !isH2Family(printer) && filename.toLowerCase().endsWith('.gcode.3mf')",
  "    ? `cache/${filename}`",
  "    : filename;",
].join('\n');
const after = [
  "  // All 3MF project containers are uploaded to the SD-card root.",
  "  const remotePath = filename;",
].join('\n');
if (!source.includes(before)) throw new Error('Expected stale cache cleanup block not found');
source = source.replace(before, after);
fs.writeFileSync(path, source);
console.log('Corrected Bambu cleanup path.');
