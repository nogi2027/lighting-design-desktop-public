import test from 'node:test';
import assert from 'node:assert/strict';
import { assemblePage } from '../lib/script-layout.ts';
import { renderScriptPage, sourceAnchor, resolveCueSource } from '../lib/formatted-script.ts';
const piece=(text,x,y,run={})=>({text,box:[x,y,x+text.length*6,y+10],baseline:y+10,size:12,run:{style:'normal',...run}});
const documentFor=(pieces,width=612)=>({sourceSha256:'a'.repeat(64),pages:[{pdfPage:1,scriptPage:1,width,height:792}],...assemblePage(1,pieces,width)});

test('imported spacing and combined emphasis preserve every word and its cue geometry',()=>{
 const document=documentFor([piece('MARA',48,50,{bold:true}),piece('The lantern is ready.',78,68),piece('ELI',48,112,{bold:true,italic:true}),piece('Wait for the bell.',78,130,{highlight:'#ffff00',color:'#1200aa'})]);
 const html=renderScriptPage(document,1);
 assert.ok(document.lines[1].layout.indent>document.lines[0].layout.indent);
 assert.ok(document.lines[2].layout.gap>0);
 assert.match(html,/<strong><em>ELI<\/em><\/strong>/);
 assert.match(html,/background-color:#ffff00/);
 assert.match(html,/data-source-y="0\.063131/);
 assert.equal([...html.matchAll(/data-source-word=/g)].length,document.lines.flatMap(l=>l.words).length);
 for(const line of document.lines)for(let word=0;word<line.words.length;word++) {
  const anchor=sourceAnchor(document,line.id,word);
  assert.equal(resolveCueSource(document,{...anchor,anchorType:'phrase'}).word,word);
 }
});

test('independent columns retain reading order without duplicating source text',()=>{
 const pieces=[];
 for(let i=0;i<6;i++){pieces.push(piece('Left dialogue continues here.',48,100+i*20));pieces.push(piece('Right dialogue continues here.',330,100+i*20));}
 const document=documentFor(pieces);
 assert.equal(document.items[0].kind,'parallel');
 assert.equal(document.items[0].columns.length,2);
 const html=renderScriptPage(document,1);
 assert.equal([...html.matchAll(/data-source-word=/g)].length,document.lines.flatMap(l=>l.words).length);
 assert.equal(new Set([...html.matchAll(/data-source-line="([^"]+)" data-source-word="(\d+)"/g)].map(m=>m[1]+':'+m[2])).size,document.lines.flatMap(l=>l.words).length);
});

test('rich formatting cannot inject markup or CSS from a show file',()=>{
 const document=documentFor([piece('<script>alert(1)</script>',48,50,{color:'red;position:fixed',highlight:'" onmouseover="x',fontFamily:'x;display:none',size:Infinity})]);
 const html=renderScriptPage(document,1);
 assert.ok(html.includes('&lt;script&gt;'));
 assert.ok(!html.includes('<script>'));
 assert.ok(!html.includes('position:fixed'));
 assert.ok(!html.includes('onmouseover'));
 assert.ok(!html.includes('Infinity'));
});
