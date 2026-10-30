import * as pdfjs from "pdfjs-dist";
import { pdfSettings } from "./pdf-settings";
import { retainedResource } from "./retained-resource";

// View changes reuse the worker, parsed document and PDF.js page/operator cache.
// The single fixed script is released after a minute outside Script view.
export const acquireScriptDocument = retainedResource(async () => {
  pdfjs.GlobalWorkerOptions.workerSrc = typeof window !== "undefined" && window.desktop ? "app://desktop/pdf.worker.min.mjs" : "/pdf.worker.min.mjs";
  const source = typeof window !== "undefined" && window.desktop
    ? { data: new Uint8Array(await (await fetch("/api/script")).arrayBuffer()) }
    : { url: "/api/script", withCredentials: true };
  const task = pdfjs.getDocument({ ...pdfSettings, ...source });
  try { return { pdfjs, pdf: await task.promise, task }; }
  catch (error) { void task.destroy().catch(() => {}); throw error; }
}, ({ task }) => { void task.destroy().catch(() => {}); }, 60_000);
