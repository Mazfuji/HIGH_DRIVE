import fs from "node:fs";
import path from "node:path";
import ts from "../../AY-3-8910/node_modules/typescript/lib/typescript.js";

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
