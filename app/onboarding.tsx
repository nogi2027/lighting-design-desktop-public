import { pdfSettings } from "../lib/pdf-settings";
import { useEffect, useRef, useState } from "react";
import { getDocument, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import { normalizeSceneEnds, type ImportResult } from "../lib/import-script";
import type { Scene } from "../lib/types";
import type { ImportSource, DesktopState as WorkspaceState } from "../desktop/show-model";
import type { FormattedDocument } from "../lib/formatted-script";

function ScriptPage({ pdf, page, width, height, scenes, selected, onPlace }: {
  pdf: PDFDocumentProxy | null;
  page: number;
  width: number;
  height: number;
  scenes: Scene[];
  selected: string;
  onPlace: (page: number, y: number) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = button.current!;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: element.closest(".setup-preview"),
      rootMargin: "600px 0px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!pdf || !visible || !canvas.current) return;
    let cancelled = false;
    let render: RenderTask | undefined;
    const surface = canvas.current;
    void pdf.getPage(page).then(async sheet => {
      if (cancelled) return;
      const viewport = sheet.getViewport({ scale: Math.min(1500 / width, 2) });
      surface.width = viewport.width;
      surface.height = viewport.height;
      render = sheet.render({ canvas: surface, viewport });
      await render.promise;
    }).catch(error => {
      if (!cancelled) setError(error.message);
    });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [pdf, page, width, visible]);
  const active = scenes.find(scene => scene.id === selected);
  return (
    <div className="setup-script-page">
      <span className="setup-page-label">PDF page {page}</span>
      <button
        ref={button}
        className="preview-page"
        aria-label={`Place selected scene on PDF page ${page}`}
        aria-describedby="scene-placement-help"
        style={{ aspectRatio: `${width} / ${height}` }}
        onClick={event => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const y = event.detail === 0 ? active?.startY ?? 0 : (event.clientY - bounds.top) / bounds.height;
          onPlace(page, Math.round(Math.min(0.999, Math.max(0, y)) * 10000) / 10000);
        }}
      >
        {visible && <canvas ref={canvas} aria-hidden="true" />}
        {scenes.filter(scene => scene.pageStart === page).map(scene => (
          <span
            className={`preview-boundary ${scene.id === selected ? "selected" : ""}`}
            key={scene.id}
            data-scene-id={scene.id}
            style={{ top: `${scene.startY * 100}%` }}
          >
            <span>{scene.name}</span>
          </span>
        ))}
        {error && <span className="preview-error">Could not display page {page}: {error}</span>}
      </button>
    </div>
  );
}

