import { pdfSettings } from "./pdf-settings";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { getDocument, GlobalWorkerOptions, Util, OPS } from "pdfjs-dist";
import { createWorker } from "tesseract.js";
import type {
  FormattedDocument,
  Box,
} from "./formatted-script";
import type { Scene } from "./types";
import { assemblePage, type TextPiece } from "./script-layout";
import { ScriptImageStyle } from "./script-image-style";

GlobalWorkerOptions.workerSrc = "app://desktop/pdf.worker.min.mjs";
export type ImportProgress = { page: number; total: number; phase: string };
export type ImportResult = {
  reading: FormattedDocument;
  scenes: Scene[];
  ocrPages: number[];
  warnings: string[];
};
const uid = () => crypto.randomUUID();
export function suggestScenes(reading: FormattedDocument): Scene[] {
  const label=(line:{text:string})=>line.text.replace(/\s+/g," ").trim();
  const sceneHeading =
    /^(?:ACT\s+(?:[IVXLCDM]+|\d+)[.\s:]+)?SCENE\s+(?:[IVXLCDM]+|\d+)(?:[.\s:]|$)/i;
  const actHeading =
    /^(?:ACT\s+(?:[IVXLCDM]+|\d+)|(?:FIRST|SECOND|THIRD|FOURTH|FIFTH) ACT)(?:[.\s:]|$)/i;
  const contentsPages = new Set(
    reading.lines
      .filter((line) =>
        /^(?:(?:table of )?contents|(?:the )?scenes of the play)\s*$/i.test(
          label(line),
        ),
      )
      .map((line) => line.pdfPage),
  );
  const candidates = reading.lines.filter(
    (line) =>
      !contentsPages.has(line.pdfPage) &&
      line.text.length < 160 &&
      (sceneHeading.test(label(line)) ||
        actHeading.test(label(line)) ||
        /^(?:prologue|epilogue)\s*[.:]?$/i.test(label(line))),
  );
  const hasScenes = candidates.some((line) =>
    sceneHeading.test(label(line)),
  );
  let act = "";
  const scenes: Scene[] = [];
  for (const line of candidates) {
    const isAct = actHeading.test(label(line));
    const isScene = sceneHeading.test(label(line));
    if (isAct) {
      act = isScene
        ? line.text
            .trim()
            .split(/\bSCENE\b/i)[0]
            .trim()
            .replace(/[.:]$/, "")
        : label(line);
      if (hasScenes && !isScene) continue;
    }
    scenes.push({
      id: uid(), ownerId: null,
      number: String(scenes.length + 1),
      name:
        hasScenes && act && !isAct
          ? `${act} · ${label(line)}`
          : label(line),
      pageStart: line.pdfPage,
      startY: Math.max(
        0,
        Math.min(0.999, line.bbox[1] / reading.pages[line.pdfPage - 1].height),
      ),
      pageEnd: reading.pages.length,
    });
  }
  if (!scenes.length)
    scenes.push({
      id: uid(), ownerId: null,
      number: "1",
      name: "Full script",
      pageStart: 1,
      startY: 0,
      pageEnd: reading.pages.length,
    });
  return normalizeSceneEnds(scenes, reading.pages.length);
}
export function normalizeSceneEnds(scenes: Scene[], pages: number): Scene[] {
  return [...scenes]
    .sort((a, b) => a.pageStart - b.pageStart || a.startY - b.startY)
    .map((scene, index, all) => ({
      ...scene,
      pageEnd: all[index + 1]?.pageStart ?? pages,
    }));
}
export async function importScript(
  bytes: Uint8Array,
  onProgress: (progress: ImportProgress) => void,
  signal: AbortSignal,
  forceOCR = false,
): Promise<ImportResult> {
  const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  const sourceSha256 = [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const task = getDocument({ ...pdfSettings, data: Uint8Array.from(bytes) });
  let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
  const abort = () => {
    void task.destroy();
    if (worker) void worker.terminate();
  };
  signal.addEventListener("abort", abort, { once: true });
  const check = () => {
    if (signal.aborted)
      throw new DOMException("Import cancelled", "AbortError");
  };
  const reading: FormattedDocument = {
    sourceSha256,
    pages: [],
    lines: [],
    items: [],
  };
  const ocrPages: number[] = [],
    warnings: string[] = [];
  try {
    check();
    const pdf = await task.promise;
    if (pdf.numPages > 1500)
      throw new Error("Choose a PDF with at most 1,500 pages.");
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      check();
      onProgress({
        page: pageNumber,
        total: pdf.numPages,
        phase: "Reading text",
      });
      const page = await pdf.getPage(pageNumber),
        viewport = page.getViewport({ scale: 1 });
      if (viewport.width > 20000 || viewport.height > 20000)
        throw new Error(`Page ${pageNumber} is too large to import.`);
      reading.pages.push({
        pdfPage: pageNumber,
        scriptPage: pageNumber,
        width: viewport.width,
        height: viewport.height,
      });
      const content = await page.getTextContent();
      const items = content.items.filter(
        (item): item is TextItem => "str" in item && item.str.trim().length > 0,
      );
      const scale = Math.min(3, 3200 / Math.max(viewport.width, viewport.height));
      const canvas = document.createElement("canvas");
      const renderViewport = page.getViewport({ scale });
      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      await page.render({ canvas, viewport: renderViewport }).promise;
      check();
      let imageStyle = new ScriptImageStyle(canvas, scale);
      const pieces: TextPiece[] = [];
      const text = items.map(item => item.str).join("");
      const operators=await page.getOperatorList();
      const hasImage=operators.fnArray.some(op=>op===OPS.paintImageXObject || op===OPS.paintInlineImageXObject || op===OPS.paintInlineImageXObjectGroup);
      const hiddenText=operators.fnArray.some((op,index)=>op===OPS.setTextRenderingMode && operators.argsArray[index][0]===3);
      const staleOcr=hasImage && (hiddenText || items.some(item=>/glyphless|ocr/i.test(page.commonObjs.get(item.fontName)?.name??'')));
      if (!forceOCR && !staleOcr && text.replace(/\s/g, "").length >= 3 &&
          (text.match(/\ufffd/g)?.length ?? 0) < text.length * .1) {
        const measure = document.createElement("canvas").getContext("2d")!;
        for (const item of items) {
          // Rendering resolves the converted font objects, not just their IDs.
          const font = page.commonObjs.get(item.fontName);
          const tx = Util.transform(viewport.transform, item.transform);
          const size = Math.hypot(tx[2], tx[3]) || item.height || 12;
          const ascent = font.ascent || content.styles[item.fontName]?.ascent || .8;
          const descent = font.descent || content.styles[item.fontName]?.descent || -.2;
          const x = tx[4], baseline = tx[5];
          const box: Box = [x, baseline-size*ascent, x+item.width, baseline-size*descent];
          const family = font.fallbackName === 'monospace' ? 'monospace' : /sans/i.test(content.styles[item.fontName]?.fontFamily ?? '') ? 'sans-serif' : 'serif';
          measure.font = `${size}px "${font.loadedName}"`;
          const totalWidth = measure.measureText(item.str).width || 1;
          const words = [...item.str.matchAll(/\S+/g)].map(match => ({
            start: match.index!, end: match.index!+match[0].length,
            bbox: [x+item.width*measure.measureText(item.str.slice(0,match.index!)).width/totalWidth, box[1], x+item.width*measure.measureText(item.str.slice(0,match.index!+match[0].length)).width/totalWidth, box[3]] as Box,
          }));
          // Split at word boundaries so coloured highlights can cover part of a line.
          for (const word of words) {
            pieces.push({ text:item.str.slice(word.start,word.end), box:word.bbox, size, baseline,spaceBefore:word.start>0&&/\s$/.test(item.str.slice(0,word.start)),
              run:{style:'normal',bold:font.bold||font.black||/bold|black|heavy|semibold/i.test(font.name??'')||undefined,italic:font.italic||/italic|oblique|slant/i.test(font.name??'')||undefined,fontFamily:family,...imageStyle.sample(word.bbox)},
              words:[{start:0,end:word.end-word.start,bbox:word.bbox}],
            });
          }
        }
        // Highlight annotations are separate from the PDF's painted text.
        for (const annotation of await page.getAnnotations()) {
          if (annotation.subtype !== 'Highlight') continue;
          const quads: number[] = annotation.quadPoints ? Array.from(annotation.quadPoints) : [];
          const boxes: Box[] = [];
          for(let i=0;i<quads.length;i+=8) {
            const points = Array.from({length:4},(_,n)=>viewport.convertToViewportPoint(quads[i+n*2],quads[i+n*2+1]));
            boxes.push([Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))]);
          }
          if(!boxes.length && annotation.rect) boxes.push([...viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]), ...viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3])] as Box);
          const color = annotation.color ? '#'+Array.from(annotation.color as Uint8Array).map(v=>v.toString(16).padStart(2,'0')).join('') : '#ffff00';
          for(const piece of pieces) if(boxes.some(box=>piece.box[0]<Math.max(box[0],box[2]) && piece.box[2]>Math.min(box[0],box[2]) && (piece.box[1]+piece.box[3])/2>Math.min(box[1],box[3]) && (piece.box[1]+piece.box[3])/2<Math.max(box[1],box[3]))) piece.run.highlight=color;
        }
      } else {
        onProgress({page:pageNumber,total:pdf.numPages,phase:"Recognising scanned text"});
        reading.pages.at(-1)!.ocr = true;
        worker ??= await createWorker("eng", 1, {
          workerPath: "app://desktop/ocr/worker.min.js", corePath: "app://desktop/ocr/core", langPath: "app://desktop/ocr", gzip: true,
        });
        check();
        // Recognise a neutral image so coloured highlighter bands do not
        // cause Tesseract to discard whole dialogue lines as illustrations.
        const ocrCanvas=document.createElement('canvas');ocrCanvas.width=canvas.width;ocrCanvas.height=canvas.height;
        const ocrContext=ocrCanvas.getContext('2d',{willReadFrequently:true})!;
        ocrContext.drawImage(canvas,0,0);
        const neutral=ocrContext.getImageData(0,0,ocrCanvas.width,ocrCanvas.height);
        let coloredBackground=0;
        for(let i=0;i<neutral.data.length;i+=4){
          const gray=.2126*neutral.data[i]+.7152*neutral.data[i+1]+.0722*neutral.data[i+2];
          if(gray>130 && Math.max(neutral.data[i],neutral.data[i+1],neutral.data[i+2])-Math.min(neutral.data[i],neutral.data[i+1],neutral.data[i+2])>45)coloredBackground++;
          const value=gray<180?gray:255;
          neutral.data[i]=neutral.data[i+1]=neutral.data[i+2]=value;
        }
        if(coloredBackground>neutral.data.length/4*.001) ocrContext.putImageData(neutral,0,0);
        const { data } = await worker.recognize(ocrCanvas, {rotateAuto:true}, {blocks:true, imageColor:true});
        ocrCanvas.width=ocrCanvas.height=1;
        check();
        ocrPages.push(pageNumber);
        const angle = data.rotateRadians || 0;
        let aligned = canvas;
        if (Math.abs(angle) > .001 && data.imageColor) {
          const image = new Image(); image.src=data.imageColor; await image.decode();
          aligned=document.createElement('canvas'); aligned.width=image.naturalWidth;aligned.height=image.naturalHeight;
          const context=aligned.getContext('2d')!;context.fillStyle='white';context.fillRect(0,0,aligned.width,aligned.height);context.translate(aligned.width/2,aligned.height/2);context.rotate(angle);context.drawImage(canvas,-canvas.width/2,-canvas.height/2);
          imageStyle=new ScriptImageStyle(aligned,scale);
        }
        const originalBox = (box:Box):Box => {
          const points = [[box[0],box[1]],[box[2],box[1]],[box[0],box[3]],[box[2],box[3]]].map(([x,y])=>{
            x-=aligned.width/2; y-=aligned.height/2;
            return [(x*Math.cos(angle)+y*Math.sin(angle)+canvas.width/2)/scale,(-x*Math.sin(angle)+y*Math.cos(angle)+canvas.height/2)/scale];
          });
          return [Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
        };
        let uncertain=0, recognised=0;
        for (const block of data.blocks ?? []) for (const paragraph of block.paragraphs) for (const line of paragraph.lines) {
          const size = (line.rowAttributes?.rowHeight || line.bbox.y1-line.bbox.y0)*1.3/scale;
          for (const word of line.words) {
            if(!word.text.trim())continue;
            const border=word.bbox.x0<canvas.width*.035 || word.bbox.x1>canvas.width*.965 || word.bbox.y0<canvas.height*.025 || word.bbox.y1>canvas.height*.975;
            if(border && word.confidence<65 && word.text.length<3)continue;
            recognised++; if(word.confidence<65)uncertain++;
            const rawBox:Box=[word.bbox.x0,word.bbox.y0,word.bbox.x1,word.bbox.y1];
            const box=originalBox(rawBox), sample=rawBox.map(v=>v/scale) as Box;
            pieces.push({text:word.text,box,size,baseline:(line.bbox.y1/scale),run:{style:'normal',...imageStyle.recognise(word.text,sample),...(!border || word.text.length>2?imageStyle.sample(sample):{})},words:[{start:0,end:word.text.length,bbox:box}]});
          }
        }
        if(aligned!==canvas)aligned.width=aligned.height=1;
        if (data.confidence<75 || uncertain>recognised*.15) warnings.push(`Page ${pageNumber}: check the recognised text (${Math.round(data.confidence)}% OCR confidence).`);
      }
      canvas.width=canvas.height=1;
      const extracted=assemblePage(pageNumber,pieces,viewport.width);
      if(!extracted.lines.length) warnings.push(`Page ${pageNumber}: no readable text was found. Check whether the page is blank or the scan needs replacing.`);
      reading.lines.push(...extracted.lines);
      reading.items.push(...extracted.items);
      page.cleanup();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if(!reading.lines.length) throw new Error("No readable text was found. Try a clearer scan.");
    return { reading, scenes: suggestScenes(reading), ocrPages, warnings };
  } catch (error) {
    if (signal.aborted)
      throw new DOMException("Import cancelled", "AbortError");
    if (error instanceof Error && error.name === "PasswordException")
      throw new Error(
        "This PDF needs a password. Export an unlocked copy and import that file.",
      );
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    if (worker) await worker.terminate().catch(() => {});
    await task.destroy().catch(() => {});
  }
}
