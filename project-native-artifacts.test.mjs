import assert from 'node:assert/strict'
import test from 'node:test'
import {collectNativeProjectArtifact} from './project-native-artifacts.mjs'

const id='33333333-3333-3333-3333-333333333333',org='22222222-2222-2222-2222-222222222222'
const boot={title:'Current report',updated_at:'2026-10-22T15:00:00Z',ver:'1-native',kind:'authed',contentStore:'pages',typeSlug:org,syncToken:'sync-secret',assetToken:'viewer-secret'}
const snapshot={phase:'snapshot',head:7,values:{[`project/${id}`]:{name:'Current report',artifact:id,tabs:['one']},'node/one':{parent:'file/one',doc:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Current native text.'}]}]},rev:3}},refs:['project/root','node/one']}
class Socket extends EventTarget {
  constructor(frames){super();this.frames=frames;this.sent=[];this.closed=false;queueMicrotask(()=>this.dispatchEvent(new Event('open')))}
  send(text){const value=JSON.parse(text);this.sent.push(value);if(value.kind==='join')queueMicrotask(()=>this.receive({kind:'ctrl:joined',slug:id,payload:{door:true,stores:['bongo'],sendStores:['bongo']}}));if(value.kind==='ctrl:open')queueMicrotask(()=>{this.receive({kind:'ctrl:opened',slug:id,payload:{stream:'bongo.1'}});for(const frame of this.frames){if(this.closed)break;this.receive(frame)}})}
  receive(value){this.dispatchEvent(new MessageEvent('message',{data:typeof value==='string'?value:JSON.stringify(value)}))}
  close(){this.closed=true;this.dispatchEvent(new Event('close'))}
}
const wire=payload=>({kind:'store:bongo',slug:id,stream:'bongo.1',payload})
const fixture=(frames=[wire(snapshot),wire({phase:'fence',pos:'read-position'})])=>{
  let socket;const requests=[]
  return {requests,get socket(){return socket},options:{id,org,boot,request:async(endpoint,options)=>{requests.push({endpoint,options});return{grant:'grant-secret'}},openSocket:(url,protocols)=>{socket=new Socket(frames);socket.url=url;socket.protocols=protocols;return socket},timeoutMs:100,now:()=> '2026-10-22T15:00:01Z'}}
}

test('reads current native document state using only join and read-open messages',async()=>{
  const f=fixture(),result=await collectNativeProjectArtifact(f.options)
  assert.equal(f.requests.length,1)
  assert.equal(f.requests[0].endpoint,`/api/frame/lane/bongo/${id}/subscribe?org=${org}`)
  assert.deepEqual(JSON.parse(f.requests[0].options.body),{token:'sync-secret'})
  assert.deepEqual(f.socket.sent.map(x=>x.kind),['join','ctrl:open'])
  assert.deepEqual(JSON.parse(f.socket.sent[1].payload.spec),{container:`project/${id}`})
  assert.equal(f.socket.sent[1].payload.since,null)
  assert.equal(f.socket.closed,true)
  assert.equal(result.metadata.nativeStateCaptured,true)
  const native=JSON.parse(result.files[0].bytes)
  assert.deepEqual(native.values,snapshot.values)
  assert.equal(native.head,7)
  assert.match(result.files.find(x=>x.path==='report.txt').bytes.toString(),/Current native text\./)
  for(const file of result.files)for(const secret of ['sync-secret','viewer-secret','grant-secret','read-position'])assert.equal(file.bytes.toString().includes(secret),false)
})

test('joins all snapshot chunks and accepts identical repeated values',async()=>{
  const extra={phase:'snapshot',head:7,values:{'file/two':{content:{type:'image',blob:'native-asset-reference'}}},refs:['file/two']}
  const f=fixture([wire(snapshot),wire(extra),wire(snapshot),wire({phase:'fence',pos:'latest-position'})])
  const result=await collectNativeProjectArtifact(f.options),native=JSON.parse(result.files[0].bytes)
  assert.equal(result.metadata.valueCount,3)
  assert.equal(result.metadata.referenceCount,3)
  assert.deepEqual(native.values['file/two'],extra.values['file/two'])
})

test('refuses a legacy subscription token because it is not a native sync token',async()=>{
  const f=fixture(),modernBoot={...boot,subscriptionToken:'subscription-secret'};delete modernBoot.syncToken
  await assert.rejects(collectNativeProjectArtifact({...f.options,boot:modernBoot}),/type does not support/)
  assert.equal(f.requests.length,0)
  assert.equal(f.socket,undefined)
})

test('content hash stays stable when capture time and reference order change',async()=>{
  const first=fixture(),secondSnapshot={...snapshot,refs:[...snapshot.refs].reverse()},second=fixture([wire(secondSnapshot),wire({phase:'fence',pos:'other-position'})])
  const a=await collectNativeProjectArtifact(first.options),b=await collectNativeProjectArtifact({...second.options,now:()=> '2026-10-22T15:00:05Z'})
  assert.equal(a.metadata.contentSha256,b.metadata.contentSha256)
  assert.notEqual(a.metadata.stateSha256,b.metadata.stateSha256)
})

test('extracts the native Claude Docs block map in root order without cached views or widget code',async()=>{
  const doc={
    'z-heading':{type:'heading',attrs:{level:1},content:[{kind:'text',text:'First heading'}]},
    'a-paragraph':{type:'paragraph',content:[{kind:'text',text:'Second '},{kind:'marks',items:[{edge:'start',type:'bold'}]},{kind:'text',text:'paragraph.'},{kind:'marks',items:[{edge:'end',type:'bold'}]}]},
    cellB:{type:'tableCell',content:[{kind:'block',id:'paragraphB'}]},
    cellA:{type:'tableHeader',content:[{kind:'block',id:'paragraphA'}]},
    paragraphA:{type:'paragraph',content:[{kind:'text',text:'Column A'}]},
    paragraphB:{type:'paragraph',content:[{kind:'text',text:'Column B'}]},
    row:{type:'tableRow',content:[{kind:'block',id:'cellA'},{kind:'block',id:'cellB'}]},
    table:{type:'table',content:[{kind:'block',id:'row'}]},
    embed:{type:'embed',attrs:{ref:'widget',caption:'Current chart'}},
    stale:{type:'paragraph',content:[{kind:'text',text:'Deleted stale text'}]},
    root:{type:'root',content:[{kind:'block',id:'z-heading'},{kind:'block',id:'a-paragraph'},{kind:'block',id:'table'},{kind:'block',id:'embed'}]}
  }
  const current=structuredClone(snapshot)
  current.values['node/one']={doc,view:{complete:true,doc:'<doc>Outdated cached view</doc>'},rev:3}
  current.values['node/widget']={code:'privateWidgetImplementation()'}
  const result=await collectNativeProjectArtifact(fixture([wire(current),wire({phase:'fence'})]).options)
  const text=result.files.find(file=>file.path==='report.txt').bytes.toString()
  assert.ok(text.indexOf('First heading')<text.indexOf('Second paragraph.'))
  assert.match(text,/Column A\tColumn B/)
  assert.match(text,/Embedded content: Current chart/)
  for(const omitted of ['Deleted stale text','Outdated cached view','privateWidgetImplementation'])assert.equal(text.includes(omitted),false)
  assert.deepEqual(JSON.parse(result.files[0].bytes).values,current.values)
})

test('keeps exact native state but does not export partial prose from broken native block references',async()=>{
  for(const doc of [
    {root:{type:'root',content:[{kind:'block',id:'missing'}]}},
    {root:{type:'root',content:[{kind:'block',id:'root'}]}}
  ]){
    const current=structuredClone(snapshot);current.values['node/one'].doc=doc
    const result=await collectNativeProjectArtifact(fixture([wire(current),wire({phase:'fence'})]).options)
    assert.deepEqual(result.files.map(file=>file.path),['native-state.json'])
    assert.deepEqual(JSON.parse(result.files[0].bytes).values,current.values)
  }
})

test('refuses a foreign document, a partial stream, and native changes before the fence',async()=>{
  const changed=structuredClone(snapshot);changed.values['node/one'].rev=4
  const foreign=structuredClone(snapshot);delete foreign.values[`project/${id}`];foreign.values[`project/${org}`]={name:'Same title'}
  for(const frames of [[wire(foreign),wire({phase:'fence'})],[wire(snapshot),wire(changed),wire({phase:'fence'})],[wire(snapshot),wire({phase:'tail',values:{}})]]){
    const f=fixture(frames)
    await assert.rejects(collectNativeProjectArtifact(f.options),error=>error.code==='PROJECT_REPORT_UNAVAILABLE')
    assert.equal(f.socket.closed,true)
  }
  const f=fixture([wire(snapshot)])
  await assert.rejects(collectNativeProjectArtifact({...f.options,timeoutMs:5}),/timed out/)
})

test('rejects denied reads, malformed data, wrong scope, and excessive data without partial output',async()=>{
  for(const frames of [[{kind:'ctrl:stream_denied',slug:id,payload:{stream:'bongo.1',reason:'DENIED'}}],['not JSON'],[{kind:'store:bongo',slug:org,stream:'bongo.1',payload:snapshot}]]){
    const f=fixture(frames)
    await assert.rejects(collectNativeProjectArtifact(f.options),error=>error.code==='PROJECT_REPORT_UNAVAILABLE')
  }
  const f=fixture()
  await assert.rejects(collectNativeProjectArtifact({...f.options,maxBytes:50}),/read limit/)
})

test('requires a verified scoped connection and does not expose provider errors',async()=>{
  const f=fixture()
  await assert.rejects(collectNativeProjectArtifact({...f.options,id:'not-an-id'}),/verified source/)
  await assert.rejects(collectNativeProjectArtifact({...f.options,boot:{...boot,contentStore:'unknown'}}),/type does not support/)
  await assert.rejects(collectNativeProjectArtifact({...f.options,request:async()=>{throw new Error('private bearer token')}}),error=>error.code==='PROJECT_REPORT_UNAVAILABLE'&&!error.message.includes('private'))
})
