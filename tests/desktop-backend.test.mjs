import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
const Y=createRequire(import.meta.url)('yjs');
import backend from '../electron/backend.cjs';
const actor={id:'local',name:'Local',role:'Offline',initials:'LX',color:'#35a7ff'};
const state={schemaVersion:12,document:{id:'test-script',filename:'Test.pdf',version:'a'.repeat(64),pages:8},profiles:[actor],scenes:[{id:'opening',number:'1',name:'Opening',pageStart:1,startY:0,pageEnd:4,ownerId:null},{id:'ending',number:'2',name:'Ending',pageStart:5,startY:0,pageEnd:8,ownerId:null}],cues:[],discussions:[],deletedCues:[],history:[],inboxReads:[],inboxPins:[]};
const get=async route=>await (await backend.route(new Request('app://desktop/api/sync/'+route))).json();
async function action(action,operationId=crypto.randomUUID()) {
 const boot=await get('bootstrap');
 const request=new Request('app://desktop/api/sync/operations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operations:[{protocol:2,workspaceId:'lighting-design',epoch:boot.epoch,operationId,sessionId:'desktop-test',actorId:'local',createdAt:'2026-10-20T12:00:00.000Z',dependsOn:[],action}]})});
 const response=await backend.route(request);assert.equal(response.status,200);const result=(await response.json()).results[0];assert.ok(['applied','adjusted','unchanged'].includes(result.status),JSON.stringify(result));return result;
}
const cue=(id,page=1)=>({id,number:null,title:'Test cue',description:'',technicalNotes:'',mode:'unassigned',blackout:false,sceneId:page<5?'opening':'ending',page,anchorType:'line',selectedText:'Test line',enclosingLine:'Test line',anchorY:.3,anchorOrder:page+.3});
test('original backend persists edits, text versions, notes, deletion and restoration on local SQLite',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'lx-backend-'));const file=path.join(folder,'workspace.sqlite');
 try {
  await backend.initialize(file,state,path.resolve('drizzle'));
  await action({type:'createCue',cue:cue('test-cue')},'create-once');
  await action({type:'createCue',cue:cue('test-cue')},'create-once');assert.equal((await backend.projection()).cues.length,1);
  const text=await get('text/test-cue');const doc=new Y.Doc();Y.applyUpdate(doc,Buffer.from(text.encodedState,'base64'));const base=Y.encodeStateVector(doc);doc.getText('title').insert(0,'Edited ');
  const b64=v=>Buffer.from(v).toString('base64');await action({type:'applyTextUpdate',cueId:'test-cue',baseDocumentRevision:text.revision,baseStateVector:b64(base),resultStateVector:b64(Y.encodeStateVector(doc)),update:b64(Y.encodeStateAsUpdate(doc,base))});
  let history=await get('history/test-cue');assert.ok(history.versions.length>=2);assert.equal((await backend.projection()).cues[0].title,'Edited Test cue');
  await action({type:'setCueNumber',cueId:'test-cue',number:'12.125',expectedAssignmentVersion:1});
  await action({type:'setBlackout',cueId:'test-cue',blackout:true,expectedBlackoutVersion:1});
  await action({type:'addNote',discussion:{id:'test-note',targetType:'cue',cueId:'test-cue',authorId:'local',content:'Check timing',createdAt:new Date().toISOString(),resolved:false,replies:[]}});
  await action({type:'addReply',discussionId:'test-note',reply:{id:'test-reply',authorId:'local',content:'Checked',createdAt:new Date().toISOString()}});
  const versions=(await get('bootstrap')).versions.cues['test-cue'];await action({type:'deleteCue',cueId:'test-cue',expectedLifecycleVersion:versions.lifecycle});
  assert.equal((await backend.projection()).deletedCues[0].discussions[0].replies[0].content,'Checked');
  await action({type:'restoreCue',cueId:'test-cue',expectedLifecycleVersion:versions.lifecycle+1});
  const before=await backend.projection();await backend.initialize(file,state,path.resolve('drizzle'));assert.deepEqual(await backend.projection(),before);
  assert.deepEqual((await get('history/test-cue')).versions,history.versions);
 } finally {backend.close();await fs.rm(folder,{recursive:true,force:true})}
});
test('original batch numbering changes only the chosen unnumbered cues',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'lx-numbering-'));
 try{
  await backend.initialize(path.join(folder,'workspace.sqlite'),state,path.resolve('drizzle'));
  for(const item of [cue('existing'),cue('number-me'),cue('other-scene',6)])await action({type:'createCue',cue:item});
  await action({type:'setCueNumber',cueId:'existing',number:'50.125',expectedAssignmentVersion:1});
  const v=(await get('bootstrap')).versions.cues['number-me'];
  await action({type:'assignCueNumbers',cues:[{cueId:'number-me',expectedAssignmentVersion:v.assignment,expectedPositionVersion:v.position,expectedLifecycleVersion:v.lifecycle}]});
  const after=await backend.projection();assert.equal(after.cues.find(c=>c.id==='existing').number,50.125);assert.ok(after.cues.find(c=>c.id==='number-me').number>0);assert.equal(after.cues.find(c=>c.id==='other-scene').number,null);
 }finally{backend.close();await fs.rm(folder,{recursive:true,force:true})}
});
