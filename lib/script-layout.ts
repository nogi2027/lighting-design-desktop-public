import type { Box, SourceLine, SourceRun, ScriptNode } from './formatted-script';

export type TextPiece = { text: string; box: Box; size: number; run: Omit<SourceRun, 'start' | 'end'>; words?: SourceLine['words']; baseline?: number; spaceBefore?: boolean };
export const median = (values: number[]) => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)] || 12;
const extent = (lines: SourceLine[]): Box => [Math.min(...lines.map(l=>l.bbox[0])), Math.min(...lines.map(l=>l.bbox[1])), Math.max(...lines.map(l=>l.bbox[2])), Math.max(...lines.map(l=>l.bbox[3]))];

// Geometry, rather than speaker-name conventions, defines imported layout.
export function assemblePage(page: number, pieces: TextPiece[], width: number): { lines: SourceLine[]; items: ScriptNode[] } {
  const size = median(pieces.filter(p=>p.text.trim().length>3).map(p=>p.size));
  const rows: { baseline: number; pieces: TextPiece[] }[] = [];
  for (const piece of [...pieces].sort((a,b)=>(a.baseline??a.box[3])-(b.baseline??b.box[3]) || a.box[0]-b.box[0])) {
    const y = piece.baseline ?? piece.box[3];
    let row = rows.find(r=>Math.abs(r.baseline-y)<Math.min(size,piece.size)*.35);
    if (!row) { row={baseline:y,pieces:[]}; rows.push(row); }
    row.pieces.push(piece);
  }
  const chunks = rows.flatMap(row=>{
    const groups: TextPiece[][]=[];
    for(const piece of row.pieces.sort((a,b)=>a.box[0]-b.box[0])) {
      const last=groups.at(-1), previous=last?.at(-1);
      if(previous && piece.box[0]-previous.box[2]<size*2) last!.push(piece); else groups.push([piece]);
    }
    return groups.map(group=>({group,x:group[0].box[0],right:group.at(-1)!.box[2],text:group.map(p=>p.text).join(' ')}));
  });
  let split: number | undefined, best=0;
  for(let x=width*.3;x<width*.7;x+=size/2) {
    const left=chunks.filter(c=>c.right<x && c.text.length>16), right=chunks.filter(c=>c.x>x && c.text.length>16);
    const crossed=chunks.filter(c=>c.x<x && c.right>x);
    if(left.length<4 || right.length<4 || crossed.length>Math.min(left.length,right.length)*.2) continue;
    const score=Math.min(left.length,right.length)-crossed.length*3;
    if(score>best) { best=score; split=x; }
  }
  const lines:SourceLine[]=[], items:ScriptNode[]=[];
  const lineFor=(group:TextPiece[])=>{
    let text=''; const words:SourceLine['words']=[], runs:SourceRun[]=[];
    let previous:TextPiece|undefined;
    for(const p of group) {
      if(previous && !/\s$/.test(text) && !/^\s/.test(p.text)) {
        const gap=p.box[0]-previous.box[2];
        if(p.spaceBefore || gap>size*.08) text+=' '.repeat(Math.max(1,Math.min(30,Math.round(gap/(size*.28)))));
      }
      const start=text.length; text+=p.text;
      runs.push({...p.run,start,end:text.length,size:p.size/size});
      const sourceWords=p.words ?? [...p.text.matchAll(/\S+/g)].map(m=>({start:m.index!,end:m.index!+m[0].length,bbox:[p.box[0]+(p.box[2]-p.box[0])*m.index!/p.text.length,p.box[1],p.box[0]+(p.box[2]-p.box[0])*(m.index!+m[0].length)/p.text.length,p.box[3]] as Box}));
      words.push(...sourceWords.map(w=>({...w,start:w.start+start,end:w.end+start})));
      previous=p;
    }
    const line:SourceLine={id:`p${page}-l${lines.length}`,pdfPage:page,text,bbox:[Math.min(...group.map(p=>p.box[0])),Math.min(...group.map(p=>p.box[1])),Math.max(...group.map(p=>p.box[2])),Math.max(...group.map(p=>p.box[3]))],words,runs};
    lines.push(line); return line;
  };
  const layout=(selected:SourceLine[], left:number, right:number):ScriptNode=>{
    const steps=selected.slice(1).map((l,i)=>l.bbox[1]-selected[i].bbox[1]).filter(v=>v>size*.8 && v<size*2);
    const leading=steps.length?median(steps):size*1.3;
    selected.forEach((line,i)=>{line.layout={indent:Math.max(0,(line.bbox[0]-left)/(right-left)),gap:i?Math.max(0,(line.bbox[1]-selected[i-1].bbox[1]-leading)/size):0};});
    return {id:`layout-${selected[0].id}`,kind:'layout',sources:selected.map(l=>({line:l.id,start:0,end:l.text.length}))};
  };
  if(split) {
    const crossing=rows.filter(r=>r.pieces.some(p=>p.box[0]<split! && p.box[2]>split!));
    // Full-width titles stay outside the columns; do not mix their reading order.
    const firstBody=Math.min(...chunks.filter(c=>c.right<split! || c.x>split!).map(c=>c.group[0].box[1]));
    const titles=crossing.filter(r=>r.pieces[0].box[1]<firstBody-size);
    const titleLines=titles.map(r=>lineFor(r.pieces));
    if(titleLines.length) {const bounds=extent(titleLines);items.push(layout(titleLines,Math.min(bounds[0],width*.1),Math.max(bounds[2],width*.9)));}
    const columns=[0,1].map(column=>rows.filter(r=>!titles.includes(r)).flatMap(r=>{
      const group=r.pieces.filter(p=>column===0?p.box[0]<split!:p.box[0]>=split!);
      return group.length?[lineFor(group)]:[];
    }));
    if(columns.every(c=>c.length)) items.push({id:`columns-p${page}`,kind:'parallel',columns:columns.map(c=>{const bounds=extent(c);return [layout(c,bounds[0],bounds[2])];})});
  } else {
    const all=rows.map(r=>lineFor(r.pieces));
    if(all.length) {const bounds=extent(all);items.push(layout(all,bounds[0],Math.max(bounds[2],bounds[0]+size*12)));}
  }
  return {lines,items};
}
