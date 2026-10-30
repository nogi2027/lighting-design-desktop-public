import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const root = process.cwd(),
  seen = new Set(),
  inventory = [];
await fs.mkdir("notices/licenses", { recursive: true });
async function visit(name, from) {
  const require = createRequire(from);
  let location;
  try {
    location = require.resolve(`${name}/package.json`);
  } catch {
    let candidate = path.dirname(require.resolve(name));
    while (candidate !== path.dirname(candidate)) {
      try {
        const pkg = JSON.parse(
          await fs.readFile(path.join(candidate, "package.json"), "utf8"),
        );
        if (pkg.name === name) {
          location = path.join(candidate, "package.json");
          break;
        }
      } catch {
        /* Continue toward package root. */
      }
      candidate = path.dirname(candidate);
    }
  }
  if (!location) throw new Error(`Cannot locate ${name}'s license metadata.`);
  const pkg = JSON.parse(await fs.readFile(location, "utf8")),
    key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) return;
  seen.add(key);
  const directory = path.dirname(location),
    texts = [];
  for (const file of await fs.readdir(directory))
    if (/^(licen[cs]e|copying|notice)([.-]|$)/i.test(file)) {
      const source = path.join(directory, file);
      if (!(await fs.stat(source)).isFile()) continue;
      const target = `${pkg.name.replace(/[/@]/g, "_")}-${pkg.version}-${file}`;
      await fs.copyFile(source, path.join(root, "notices/licenses", target));
      texts.push(`licenses/${target}`);
    }
  if (!texts.length && pkg.name.startsWith("@napi-rs/canvas-")) {
    const parent = createRequire(
      createRequire(path.join(root, "package.json")).resolve(
        "pdfjs-dist/package.json",
      ),
    ).resolve("@napi-rs/canvas/package.json");
    const target = `${pkg.name.replace(/[/@]/g, "_")}-${pkg.version}-LICENSE`;
    await fs.copyFile(
      path.join(path.dirname(parent), "LICENSE"),
      path.join(root, "notices/licenses", target),
    );
    texts.push(`licenses/${target}`);
  }
  if (!texts.length) {
    const fallback = path.join(
      root,
      "notices/overrides",
      pkg.name,
      "LICENSE.md",
    );
    try {
      await fs.access(fallback);
      const target = `${pkg.name.replace(/[/@]/g, "_")}-${pkg.version}-LICENSE.md`;
      await fs.copyFile(fallback, path.join(root, "notices/licenses", target));
      texts.push(`licenses/${target}`);
    } catch {
      /* Report missing notices below. */
    }
  }
  inventory.push({
    name: pkg.name,
    version: pkg.version,
    license:
      typeof pkg.license === "string"
        ? pkg.license
        : (pkg.license?.type ?? "UNDECLARED"),
    repository:
      typeof pkg.repository === "string"
        ? pkg.repository
        : (pkg.repository?.url ?? null),
    texts,
  });
  for (const child of Object.keys(pkg.dependencies ?? {}))
    await visit(child, location);
  for (const child of Object.keys(pkg.optionalDependencies ?? {}))
    try {
      await visit(child, location);
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
}
const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
for (const name of Object.keys(pkg.dependencies))
  await visit(name, path.join(root, "package.json"));
inventory.sort((a, b) => a.name.localeCompare(b.name));
await fs.writeFile(
  "notices/dependencies.json",
  JSON.stringify(inventory, null, 2) + "\n",
);
const missing = inventory.filter(
  (item) => item.license === "UNDECLARED" || !item.texts.length,
);
console.log(
  JSON.stringify(
    {
      packages: inventory.length,
      licenses: [...new Set(inventory.map((i) => i.license))],
      missing,
    },
    null,
    2,
  ),
);
if (missing.length) process.exitCode = 1;
