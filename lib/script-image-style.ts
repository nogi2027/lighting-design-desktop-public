import type { Box, SourceRun } from './formatted-script';

type Mask = { pixels: Float32Array; density: number };
const W=64,H=28;
const luminance=(r:number,g:number,b:number)=>.2126*r+.7152*g+.0722*b;

// Compare recognised words with local font samples. OCR alone supplies no
// dependable emphasis metadata. Uncertain matches retain normal styling.
export class ScriptImageStyle {
  private pixels:ImageData;
  private paper=[255,255,255];
  private canvas=document.createElement('canvas');
  private templates=new Map<string,{mask:Mask;bold:boolean;italic:boolean;family:'serif'|'sans-serif'|'monospace'}[]>();
  constructor(canvas:HTMLCanvasElement, private scale:number) {
    this.pixels=canvas.getContext('2d',{willReadFrequently:true})!.getImageData(0,0,canvas.width,canvas.height);
    const colors=new Map<string,{n:number;rgb:number[]}>();
    for(let i=0;i<this.pixels.data.length;i+=64){const rgb=Array.from(this.pixels.data.subarray(i,i+3));if(luminance(rgb[0],rgb[1],rgb[2])<170)continue;const key=rgb.map(v=>Math.round(v/24)).join(',');const item=colors.get(key)??{n:0,rgb:[0,0,0]};item.n++;rgb.forEach((v,c)=>item.rgb[c]+=v);colors.set(key,item);}
    const paper=[...colors.values()].sort((a,b)=>b.n-a.n)[0];if(paper)this.paper=paper.rgb.map(v=>v/paper.n);
    this.canvas.width=800;this.canvas.height=100;
  }
  private mask(image:ImageData, box:Box):Mask|null {
    let [x0,y0,x1,y1]=box.map(Math.round);
    x0=Math.max(0,x0); y0=Math.max(0,y0);x1=Math.min(image.width,x1);y1=Math.min(image.height,y1);
    let darkest=255,brightest=0;
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=(y*image.width+x)*4,l=luminance(image.data[i],image.data[i+1],image.data[i+2]);darkest=Math.min(darkest,l);brightest=Math.max(brightest,l);}
    if(brightest-darkest<35)return null;
    const threshold=darkest+(brightest-darkest)*.65;
    let left=x1,top=y1,right=x0,bottom=y0;
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
      const i=(y*image.width+x)*4;
      if(luminance(image.data[i],image.data[i+1],image.data[i+2])<threshold) {left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
    }
    if(right<=left || bottom<=top)return null;
    const pixels=new Float32Array(W*H);let density=0;
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const sx=left+(right-left+1)*(x+.5)/W,sy=top+(bottom-top+1)*(y+.5)/H;
      let ink=0;
      for(const dx of [-.35,.35])for(const dy of [-.35,.35]){
        const i=(Math.min(image.height-1,Math.max(0,Math.floor(sy+dy)))*image.width+Math.min(image.width-1,Math.max(0,Math.floor(sx+dx))))*4;
        ink+=Math.max(0,Math.min(1,(brightest-luminance(image.data[i],image.data[i+1],image.data[i+2]))/(brightest-darkest)))/4;
      }
      pixels[y*W+x]=ink;density+=ink;
    }
    return {pixels,density:density/(W*H)};
  }
  sample(box:Box):Pick<SourceRun,'color'|'highlight'> {
    const [x0,top,x1,bottom]=box.map(v=>Math.round(v*this.scale));
    const padding=Math.max(1,Math.round((bottom-top)*.2)),y0=top-padding,y1=bottom+padding;
    const colors=new Map<string,{n:number;r:number;g:number;b:number}>();
    let coloredInk=0,ink=0,ir=0,ig=0,ib=0,samples=0,edgeSamples=0,coloredEdge=0;
    for(let y=Math.max(0,y0);y<Math.min(this.pixels.height,y1);y+=2)for(let x=Math.max(0,x0);x<Math.min(this.pixels.width,x1);x+=2){
      const i=(y*this.pixels.width+x)*4,[r,g,b]=this.pixels.data.subarray(i,i+3), l=luminance(r,g,b),s=Math.max(r,g,b)-Math.min(r,g,b);
      samples++;const edge=y<y0+padding || y>=y1-padding;if(edge)edgeSamples++;
      if(l>135 && s>45 && Math.max(Math.abs((r-g)-(this.paper[0]-this.paper[1])),Math.abs((g-b)-(this.paper[1]-this.paper[2])))>35) {if(edge)coloredEdge++;const key=[r,g,b].map(v=>Math.round(v/24)).join(',');const c=colors.get(key)??{n:0,r:0,g:0,b:0};c.n++;c.r+=r;c.g+=g;c.b+=b;colors.set(key,c);}
      if(l<135) {ink++;if(s>45){coloredInk++;ir+=r;ig+=g;ib+=b;}}
    }
    const hex=(r:number,g:number,b:number)=>'#'+[r,g,b].map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
    const background=[...colors.values()].sort((a,b)=>b.n-a.n)[0];
    return {highlight:background && background.n>samples*.2 && coloredEdge>edgeSamples*.3?hex(background.r/background.n,background.g/background.n,background.b/background.n):undefined,color:coloredInk>ink*.65 && coloredInk>3?hex(ir/coloredInk,ig/coloredInk,ib/coloredInk):undefined};
  }
  recognise(text:string, box:Box):Pick<SourceRun,'bold'|'italic'|'fontFamily'> {
    if(!/^[\p{L}'’.,!?-]{3,28}$/u.test(text))return {};
    const target=this.mask(this.pixels,box.map(v=>v*this.scale) as Box);
    if(!target)return {};
    let templates=this.templates.get(text);
    if(!templates) {
      templates=[];
      const context=this.canvas.getContext('2d',{willReadFrequently:true})!;
      for(const [font,family] of [['Times New Roman','serif'],['Arial','sans-serif'],['Courier New','monospace']] as const)for(const bold of [false,true])for(const italic of [false,true]){
        context.fillStyle='white';context.fillRect(0,0,800,100);context.fillStyle='black';context.font=`${italic?'italic ':''}${bold?'bold ':''}40px "${font}"`;context.fillText(text,10,65);
        const mask=this.mask(context.getImageData(0,0,800,100),[4,20,Math.min(800,context.measureText(text).width+24),76]);
        if(mask)templates.push({mask,bold,italic,family});
      }
      this.templates.set(text,templates);
    }
    const matches=templates.map(template=>{
      let score=Infinity;
      for(const shift of [-1,0,1]){
        let difference=0;
        for(let y=0;y<H;y++)for(let x=1;x<W-1;x++)difference+=Math.abs(target.pixels[y*W+x]-template.mask.pixels[y*W+x+shift]);
        score=Math.min(score,difference/(H*(W-2)));
      }
      return {...template,score};
    }).sort((a,b)=>a.score-b.score);
    const best=matches[0],normal=matches.filter(m=>!m.bold && !m.italic)[0];
    if(!best || best.score>.26)return {};
    const emphasis=normal && normal.score-best.score>.012;
    return {fontFamily:best.family,bold:emphasis&&best.bold||undefined,italic:emphasis&&best.italic||undefined};
  }
}