export function Onboarding({
  source,
  result,
  onCancel,
  onFinish,
}: {
  source: ImportSource;
  result: ImportResult;
  onCancel: () => void;
  onFinish: (
    state: WorkspaceState,
    reading: FormattedDocument,
  ) => Promise<void>;
}) {
  const [title, setTitle] = useState(
    source.title ?? source.filename.replace(/\.pdf$/i, ""),
  );
  const [scenes, setScenes] = useState(result.scenes);
  const [selected, setSelected] = useState(scenes[0].id);
  const [firstPage, setFirstPage] = useState(scenes[0].pageStart);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [unplaced, setUnplaced] = useState<string[]>([]);
  const titles = useRef(new Map<string, HTMLInputElement>());
  const total = result.reading.pages.length;
  useEffect(() => {
    let cancelled = false;
    const task = getDocument({
      ...pdfSettings,
      data: Uint8Array.from(source.bytes),
    });
    void task.promise.then(document => {
      if (!cancelled) setPdf(document);
    }).catch(error => {
      if (!cancelled) setError(error.message);
    });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [source]);
  function change(id: string, patch: Partial<Scene>) {
    setScenes((current) =>
      current.map((scene) =>
        scene.id === id ? { ...scene, ...patch } : scene,
      ),
    );
  }
  async function finish() {
    setError("");
    if (!title.trim()) {
      setError("Name the show before continuing.");
      return;
    }
    if (!scenes.length) {
      setError("Add at least one scene.");
      return;
    }
    if (unplaced.length) {
      const scene = scenes.find(scene => unplaced.includes(scene.id))!;
      setSelected(scene.id);
      setError(`Click the script to place “${scene.name}” before continuing.`);
      return;
    }
    const ordered = normalizeSceneEnds(scenes, total).map((scene, index) => ({
      ...scene, number: String(index + 1), name: scene.name.trim(),
    }));
    if (
      ordered.some(
        (scene, index) =>
          !scene.name.trim() ||
          !Number.isInteger(scene.pageStart) ||
          scene.pageStart < 1 ||
          scene.pageStart > total ||
          scene.startY < 0 ||
          scene.startY >= 1 ||
          (index > 0 &&
            scene.pageStart === ordered[index - 1].pageStart &&
            scene.startY === ordered[index - 1].startY),
      )
    ) {
      setError(
        "Give each scene a name and a unique start position within the script.",
      );
      return;
    }
    setBusy(true);
    try {
      const state: WorkspaceState = {
        schemaVersion: 12,
        profiles: [], history: [], inboxReads: [], inboxPins: [],
        id: crypto.randomUUID(),
        title: title.trim(),
        document: {
          id: crypto.randomUUID(),
          filename: source.filename,
          version: result.reading.sourceSha256,
          pages: total,
          firstPage,
        },
        scenes: ordered,
        cues: [],
        discussions: [],
        deletedCues: [],
      };
      await onFinish(state, result.reading);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="onboarding">
      <header>
        <div>
          <span className="eyebrow">NEW SHOW</span>
          <h1>Set up your script</h1>
          <p>
            {source.filename} · {total} pages · {result.ocrPages.length} pages
            read with OCR
          </p>
        </div>
        <button onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </header>
      <div className="setup-grid">
        <section className="scene-setup">
          <label>
            Show name
            <input
              value={title}
              maxLength={300}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            PDF page where script numbering starts
            <input
              type="number"
              min={1}
              max={total}
              value={firstPage}
              onChange={(event) =>
                setFirstPage(
                  Math.max(1, Math.min(total, Number(event.target.value))),
                )
              }
            />
          </label>
          <div className="section-heading">
            <h2>Scenes</h2>
            <button
              className="add-scene-button"
              aria-label="Add scene"
              title="Add scene"
              disabled={busy}
              onClick={() => {
                const scene: Scene = {
                  id: crypto.randomUUID(), ownerId: null,
                  number: String(scenes.length + 1), name: "New scene",
                  pageStart: 1, startY: 0, pageEnd: total,
                };
                setScenes(current => [...current, scene]);
                setUnplaced(current => [...current, scene.id]);
                setSelected(scene.id);
                setError("");
                requestAnimationFrame(() => {
                  titles.current.get(scene.id)?.focus();
                  titles.current.get(scene.id)?.select();
                });
              }}
            >
              +
            </button>
          </div>
          <p className="muted" id="scene-placement-help">
            Select a title, then click the script to place its divider.
          </p>
          <div className="scene-setup-list" aria-label="Scenes">
            {[...scenes].sort((a, b) =>
              Number(unplaced.includes(a.id)) - Number(unplaced.includes(b.id)) ||
              a.pageStart - b.pageStart || a.startY - b.startY
            ).map(scene => (
              <div key={scene.id} className={`scene-title-row ${selected === scene.id ? "selected" : ""}`}>
                <input
                  ref={element => {
                    if (element) titles.current.set(scene.id, element);
                    else titles.current.delete(scene.id);
                  }}
                  aria-label="Scene title"
                  aria-describedby={selected === scene.id ? "scene-placement-status" : undefined}
                  value={scene.name}
                  maxLength={300}
                  disabled={busy}
                  onFocus={() => setSelected(scene.id)}
                  onClick={() => setSelected(scene.id)}
                  onChange={event => change(scene.id, { name: event.target.value })}
                />
                <button
                  aria-label={`Remove ${scene.name}`}
                  disabled={busy || scenes.length === 1}
                  onClick={() => {
                    setScenes(current => current.filter(item => item.id !== scene.id));
                    setUnplaced(current => current.filter(id => id !== scene.id));
                    if (selected === scene.id) setSelected(scenes.find(item => item.id !== scene.id)!.id);
                    setError("");
                  }}
                >×</button>
              </div>
            ))}
          </div>
          {result.warnings.length > 0 && (
            <details>
              <summary>{result.warnings.length} pages need review</summary>
              <ul>
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void finish()}
          >
            {busy ? "Creating show…" : "Create show"}
          </button>
        </section>
        <section className="script-setup" aria-label="Script dividers">
          <p id="scene-placement-status" className="scene-placement-status" role="status">
            Click the script to {unplaced.includes(selected) ? "place" : "move"} <strong>{scenes.find(scene => scene.id === selected)?.name || "this scene"}</strong>.
          </p>
          <div className="setup-preview" role="region" aria-label="Script preview">
            {result.reading.pages.map(sheet => (
              <ScriptPage
                key={sheet.pdfPage}
                pdf={pdf}
                page={sheet.pdfPage}
                width={sheet.width}
                height={sheet.height}
                scenes={scenes.filter(scene => !unplaced.includes(scene.id))}
                selected={selected}
                onPlace={(pageStart, startY) => {
                  change(selected, { pageStart, startY });
                  setUnplaced(current => current.filter(id => id !== selected));
                  setError("");
                }}
              />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
