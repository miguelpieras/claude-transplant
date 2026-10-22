import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,readFile,realpath,rm,stat,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {projectTransferStamp,stageProjectTransfer,restoreProjectTransfer} from './project-transfer.mjs'

const SOURCE='11111111-1111-4111-8111-111111111111',SOURCE_ORG='22222222-2222-4222-8222-222222222222'
const TARGET='33333333-3333-4333-8333-333333333333',TARGET_ORG='44444444-4444-4444-8444-444444444444'
const TAGGED_TARGET='user_017KhXzYt7qMpxh9cLZ8cW5G'
const PROJECT='chan_source',THREAD='cmsg_thread',NOW='2026-10-22T10:00:00Z'
const hash=value=>createHash('sha256').update(value).digest('hex')
const clone=value=>JSON.parse(JSON.stringify(value))
async function fixture(t,{running=false,large=false}={}) {
  const dir=await mkdtemp(path.join(await realpath(tmpdir()),'project-transfer-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const calls=[],file=large?Buffer.alloc(16*1024*1024+1,4):Buffer.from('current result'),memory='# Memory\n'
  const source={id:PROJECT,name:'Current project',visibility:'private',overview_session_id:'cse_coordinator',channel_session_id:'cse_coordinator',disabled_at:null}
  const root={id:THREAD,thread_root_id:THREAD,display_name:'Current thread',thread_status:'idle',reply_count:'1',last_reply_at:NOW,bound_sessions:[{id:'cse_worker'}]}
  const index=()=>({sections:[{status:'idle',count:'1',data:[clone(root)]}],truncated:false})
  const sourceState={body:'Latest completed work',eventAt:NOW,running,reads:0,changed:false}
  const client={account:SOURCE,org:SOURCE_ORG,
    async projectRequest(endpoint,options={}){
      calls.push({kind:'source-read',endpoint})
      const u=new URL(endpoint,'https://claude.ai'),suffix=u.pathname.replace(`/v1/code/channels/${PROJECT}`,'')
      if(u.pathname===`/v1/code/memory/channel/${PROJECT}/memories`)return{data:[{id:'mem_source',path:'/MEMORY.md',content_sha256:hash(memory)}],prefixes:[]}
      if(u.pathname.endsWith('/memories/mem_source'))return{content:memory,content_sha256:hash(memory)}
      if(suffix==='')return{channel:clone(source)}
      if(suffix==='/config')return{config:{default_model:'model',limit_auto_continue:true}}
      if(suffix==='/threads')return index()
      if(suffix==='/timeline'){sourceState.reads++;if(sourceState.changed&&sourceState.reads===2)sourceState.body='Changed during capture';return{data:[{id:'cmsg_main',body:sourceState.body}],has_more:false}}
      if(suffix===`/threads/${THREAD}`)return{data:[{id:THREAD,body:'Thread work'},{id:'cmsg_reply',body:sourceState.body}],has_more:false}
      if(suffix==='/files:list')return{entries:[{path:'/result.bin',size_bytes:file.length,is_directory:false}]}
      if(suffix==='/files:open')return{type:'download',data:file.toString('base64'),size_bytes:file.length,content_revision:'revision1'}
      if(suffix==='/artifacts'||suffix==='/attachments')return{data:[],truncated:false}
      throw Error(`Unexpected source read: ${endpoint}`)
    },
    async projectWrite(endpoint,options){const body=JSON.parse(options.body);calls.push({kind:'source-write',endpoint,method:options.method,body});assert.equal(endpoint,`/v1/code/channels/${PROJECT}`);assert.deepEqual(body,{disabled:true});source.disabled_at=NOW;return{channel:clone(source)}},
    async session(id){return{id,status:'active',worker_status:sourceState.running&&id==='cse_worker'?'running':'idle',connection_status:'disconnected',last_event_at:sourceState.eventAt,created_at:NOW}},
    async eventRows(id){return[{event_type:'message',sequence_num:'1',payload:{type:'assistant',message:{content:`${id}: ${sourceState.body}`}}}]}
  }
  const target={channel:null,config:{default_model:'default',limit_auto_continue:false},files:new Map(),memories:new Map(),creates:0,failAfterWrite:false,failConfigAfterWrite:false,failPauseAfterWrite:false,ignoreCreatePause:false,failCreate:false,uploads:0,hasMessages:false}
  const destination={account:TARGET,org:TARGET_ORG,
    async projectRequest(endpoint,options={}){
      calls.push({kind:'target-read',endpoint})
      const u=new URL(endpoint,'https://claude.ai'),id=target.channel?.id,suffix=u.pathname.replace(`/v1/code/channels/${id}`,'')
      if(u.pathname===`/v1/code/memory/channel/${id}/memories`)return{data:[...target.memories].map(([p,m])=>({id:m.id,path:p,content_sha256:hash(m.content)})),prefixes:[]}
      if(u.pathname.startsWith(`/v1/code/memory/channel/${id}/memories/`)){const entry=[...target.memories.values()].find(m=>m.id===u.pathname.split('/').at(-1));return{content:entry.content,content_sha256:hash(entry.content)}}
      if(suffix==='')return{channel:clone(target.channel)}
      if(suffix==='/config')return{config:clone(target.config)}
      if(suffix==='/threads')return{sections:[],truncated:false}
      if(suffix==='/timeline')return{data:target.hasMessages?[{id:'cmsg_new',body:'User started new work'}]:[],has_more:false}
      if(suffix==='/files:list')return{entries:[...target.files].map(([p,bytes])=>({path:p,size_bytes:bytes.length,is_directory:false}))}
      if(suffix==='/files:open'){const bytes=target.files.get(JSON.parse(options.body).path.replace(/^\//,''));if(!bytes)throw Error('Missing target bytes');return{type:'download',data:bytes.toString('base64'),size_bytes:bytes.length}}
      throw Error(`Unexpected target read: ${endpoint}`)
    },
    async projectWrite(endpoint,options){
      const body=JSON.parse(options.body);calls.push({kind:'target-write',endpoint,method:options.method,body})
      if(endpoint==='/v1/code/channels'){
        target.creates++;target.channel={...body,id:'chan_target',created_by_account_id:TAGGED_TARGET,created_at:NOW,disabled_at:body.disabled&&!target.ignoreCreatePause?NOW:null};delete target.channel.disabled
        if(target.failCreate)throw Error('Create response lost')
        return{channel:clone(target.channel)}
      }
      if(endpoint==='/v1/code/channels/chan_target'&&options.method==='PATCH'){assert.deepEqual(body,{disabled:true});target.channel.disabled_at=NOW;if(target.failPauseAfterWrite){target.failPauseAfterWrite=false;throw Error('Pause response lost')}return{channel:clone(target.channel)}}
      if(endpoint.endsWith('/config')){Object.assign(target.config,body);if(target.failConfigAfterWrite){target.failConfigAfterWrite=false;throw Error('Config response lost')}return{config:clone(target.config)}}
      if(endpoint.endsWith('/memories')){assert.deepEqual(body.precondition,{type:'not_exists'});assert(!target.memories.has(body.path));const id=`mem_${target.memories.size}`;target.memories.set(body.path,{id,content:body.content});return{id,path:body.path,content:body.content,content_sha256:hash(body.content)}}
      if(endpoint.endsWith('/files:write')){
        const results=body.files.map(row=>{assert.equal(row.overwrite,false);const p=row.path.replace(/^\//,'');assert(!target.files.has(p));target.files.set(p,Buffer.from(row.content,'base64'));return{path:row.path,entry:{path:row.path}}})
        if(target.failAfterWrite){target.failAfterWrite=false;throw Error('Write response lost')}
        return{results}
      }
      throw Error(`Unexpected target write: ${endpoint}`)
    },
    async projectUpload(id,p,bytes){target.uploads++;assert.equal(id,'chan_target');assert(!target.files.has(p.replace(/^\//,'')));target.files.set(p.replace(/^\//,''),Buffer.from(bytes))}
  }
  const output=path.join(dir,'stage')
  return{dir,output,prepared:path.join(output,'prepared'),calls,client,destination,source,target,sourceState,file,stage:()=>stageProjectTransfer(client,{},PROJECT,output)}
}

test('stage pauses the source and captures its latest state before a switch',async t=>{
  const f=await fixture(t),result=await f.stage()
  assert.equal(result.ready,true);assert.equal(result.threads,1);assert.equal(f.source.disabled_at,NOW)
  const receipt=JSON.parse(await readFile(path.join(f.output,'transfer.json'),'utf8'))
  assert.equal(receipt.status,'ready');assert.equal(receipt.sourcePaused,true);assert.equal(receipt.sourceDisabledAt,NOW)
  assert.match(receipt.sourceStamp,/^[a-f0-9]{64}$/);assert.equal(receipt.sourceStamp,await projectTransferStamp(f.client,PROJECT))
  assert.equal((await stat(f.output)).mode&0o777,0o700)
  assert.match(await readFile(path.join(f.prepared,'main-transcript.md'),'utf8'),/Latest completed work/)
  assert.equal(f.calls.filter(call=>call.kind==='source-write').length,1)
  f.sourceState.body='A later manual edit'
  assert.notEqual(await projectTransferStamp(f.client,PROJECT),receipt.sourceStamp)
})

test('running workers leave a paused source and a blocked stage, without capture',async t=>{
  const f=await fixture(t,{running:true})
  await assert.rejects(f.stage(),/worker is running/)
  assert.equal(f.source.disabled_at,NOW)
  const receipt=JSON.parse(await readFile(path.join(f.output,'transfer.json'),'utf8'))
  assert.equal(receipt.status,'blocked');assert.equal(receipt.sourcePaused,true)
  await assert.rejects(stat(path.join(f.output,'capture')),{code:'ENOENT'})
})

test('empty projects transfer their files and memory without a coordinator or worker',async t=>{
  const f=await fixture(t),request=f.client.projectRequest
  delete f.source.overview_session_id;delete f.source.channel_session_id
  f.client.projectRequest=async(endpoint,...args)=>endpoint.includes('/threads?')?{sections:[],truncated:false}:endpoint.includes('/timeline?')?{data:[],has_more:false}:request(endpoint,...args)
  f.client.session=async()=>assert.fail('An empty project has no session')
  const result=await f.stage()
  assert.equal(result.ready,true)
  assert.equal(result.hasConversationWork,false)
  assert.equal(result.threads,0)
  assert.equal((await restoreProjectTransfer(f.destination,f.prepared)).restored,true)
  assert(f.target.files.get('result.bin').equals(f.file))
})

test('a missing coordinator cannot silently discard existing project conversation work',async t=>{
  const f=await fixture(t),request=f.client.projectRequest
  delete f.source.overview_session_id;delete f.source.channel_session_id
  f.client.projectRequest=async(endpoint,...args)=>endpoint.includes('/threads?')?{sections:[],truncated:false}:request(endpoint,...args)
  await assert.rejects(f.stage(),/conversation work but no verified coordinator/)
  assert.equal(f.target.creates,0)
})

test('source edits during staging cannot produce a ready transfer',async t=>{
  const f=await fixture(t);f.sourceState.changed=true
  await assert.rejects(f.stage(),/changed during staging|capture is incomplete/)
  assert.equal(JSON.parse(await readFile(path.join(f.output,'transfer.json'),'utf8')).status,'blocked')
  assert.equal(f.source.disabled_at,NOW)
  await assert.rejects(stat(f.prepared),{code:'ENOENT'})
})

test('read-time worker fields do not block staging or change saved message bytes',async t=>{
  const f=await fixture(t),request=f.client.projectRequest
  let reads=0
  f.client.projectRequest=async(endpoint,...args)=>{
    const response=await request(endpoint,...args),pathname=new URL(endpoint,'https://claude.ai').pathname
    if(pathname.endsWith('/timeline')||pathname.endsWith(`/threads/${THREAD}`))response.data=response.data.map(row=>({...row,thread_own_session_at:new Date(Date.parse(NOW)+ ++reads).toISOString(),...reads%2?{thread_own_session_id:'cse_worker'}:{}}))
    return response
  }
  const result=await f.stage()
  assert.equal(result.ready,true)
  assert.equal(result.transfer.sourceStamp,await projectTransferStamp(f.client,PROJECT))
  const capture=path.join(f.output,'capture'),manifest=JSON.parse(await readFile(path.join(capture,'manifest.json'),'utf8'))
  const capturedMessages=[]
  for(const role of ['coordinator-history','thread-history']){
    const entry=manifest.files.find(file=>file.role===role),history=JSON.parse(await readFile(path.join(capture,entry.path),'utf8'))
    assert.ok(history.data.length)
    assert.ok(history.data.every(row=>Number.isFinite(Date.parse(row.thread_own_session_at))))
    capturedMessages.push(...history.data)
  }
  assert.ok(capturedMessages.some(row=>row.thread_own_session_id==='cse_worker'))
  assert.ok(capturedMessages.some(row=>!Object.hasOwn(row,'thread_own_session_id')))
})

test('message content, attachments, session bindings, and status remain part of the source stamp',async t=>{
  for(const route of ['timeline',`threads/${THREAD}`])for(const [field,value] of Object.entries({body:'A real edit',attachments:[{file_id:'file_changed'}],bound_sessions:[{id:'cse_changed'}],thread_status:'working'})){
    const f=await fixture(t),request=f.client.projectRequest
    let changed=false,reads=0
    f.client.projectRequest=async(endpoint,...args)=>{
      const response=await request(endpoint,...args)
      if(new URL(endpoint,'https://claude.ai').pathname.endsWith(`/${route}`))response.data[0]={...response.data[0],thread_own_session_at:new Date(Date.parse(NOW)+ ++reads).toISOString(),...reads%2?{thread_own_session_id:'cse_worker'}:{},...changed?{[field]:value}:{}}
      return response
    }
    const before=await projectTransferStamp(f.client,PROJECT)
    assert.equal(await projectTransferStamp(f.client,PROJECT),before,`${route}: current-view worker fields only`)
    changed=true
    assert.notEqual(await projectTransferStamp(f.client,PROJECT),before,`${route}: ${field}`)
  }
})

test('coordinator session IDs remain part of the source stamp',async t=>{
  const f=await fixture(t),before=await projectTransferStamp(f.client,PROJECT)
  f.source.channel_session_id='cse_newCoordinator'
  assert.notEqual(await projectTransferStamp(f.client,PROJECT),before)
})

test('the source stamp includes current native report content beyond the unchanged index',async t=>{
  const f=await fixture(t),request=f.client.projectRequest
  f.client.projectRequest=async(endpoint,...args)=>endpoint.includes('/artifacts?')?{data:[{slug:'55555555-5555-4555-8555-555555555555',updated_at:NOW}]}:request(endpoint,...args)
  let body='current'
  f.client.projectArtifact=async()=>({metadata:{nativeStateCaptured:true,contentSha256:hash(body)}})
  const initial=await projectTransferStamp(f.client,PROJECT)
  body='edited while its index stayed unchanged'
  assert.notEqual(await projectTransferStamp(f.client,PROJECT),initial)
})

test('restore creates one paused project and verifies settings, memory and file bytes',async t=>{
  const f=await fixture(t);await f.stage()
  const result=await restoreProjectTransfer(f.destination,f.prepared)
  assert.equal(result.projectId,'chan_target');assert.equal(result.paused,true);assert.equal(result.nativeHistoryImport,false);assert.equal(result.autoResume,false)
  assert.equal(f.target.creates,1);assert.equal(f.target.config.default_model,'model');assert.equal(f.target.config.limit_auto_continue,false)
  assert(f.target.files.get('result.bin').equals(f.file));assert(f.target.memories.get('/MEMORY.md').content.startsWith('# Memory\n'));assert.match(f.target.memories.get('/MEMORY.md').content,/migration\/chan_source\/main-transcript\.md/)
  assert(f.calls.filter(call=>call.kind==='target-write').every(call=>!call.endpoint.endsWith('/messages')))
  assert.equal(JSON.parse(await readFile(path.join(f.output,'restore.json'),'utf8')).status,'complete')
  await restoreProjectTransfer(f.destination,f.prepared)
  assert.equal(f.target.creates,1)
})

test('restore retries verify a write with a lost response without creating or overwriting',async t=>{
  const f=await fixture(t);await f.stage();f.target.failAfterWrite=true
  await assert.rejects(restoreProjectTransfer(f.destination,f.prepared),/Write response lost/)
  const before=f.target.files.size
  await restoreProjectTransfer(f.destination,f.prepared)
  assert.equal(f.target.creates,1);assert(f.target.files.size>=before)
})

test('ambiguous project creation refuses a duplicate destination on retry',async t=>{
  const f=await fixture(t);await f.stage();f.target.failCreate=true
  await assert.rejects(restoreProjectTransfer(f.destination,f.prepared),/Create response lost/)
  f.target.failCreate=false
  await assert.rejects(restoreProjectTransfer(f.destination,f.prepared),/duplicate project will not be created/)
  assert.equal(f.target.creates,1)
})

test('a lost config response resumes only the exact planned config update',async t=>{
  const f=await fixture(t);await f.stage();f.target.failConfigAfterWrite=true
  await assert.rejects(restoreProjectTransfer(f.destination,f.prepared),/Config response lost/)
  await restoreProjectTransfer(f.destination,f.prepared)
  assert.equal(f.target.creates,1);assert.equal(f.target.config.default_model,'model')
})

test('create can ignore disabled while a lost pause reply resumes the same untouched project',async t=>{
  const f=await fixture(t);await f.stage();f.target.ignoreCreatePause=true;f.target.failPauseAfterWrite=true
  await assert.rejects(restoreProjectTransfer(f.destination,f.prepared),/Pause response lost/)
  assert.equal(f.target.creates,1);assert.equal(f.target.channel.disabled_at,NOW);assert.equal(f.target.files.size,0);assert.equal(f.target.memories.size,0)
  const receipt=JSON.parse(await readFile(path.join(f.output,'restore.json'),'utf8'))
  assert.equal(receipt.destination.projectId,'chan_target');assert.equal(receipt.pausePending,true);assert.equal(receipt.creationProfile.created_by_account_id,TAGGED_TARGET)
  await restoreProjectTransfer(f.destination,f.prepared)
  assert.equal(f.target.creates,1)
  const writes=f.calls.filter(call=>call.kind==='target-write'),pause=writes.findIndex(call=>call.endpoint==='/v1/code/channels/chan_target')
  assert(pause>=0);assert(writes.findIndex(call=>call.endpoint.endsWith('/config'))>pause)
})

test('changed destination data, owner, or pause state blocks retries before writes',async t=>{
  for(const change of ['file','owner','pause','extra file','settings','new messages']){
    const f=await fixture(t);await f.stage();await restoreProjectTransfer(f.destination,f.prepared)
    if(change==='file')f.target.files.set('result.bin',Buffer.from('User edit'))
    if(change==='owner')f.target.channel.created_by_account_id=SOURCE
    if(change==='pause')f.target.channel.disabled_at=null
    if(change==='extra file')f.target.files.set('foreign.txt',Buffer.from('Unrelated'))
    if(change==='settings')f.target.config.limit_auto_continue=true
    if(change==='new messages')f.target.hasMessages=true
    const writes=f.calls.filter(call=>call.kind==='target-write').length
    await assert.rejects(restoreProjectTransfer(f.destination,f.prepared),/changed|not paused|outside this project transfer|new conversation work/)
    assert.equal(f.calls.filter(call=>call.kind==='target-write').length,writes)
  }
})

test('tampered preparation and the source account are refused before target creation',async t=>{
  const f=await fixture(t);await f.stage()
  await assert.rejects(restoreProjectTransfer(f.client,f.prepared),/destination account/)
  await writeFile(path.join(f.prepared,'main-transcript.md'),'Changed',{mode:0o600})
  await assert.rejects(restoreProjectTransfer(f.destination,f.prepared),/failed verification/)
  assert.equal(f.target.creates,0)
})

test('large project files use staged upload and retain the exact bytes',async t=>{
  const f=await fixture(t,{large:true});await f.stage();await restoreProjectTransfer(f.destination,f.prepared)
  assert.equal(f.target.uploads,1);assert(f.target.files.get('result.bin').equals(f.file))
})
