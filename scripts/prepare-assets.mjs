import { mkdir, copyFile, readdir, cp } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
await mkdir("public/ocr/core", { recursive: true });
await copyFile(
  require.resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
  "public/pdf.worker.min.mjs",
);
await copyFile(
  require.resolve("tesseract.js/dist/worker.min.js"),
  "public/ocr/worker.min.js",
);
const core = path.dirname(
  createRequire(require.resolve("tesseract.js/package.json")).resolve(
    "tesseract.js-core/package.json",
  ),
);
for (const file of await readdir(core))
  if (/^tesseract-core.*\.(wasm|js)$/.test(file))
    await copyFile(path.join(core, file), path.join("public/ocr/core", file));

const pdfRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
for (const folder of ["cmaps", "standard_fonts", "wasm"])
  await cp(path.join(pdfRoot, folder), path.join("public/pdfjs", folder), {
    recursive: true,
  });
