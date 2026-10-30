import test from 'node:test';
import assert from 'node:assert/strict';
import { renderScriptPage, sourceAnchor, resolveCueSource } from '../lib/formatted-script.ts';
import { initialPreferences } from '../lib/ui-preferences.ts';

function fixture() {
 const text='MARA brings the lantern.';
 const words=[...text.matchAll(/\S+/g)].map(m=>({start:m.index,end:m.index+m[0].length,bbox:[48+m.index*6,80,48+(m.index+m[0].length)*6,92]}));
 return {sourceSha256:'0'.repeat(64),pages:[{pdfPage:1,scriptPage:1,width:612,height:792}],lines:[{id:'p1-l0',pdfPage:1,text,bbox:[48,80,200,92],words,runs:[{start:0,end:4,style:'normal',bold:true,italic:true},{start:4,end:text.length,style:'normal',size:1.2,highlight:'#ffff00'}],layout:{indent:.12,gap:.8}}],items:[{id:'layout-p1',kind:'layout',sources:[{line:'p1-l0',start:0,end:text.length}]}]};
}

test('rich imported lines keep emphasis, spacing, every source word, and page-relative anchors',()=>{
 const document=fixture(),html=renderScriptPage(document,1);
 assert.match(html,/<strong><em>MARA<\/em><\/strong>/);
 assert.match(html,/margin-left:12%;margin-top:0.8em/);
 assert.match(html,/font-size:1.2em/);
 assert.match(html,/background-color:#ffff00/);
 const rendered=[...html.matchAll(/data-source-line="([^"]+)" data-source-word="(\d+)"/g)].map(m=>m[1]+':'+m[2]);
 assert.equal(new Set(rendered).size,document.lines[0].words.length);
 assert.equal(rendered.length,document.lines[0].words.length);
 assert.match(html,new RegExp('data-source-y="'+80/792+'"'));
 for(let word=0;word<document.lines[0].words.length;word++){
  const anchor=sourceAnchor(document,'p1-l0',word);
  assert.equal(resolveCueSource(document,{...anchor,anchorType:'phrase'}).word,word);
 }
});

test('untrusted rich styles are constrained before they become HTML',()=>{
 const document=fixture();Object.assign(document.lines[0].runs[1],{color:'red;position:fixed',highlight:'" onmouseover="x',fontFamily:'x;display:none',size:Infinity});
 const html=renderScriptPage(document,1);
 for(const unsafe of ['position:fixed','onmouseover','display:none','Infinity']) assert.ok(!html.includes(unsafe));
});

test('existing structured scripts still render through their existing turn layout',()=>{
 const document=fixture();delete document.lines[0].layout;
 document.lines[0].runs=[{start:0,end:4,style:'bold'},{start:4,end:document.lines[0].text.length,style:'italic'}];
 document.items=[{id:'legacy-turn',kind:'turn',name:'',speaker:[{line:'p1-l0',start:0,end:4}],parts:[{kind:'dialogue',sources:[{line:'p1-l0',start:5,end:document.lines[0].text.length}]}]}];
 const html=renderScriptPage(document,1);
 assert.match(html,/class="reader-turn"/);assert.match(html,/class="reader-character"/);
 assert.ok(!html.includes('reader-import-line'));assert.equal([...html.matchAll(/data-source-word=/g)].length,4);
});

test('script fonts are optional and existing typeface preferences retain their meaning',()=>{
 const previous=globalThis.window;
 try{
  for(const font of ['source','serif','sans']){
   globalThis.window={localStorage:{getItem:key=>key==='lt-script-reading'?JSON.stringify({font}):null}};
   assert.equal(initialPreferences().reading.font,font);
  }
  globalThis.window={localStorage:{getItem:()=>null}};
  assert.equal(initialPreferences().reading.font,'serif');
 }finally{globalThis.window=previous;}
});


test('non-Latin text and punctuation-only lines retain coordinate-based cue links',()=>{
 for(const text of ['幕間','♪']){
  const document=fixture();const line=document.lines[0];line.text=text;line.words=[{start:0,end:text.length,bbox:[48,80,80,92]}];line.runs=[{start:0,end:text.length,style:'normal'}];document.items[0].sources[0].end=text.length;
  const anchor=sourceAnchor(document,line.id,0);
  assert.equal(resolveCueSource(document,{...anchor,anchorType:'phrase'}).lineId,line.id);
  assert.equal(resolveCueSource(document,{...anchor,selectedText:'',enclosingLine:'',anchorType:'phrase'}),null);
 }
});


test('preserved text colours remain visible over a source highlight',()=>{
 const document=fixture();document.lines[0].runs[1].color='#990022';
 const html=renderScriptPage(document,1);
 assert.match(html,/color:#990022;background-color:#ffff00/);
 assert.ok(!html.includes('color:#151515'));
});
