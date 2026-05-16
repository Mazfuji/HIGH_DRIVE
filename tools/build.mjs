import fs from "node:fs";
import path from "node:path";
import ts from "../../AY-3-8910/node_modules/typescript/lib/typescript.js";
import zlib from "node:zlib";

const root = process.cwd();
const srcDir = path.join(root, "src");
const publicDir = path.join(root, "public");
const aySourcePath = path.join(srcDir, "ay38910.ts");
const mainSourcePath = path.join(srcDir, "main.ts");

fs.mkdirSync(publicDir, { recursive: true });

const aySource = fs
  .readFileSync(aySourcePath, "utf8")
  .replace(/^export\s+/gm, "");

const mainSource = fs
  .readFileSync(mainSourcePath, "utf8")
  .replace(/^import\s+\{[^}]+\}\s+from\s+["']\.\/ay38910["'];\n/, "");

const bundledSource = `${aySource}\n\n${mainSource}`;
const result = ts.transpileModule(bundledSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ES2020,
    strict: true,
    sourceMap: true,
  },
  fileName: "main.ts",
});

fs.writeFileSync(path.join(publicDir, "main.js"), result.outputText);
fs.writeFileSync(path.join(publicDir, "main.js.map"), result.sourceMapText ?? "");
fs.copyFileSync(path.join(srcDir, "index.html"), path.join(publicDir, "index.html"));
fs.copyFileSync(path.join(srcDir, "style.css"), path.join(publicDir, "style.css"));
fs.copyFileSync(path.join(srcDir, "manifest.webmanifest"), path.join(publicDir, "manifest.webmanifest"));
fs.copyFileSync(path.join(srcDir, "sw.js"), path.join(publicDir, "sw.js"));
fs.mkdirSync(path.join(publicDir, "icons"), { recursive: true });
fs.copyFileSync(path.join(srcDir, "icons", "icon.svg"), path.join(publicDir, "icons", "icon.svg"));
fs.writeFileSync(path.join(publicDir, "icons", "icon-192.png"), createIconPng(192));
fs.writeFileSync(path.join(publicDir, "icons", "icon-512.png"), createIconPng(512));

function createIconPng(size) {
  const data = Buffer.alloc(size * size * 4);
  const scale = size / 512;

  fillRect(data, size, 0, 0, size, size, "#050807");
  fillRect(data, size, 64 * scale, 32 * scale, 384 * scale, 448 * scale, "#202226");
  fillRect(data, size, 96 * scale, 64 * scale, 320 * scale, 384 * scale, "#050807");
  fillRect(data, size, 96 * scale, 64 * scale, 12 * scale, 384 * scale, "#78ff70");
  fillRect(data, size, 404 * scale, 64 * scale, 12 * scale, 384 * scale, "#78ff70");
  fillRect(data, size, 96 * scale, 64 * scale, 320 * scale, 12 * scale, "#78ff70");
  fillRect(data, size, 96 * scale, 436 * scale, 320 * scale, 12 * scale, "#78ff70");
  fillRect(data, size, 176 * scale, 64 * scale, 20 * scale, 384 * scale, "#f2f2f2");
  fillRect(data, size, 316 * scale, 64 * scale, 20 * scale, 384 * scale, "#f2f2f2");
  fillRect(data, size, 208 * scale, 64 * scale, 96 * scale, 384 * scale, "#050807");
  fillRect(data, size, 247 * scale, 104 * scale, 18 * scale, 48 * scale, "#ffd95c");
  fillRect(data, size, 247 * scale, 200 * scale, 18 * scale, 48 * scale, "#ffd95c");
  fillRect(data, size, 247 * scale, 296 * scale, 18 * scale, 48 * scale, "#ffd95c");
  fillRect(data, size, 176 * scale, 352 * scale, 160 * scale, 56 * scale, "#78ff70");
  fillRect(data, size, 204 * scale, 276 * scale, 104 * scale, 76 * scale, "#58e7ff");
  fillRect(data, size, 184 * scale, 352 * scale, 144 * scale, 12 * scale, "#050807");
  fillRect(data, size, 204 * scale, 276 * scale, 104 * scale, 12 * scale, "#050807");

  const scanlines = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const sourceStart = y * size * 4;
    const targetStart = y * (size * 4 + 1);
    data.copy(scanlines, targetStart + 1, sourceStart, sourceStart + size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.concat([
      uint32(size),
      uint32(size),
      Buffer.from([8, 6, 0, 0, 0])
    ])),
    pngChunk("IDAT", zlib.deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function fillRect(data, size, x, y, width, height, color) {
  const [red, green, blue] = parseHexColor(color);
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(size, Math.round(x + width));
  const y1 = Math.min(size, Math.round(y + height));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const index = (yy * size + xx) * 4;
      data[index] = red;
      data[index + 1] = green;
      data[index + 2] = blue;
      data[index + 3] = 255;
    }
  }
}

function parseHexColor(color) {
  const value = Number.parseInt(color.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  return Buffer.concat([
    uint32(data.length),
    typeBuffer,
    data,
    uint32(crc32(Buffer.concat([typeBuffer, data])))
  ]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
