import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { createHash } from "node:crypto";
import { LIMITS, validateShow, validateReading } from "./show-validation.mjs";
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export function encodeShow({ state, pdf, reading }) {
  validateShow(state);
  validateReading(reading, state);
  if (pdf.length > LIMITS.pdfBytes || sha256(pdf) !== state.document.version)
    throw new Error("The script does not match this show.");
  const files = {
    "show.json": strToU8(JSON.stringify(state)),
    "script.pdf": new Uint8Array(pdf),
    "reading.json": strToU8(JSON.stringify(reading)),
  };
  const caps = {
    "show.json": LIMITS.stateBytes,
    "script.pdf": LIMITS.pdfBytes,
    "reading.json": LIMITS.readingBytes,
  };
  for (const [name, bytes] of Object.entries(files))
    if (bytes.length > caps[name])
      throw new Error(
        `The show is too large to save: ${name} exceeds its size limit.`,
      );
  if (
    Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0) >
    LIMITS.archiveBytes
  )
    throw new Error("The show exceeds the combined 160 MB limit.");
  const manifest = {
    format: "lighting-design-show",
    version: 1,
    files: Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [
        name,
        { bytes: bytes.length, sha256: sha256(bytes) },
      ]),
    ),
  };
  return zipSync(
    { ...files, "manifest.json": strToU8(JSON.stringify(manifest)) },
    { level: 1 },
  );
}
export function decodeShow(bytes) {
  if (bytes.length > LIMITS.archiveBytes)
    throw new Error("This show file exceeds the 160 MB limit.");
  const caps = {
    "manifest.json": 4096,
    "show.json": LIMITS.stateBytes,
    "script.pdf": LIMITS.pdfBytes,
    "reading.json": LIMITS.readingBytes,
  };
  const entries = new Set();
  let total = 0;
  const files = unzipSync(new Uint8Array(bytes), {
    filter: (entry) => {
      if (
        !(entry.name in caps) ||
        entries.has(entry.name) ||
        entry.originalSize > caps[entry.name]
      )
        throw new Error("Invalid or oversized show archive entry.");
      entries.add(entry.name);
      total += entry.originalSize;
      if (total > LIMITS.archiveBytes)
        throw new Error("The expanded show file is too large.");
      return true;
    },
  });
  if (entries.size !== 4) throw new Error("The show archive is incomplete.");
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  if (manifest.format !== "lighting-design-show" || manifest.version !== 1)
    throw new Error(
      "Unsupported show file version. Open this file with the version of Lighting Design Desktop that created it.",
    );
  for (const name of ["show.json", "script.pdf", "reading.json"])
    if (
      manifest.files?.[name]?.bytes !== files[name].length ||
      manifest.files?.[name]?.sha256 !== sha256(files[name])
    )
      throw new Error(
        `The show file is damaged: ${name} failed its integrity check.`,
      );
  const state = validateShow(JSON.parse(strFromU8(files["show.json"])));
  const pdf = files["script.pdf"];
  if (
    strFromU8(pdf.slice(0, 5)) !== "%PDF-" ||
    sha256(pdf) !== state.document.version
  )
    throw new Error("The script PDF is damaged or belongs to another show.");
  const reading = validateReading(
    JSON.parse(strFromU8(files["reading.json"])),
    state,
  );
  return { state, pdf, reading };
}
