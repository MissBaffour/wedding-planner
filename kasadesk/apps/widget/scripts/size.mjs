import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const buf = readFileSync(new URL('../dist/widget.js', import.meta.url));
const gz = gzipSync(buf).length;
const nonAscii = buf.findIndex((b) => b > 0x7f);
if (nonAscii >= 0) { console.error(`widget.js contains non-ASCII bytes at offset ${nonAscii}; it would break on pages served without charset`); process.exit(1); }
console.log(`widget.js: ${(buf.length / 1024).toFixed(1)} KB, ${(gz / 1024).toFixed(1)} KB gzipped`);
if (gz > 20 * 1024) { console.error('widget exceeds the 20 KB gzip budget'); process.exit(1); }
