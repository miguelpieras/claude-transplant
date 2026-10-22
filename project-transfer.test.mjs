import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,readFile,realpath,rm,stat,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {projectTransferStamp,stageProjectTransfer,restoreProjectTransfer,assertDestinationConversation} from './project-transfer.mjs'

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
  const target={channel:null,config:{default_model:'default',limit_auto_continue:false},files:new Map(),memories:new Map(),creates:0,failAfterWrite:false,failConfigAfterWrite:false,failPauseBeforeWrite:false,failPauseAfterWrite:false,failEnableBeforeWrite:false,failEnableAfterWrite:false,failMemoryAfterWrite:false,failTopicBeforeWrite:false,failTopicAfterWrite:false,ignoreCreatePause:false,failCreate:false,uploads:0,hasMessages:false,rows:[],roots:[]}
  const destination={account:TARGET,org:TARGET_ORG,
    async projectRequest(endpoint,options={}){
      calls.push({kind:'target-read',endpoint})
      const u=new URL(endpoint,'https://claude.ai'),id=target.channel?.id,suffix=u.pathname.replace(`/v1/code/channels/${id}`,'')
      if(u.pathname===`/v1/code/memory/channel/${id}/memories`)return{data:[...target.memories].map(([p,m])=>({id:m.id,path:p,content_sha256:hash(m.content),...m.updated_by?{updated_by:clone(m.updated_by)}:{}})),prefixes:[]}
      if(u.pathname.startsWith(`/v1/code/memory/channel/${id}/memories/`)){const entry=[...target.memories.values()].find(m=>m.id===u.pathname.split('/').at(-1));return{content:entry.content,content_sha256:hash(entry.content)}}
      if(suffix==='')return{channel:clone(target.channel)}
      if(suffix==='/config')return{config:clone(target.config)}
      if(suffix==='/threads')return{sections:target.roots.length?[{status:'idle',count:String(target.roots.length),data:clone(target.roots)}]:[],truncated:false}
      if(suffix==='/timeline')return{data:target.hasMessages?[...clone(target.rows),{id:'cmsg_new',body:'User started new work'}]:clone(target.rows),has_more:false}
      if(suffix==='/files:list')return{entries:[...target.files].map(([p,bytes])=>({path:p,size_bytes:bytes.length,is_directory:false}))}
      if(suffix==='/files:open'){const body=JSON.parse(options.body),bytes=target.files.get(body.path.replace(/^\//,''));if(!bytes)throw Error('Missing target bytes');if(bytes.length>16*1024*1024&&body.range_offset===undefined)return{type:'unsupported',reason:'too_large',size_bytes:String(bytes.length)};return{type:'download',data:(body.range_offset===undefined?bytes:bytes.subarray(body.range_offset,body.range_offset+body.range_length)).toString('base64'),size_bytes:String(bytes.length),content_revision:'revision1'}}
      throw Error(`Unexpected target read: ${endpoint}`)
    },
    async projectWrite(endpoint,options){
      const body=JSON.parse(options.body);calls.push({kind:'target-write',endpoint,method:options.method,body})
      if(endpoint==='/v1/code/channels'){
        target.creates++;target.channel={...body,id:'chan_target',created_by_account_id:TAGGED_TARGET,created_at:NOW,disabled_at:body.disabled&&!target.ignoreCreatePause?NOW:null};delete target.channel.disabled
        if(target.failCreate)throw Error('Create response lost')
        return{channel:clone(target.channel)}
      }
      if(endpoint==='/v1/code/channels/chan_target'&&options.method==='PATCH'){
        if(Object.hasOwn(body,'topic')){assert.deepEqual(Object.keys(body),['topic']);if(target.failTopicBeforeWrite){target.failTopicBeforeWrite=false;throw Error('Goal response lost before write')}target.channel.topic=body.topic;if(target.failTopicAfterWrite){target.failTopicAfterWrite=false;throw Error('Goal response lost after write')}}
        else if(body.disabled===false){assert.deepEqual(body,{disabled:false});if(target.failEnableBeforeWrite){target.failEnableBeforeWrite=false;throw Error('Enable response lost before write')}target.channel.disabled_at=null;if(target.failEnableAfterWrite){target.failEnableAfterWrite=false;throw Error('Enable response lost after write')}}
        else{assert.deepEqual(body,{disabled:true});if(target.failPauseBeforeWrite){target.failPauseBeforeWrite=false;throw Error('Pause response lost before write')}target.channel.disabled_at=NOW;if(target.failPauseAfterWrite){target.failPauseAfterWrite=false;throw Error('Pause response lost')}}
        return{channel:clone(target.channel)}
      }
      if(endpoint.endsWith('/config')){for(const [key,value] of Object.entries(body)){if(key.startsWith('clear_')){assert.equal(value,true);const field=key.slice(6);target.config[field]=field==='default_source_urls'?[]:''}else target.config[key]=value}if(target.failConfigAfterWrite){target.failConfigAfterWrite=false;throw Error('Config response lost')}return{config:clone(target.config)}}
      if(endpoint.includes('/memories/')){const entry=[...target.memories.values()].find(m=>m.id===endpoint.split('/').at(-1));assert(entry);assert.deepEqual(body.precondition,{type:'content_sha256',content_sha256:hash(entry.content)});entry.content=body.content;if(target.failMemoryAfterWrite){target.failMemoryAfterWrite=false;throw Error('Memory response lost')}return{id:entry.id,content_sha256:hash(entry.content)}}
      if(endpoint.endsWith('/memories')){assert.deepEqual(body.precondition,{type:'not_exists'});assert(!target.memories.has(body.path));const id=`mem_${target.memories.size}`;target.memories.set(body.path,{id,content:body.content});return{id,path:body.path,content:body.content,content_sha256:hash(body.content)}}
      if(endpoint.endsWith('/files:write')){
        if(target.channel.disabled_at)throw Error('this project is paused: channel_disabled')
        const results=body.files.map(row=>{assert.equal(row.overwrite,false);const p=row.path.replace(/^\//,'');assert(!target.files.has(p));target.files.set(p,Buffer.from(row.content,'base64'));return{path:row.path,entry:{path:row.path}}})
        if(target.failAfterWrite){target.failAfterWrite=false;throw Error('Write response lost')}
        return{results}
      }
      throw Error(`Unexpected target write: ${endpoint}`)
    },
    async projectUpload(id,p,bytes){if(target.channel.disabled_at)throw Error('this project is paused: channel_disabled');target.uploads++;assert.equal(id,'chan_target');assert(!target.files.has(p.replace(/^\//,'')));target.files.set(p.replace(/^\//,''),Buffer.from(bytes))}
  }
  const output=path.join(dir,'stage')
  return{dir,output,prepared:path.join(output,'prepared'),calls,client,destination,source,target,sourceState,file,stage:()=>stageProjectTransfer(client,{},PROJECT,output)}
}

function welcomeDestination(f,{starter=true,memory=true,notice=true}={}) {
  const write=f.destination.projectWrite
  f.target.ignoreCreatePause=true
  f.destination.session=async id=>({id,status:'active',worker_status:'idle'})
  f.destination.projectWrite=async(endpoint,...args)=>{
    const result=await write(endpoint,...args)
    if(endpoint==='/v1/code/channels'){
      Object.assign(f.target.channel,{agent_id:'cagt_destination',channel_session_id:'cse_destination'})
      f.target.config.agent_id='cagt_destination'
      const row=id=>({id,channel_id:'chan_target',author_account_id:null,author_agent_id:'cagt_destination',author_session_id:'cse_destination',seq:'0',thread_root_id:id,has_thread:false,reply_count:'0',attachments:[],attached_outputs:[],bound_sessions:[],created_at:NOW})
      if(notice)f.target.rows.push({...row('cmsg_onboarding'),server_notice:true,body:JSON.stringify({card:{version:1,variant:'code',title_only:true,rows:['plan_project','connect_tools','connect_code','capabilities'].map(key=>({key}))},first_name:'Founder',kind:'onboarding',text:'Welcome'})})
      if(starter)f.target.rows.push({...row('cmsg_starter'),body:`Pick one of the suggestions to get going, or tell me what ${f.target.channel.name} is for.`})
      if(memory)f.target.memories.set('/MEMORY.md',{id:'mem_bootstrap',content:`# ${f.target.channel.name}\n- Project created. No goal is set yet.`,updated_by:{type:'session_actor',session_id:'cse_destination'}})
      return{channel:clone(f.target.channel)}
    }
    return result
  }
}

function sourceConfiguration(f,config) {
  const request=f.client.projectRequest
  f.client.projectRequest=async(endpoint,...args)=>endpoint===`/v1/code/channels/${PROJECT}/config`?{config:clone(config)}:request(endpoint,...args)
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

test('uploads are enabled only for files and the project is paused before its goal, config, and memory writes',async t=>{
  const f=await fixture(t);f.source.topic='Keep this goal.';await f.stage()
  const write=f.destination.projectWrite,newPause='2026-10-22T10:00:01Z'
  f.destination.projectWrite=async(endpoint,options)=>{
    const body=JSON.parse(options.body)
    if(endpoint.endsWith('/config')||endpoint.includes('/memories')||Object.hasOwn(body,'topic'))assert.ok(f.target.channel.disabled_at)
    const result=await write(endpoint,options)
    if(body.disabled===true)f.target.channel.disabled_at=newPause
    return result
  }
  await restoreProjectTransfer(f.destination,f.prepared)
  const writes=f.calls.filter(call=>call.kind==='target-write'),enable=writes.findIndex(call=>call.body.disabled===false),pause=writes.findIndex((call,i)=>i>enable&&call.body.disabled===true)
  assert.ok(enable>=0&&pause>enable)
  assert.ok(writes.filter(call=>call.endpoint.endsWith('/files:write')).every(call=>writes.indexOf(call)>enable&&writes.indexOf(call)<pause))
  assert.ok(writes.findIndex(call=>Object.hasOwn(call.body,'topic'))>pause)
  const receipt=JSON.parse(await readFile(path.join(f.output,'restore.json'),'utf8'))
  assert.equal(receipt.profile.disabled_at,newPause);assert.equal(Object.hasOwn(receipt,'fileUploadPhase'),false)
})

test('lost enable replies re-pause the project and retry without a duplicate project',async t=>{
  for(const when of ['before','after']){
    const f=await fixture(t);await f.stage();f.target[when==='before'?'failEnableBeforeWrite':'failEnableAfterWrite']=true
    await assert.rejects(restoreProjectTransfer(f.destination,f.prepared),/Enable response lost/)
    assert.ok(f.target.channel.disabled_at);assert.equal(f.target.files.size,0)
    assert.equal(Object.hasOwn(JSON.parse(await readFile(path.join(f.output,'restore.json'),'utf8')),'fileUploadPhase'),false)
    await restoreProjectTransfer(f.destination,f.prepared)
    assert.equal(f.target.creates,1);assert.ok(f.target.channel.disabled_at);assert.ok(f.target.files.get('result.bin').equals(f.file))
  }
})

test('a failed file upload is re-paused and lost pause replies recover from the same receipt',async t=>{
  for(const failure of ['file','pause-before','pause-after']){
    const f=await fixture(t);await f.stage()
    f.target[failure==='file'?'failAfterWrite':failure==='pause-before'?'failPauseBeforeWrite':'failPauseAfterWrite']=true
    await assert.rejects(restoreProjectTransfer(f.destination,f.prepared),/Write response lost|Pause response lost/)
    const receipt=JSON.parse(await readFile(path.join(f.output,'restore.json'),'utf8'))
    if(failure==='file'){assert.ok(f.target.channel.disabled_at);assert.equal(Object.hasOwn(receipt,'fileUploadPhase'),false)}
    else{assert.equal(receipt.fileUploadPhase.state,'pausing');assert.equal(f.target.channel.disabled_at,failure==='pause-before'?null:NOW)}
    const written=new Map(f.target.files),writeCount=f.calls.filter(call=>call.kind==='target-write'&&call.endpoint.endsWith('/files:write')).length
    await restoreProjectTransfer(f.destination,f.prepared)
    for(const [name,bytes] of written)assert.ok(f.target.files.get(name).equals(bytes))
    assert.equal(f.target.creates,1);assert.ok(f.target.channel.disabled_at)
    assert.equal(f.calls.filter(call=>call.kind==='target-write'&&call.endpoint.endsWith('/files:write')).length,writeCount+(failure==='file'?2:0))
  }
})

test('new conversation work during the upload window is kept and the project is re-paused',async t=>{
  const f=await fixture(t);await f.stage();welcomeDestination(f)
  const write=f.destination.projectWrite
  f.destination.projectWrite=async(endpoint,options)=>{const result=await write(endpoint,options);if(JSON.parse(options.body).disabled===false)f.target.hasMessages=true;return result}
  await assert.rejects(restoreProjectTransfer(f.destination,f.prepared),/new conversation work/)
  assert.ok(f.target.channel.disabled_at);assert.equal(f.target.files.size,0)
  assert.equal(f.calls.filter(call=>call.kind==='target-write'&&(call.endpoint.endsWith('/config')||call.endpoint.includes('/memories'))).length,0)
})

test('memory, file, and settings edits during uploads are kept and block remaining restore work',async t=>{
  for(const edit of ['memory','file','settings']){
    const f=await fixture(t);await f.stage();welcomeDestination(f)
    const write=f.destination.projectWrite;let changed=false
    f.destination.projectWrite=async(endpoint,options)=>{
      const result=await write(endpoint,options)
      if(!changed&&endpoint.endsWith('/files:write')){
        changed=true
        if(edit==='memory')f.target.memories.get('/MEMORY.md').content='User memory edit'
        if(edit==='file')f.target.files.set('result.bin',Buffer.from('User file edit'))
        if(edit==='settings')f.target.config.default_model='User model edit'
      }
      return result
    }
    await assert.rejects(restoreProjectTransfer(f.destination,f.prepared),/memory changed|file changed|settings changed/)
    assert.ok(f.target.channel.disabled_at)
    assert.equal(f.calls.filter(call=>call.kind==='target-write'&&(call.endpoint.endsWith('/config')||call.endpoint.includes('/memories'))).length,0)
    if(edit==='memory')assert.equal(f.target.memories.get('/MEMORY.md').content,'User memory edit')
    if(edit==='file')assert.equal(f.target.files.get('result.bin').toString(),'User file edit')
    if(edit==='settings')assert.equal(f.target.config.default_model,'User model edit')
  }
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

test('unchanged empty portable settings do not cause a config update',async t=>{
  const f=await fixture(t),desired={system_prompt_addendum:'',channel_session_model:'',channel_session_effort_level:'',default_model:'',default_effort_level:'',default_source_urls:[],memory_enabled:true}
  sourceConfiguration(f,desired);Object.assign(f.target.config,clone(desired));await f.stage()
  await restoreProjectTransfer(f.destination,f.prepared)
  assert.equal(f.calls.filter(call=>call.kind==='target-write'&&call.endpoint.endsWith('/config')).length,0)
  assert.equal((JSON.parse(await readFile(path.join(f.output,'restore.json'),'utf8'))).configApplied,true)
  for(const [key,value]of Object.entries(desired))assert.deepEqual(f.target.config[key],value)
})

test('reset portable strings and source URLs use only the supported clear flags',async t=>{
  const f=await fixture(t),desired={system_prompt_addendum:'',channel_session_model:'',channel_session_effort_level:'',default_model:'',default_effort_level:'',default_source_urls:[],memory_enabled:true}
  sourceConfiguration(f,desired)
  Object.assign(f.target.config,{system_prompt_addendum:'old instructions',channel_session_model:'old-session-model',channel_session_effort_level:'high',default_model:'old-default-model',default_effort_level:'medium',default_source_urls:['https://example.com/old'],memory_enabled:true})
  await f.stage();await restoreProjectTransfer(f.destination,f.prepared)
  const updates=f.calls.filter(call=>call.kind==='target-write'&&call.endpoint.endsWith('/config'))
  assert.equal(updates.length,1)
  assert.deepEqual(updates[0].body,{clear_system_prompt_addendum:true,clear_channel_session_model:true,clear_channel_session_effort_level:true,clear_default_model:true,clear_default_effort_level:true,clear_default_source_urls:true})
  for(const [key,value]of Object.entries(desired))assert.deepEqual(f.target.config[key],value)
})

test('changed nonempty config values are written and unchanged values are omitted',async t=>{
  const f=await fixture(t),desired={system_prompt_addendum:'new instructions',channel_session_model:'',channel_session_effort_level:'high',default_model:'new-model',default_effort_level:'medium',default_source_urls:['https://example.com/new'],memory_enabled:true}
  sourceConfiguration(f,desired)
  Object.assign(f.target.config,{system_prompt_addendum:'old instructions',channel_session_model:'',channel_session_effort_level:'medium',default_model:'old-model',default_effort_level:'medium',default_source_urls:['https://example.com/old'],memory_enabled:true})
  await f.stage();await restoreProjectTransfer(f.destination,f.prepared)
  const updates=f.calls.filter(call=>call.kind==='target-write'&&call.endpoint.endsWith('/config'))
  assert.equal(updates.length,1)
  assert.deepEqual(updates[0].body,{system_prompt_addendum:'new instructions',channel_session_effort_level:'high',default_model:'new-model',default_source_urls:['https://example.com/new']})
  for(const [key,value]of Object.entries(desired))assert.deepEqual(f.target.config[key],value)
})

test('a lost clear response recovers from the logical config without a second update',async t=>{
  const f=await fixture(t),desired={default_model:'',default_source_urls:[],memory_enabled:true}
  sourceConfiguration(f,desired);Object.assign(f.target.config,{default_model:'old-model',default_source_urls:['https://example.com/old'],memory_enabled:true});await f.stage()
  f.target.failConfigAfterWrite=true
  await assert.rejects(restoreProjectTransfer(f.destination,f.prepared),/Config response lost/)
  const pending=JSON.parse(await readFile(path.join(f.output,'restore.json'),'utf8'))
  assert.equal(pending.configPending,true)
  assert.equal(Object.hasOwn(f.target.config,'clear_default_model'),false)
  await restoreProjectTransfer(f.destination,f.prepared)
  assert.equal(f.target.creates,1)
  assert.equal(f.calls.filter(call=>call.kind==='target-write'&&call.endpoint.endsWith('/config')).length,1)
  const complete=JSON.parse(await readFile(path.join(f.output,'restore.json'),'utf8'))
  assert.equal(complete.configApplied,true);assert.equal(complete.configPending,false)
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

test('a new project is paused before its known onboarding messages and default memory are restored',async t=>{
  const f=await fixture(t);await f.stage();welcomeDestination(f)
  const result=await restoreProjectTransfer(f.destination,f.prepared),saved=JSON.parse(await readFile(path.join(f.output,'restore.json'),'utf8'))
  assert.equal(result.restored,true);assert.equal(f.target.creates,1)
  assert.equal(saved.bootstrapMessages.length,2);assert.equal(saved.bootstrapMemory.id,'mem_bootstrap')
  assert.equal(saved.bootstrapMemory.updatedBySession,'session_destination')
  assert.equal(f.target.rows.length,2)
  assert.match(f.target.memories.get('/MEMORY.md').content,/migration\/chan_source\/main-transcript\.md/)
  const writes=f.calls.filter(call=>call.kind==='target-write'),replacement=writes.find(call=>call.endpoint.endsWith('/memories/mem_bootstrap'))
  assert.deepEqual(replacement.body.precondition,{type:'content_sha256',content_sha256:saved.bootstrapMemory.content_sha256})
  const pause=f.calls.findIndex(call=>call.kind==='target-write'&&call.endpoint==='/v1/code/channels/chan_target')
  const conversation=f.calls.findIndex(call=>call.kind==='target-read'&&call.endpoint.includes('/threads?'))
  assert.ok(pause>=0&&conversation>pause)
  await restoreProjectTransfer(f.destination,f.prepared)
  assert.equal(f.target.creates,1);assert.equal(f.calls.filter(call=>call.kind==='target-write'&&call.endpoint.endsWith('/memories/mem_bootstrap')).length,1)
})

test('an onboarding notice can be the only automatic destination message',async t=>{
  const f=await fixture(t);await f.stage();welcomeDestination(f,{starter:false,memory:false})
  assert.equal((await restoreProjectTransfer(f.destination,f.prepared)).restored,true)
  assert.equal((JSON.parse(await readFile(path.join(f.output,'restore.json'),'utf8'))).bootstrapMessages.length,1)
})

test('the skipped-setup onboarding subset is accepted as the only welcome and restored safely',async t=>{
  const f=await fixture(t);await f.stage();welcomeDestination(f,{starter:false,memory:false})
  const write=f.destination.projectWrite
  f.destination.projectWrite=async(endpoint,...args)=>{
    const value=await write(endpoint,...args)
    if(endpoint==='/v1/code/channels'){
      const notice=f.target.rows[0],body=JSON.parse(notice.body)
      body.setup_turn='skipped';body.card={version:1,variant:'code',rows:[{key:'connect_code'},{key:'plan_project'}]};notice.body=JSON.stringify(body)
      assert.equal((await assertDestinationConversation(f.destination,f.target.channel)).length,1)
    }
    return value
  }
  assert.equal((await restoreProjectTransfer(f.destination,f.prepared)).restored,true)
  const saved=JSON.parse(await readFile(path.join(f.output,'restore.json'),'utf8'))
  assert.equal((await assertDestinationConversation(f.destination,f.target.channel,saved.bootstrapMessages)).length,1)
  const notice=f.target.rows[0],body=JSON.parse(notice.body)
  for(const rows of [[],[{key:'connect_code'},{key:'connect_code'}],[{key:'unknown_operation'}]]){
    notice.body=JSON.stringify({...body,card:{...body.card,rows}})
    await assert.rejects(assertDestinationConversation(f.destination,f.target.channel),/new conversation work/)
  }
  notice.body=JSON.stringify({...body,text:'Changed welcome'})
  await assert.rejects(assertDestinationConversation(f.destination,f.target.channel,saved.bootstrapMessages),/new conversation work/)
})

test('the source goal is set only after the new project is paused and its welcome is recorded',async t=>{
  const f=await fixture(t);f.source.topic='Keep the original project goal.';f.source.icon='Globe';f.source.color='blue';await f.stage();welcomeDestination(f)
  await restoreProjectTransfer(f.destination,f.prepared)
  const created=f.calls.find(call=>call.kind==='target-write'&&call.endpoint==='/v1/code/channels')
  assert.equal(Object.hasOwn(created.body,'topic'),false)
  assert.equal(created.body.icon,'Globe');assert.equal(created.body.color,'blue')
  const pause=f.calls.findIndex(call=>call.kind==='target-write'&&call.endpoint==='/v1/code/channels/chan_target'&&call.body.disabled===true)
  const welcome=f.calls.findIndex(call=>call.kind==='target-read'&&call.endpoint.includes('/timeline?'))
  const goal=f.calls.findIndex(call=>call.kind==='target-write'&&call.endpoint==='/v1/code/channels/chan_target'&&call.body.topic===f.source.topic)
  const config=f.calls.findIndex(call=>call.kind==='target-write'&&call.endpoint.endsWith('/config'))
  assert.ok(pause>=0&&welcome>pause&&goal>welcome&&config>goal)
  assert.equal(f.target.channel.topic,f.source.topic)
  const receipt=JSON.parse(await readFile(path.join(f.output,'restore.json'),'utf8'))
  assert.equal(receipt.profile.topic,f.source.topic);assert.equal(Object.hasOwn(receipt,'metadataPending'),false)
  assert.equal(receipt.bootstrapMessages.length,2)
})

test('lost goal responses retry the same paused project and adopt an applied goal without a second write',async t=>{
  for(const when of ['before','after']){
    const f=await fixture(t);f.source.topic='Keep the original project goal.';await f.stage();welcomeDestination(f)
    f.target[when==='before'?'failTopicBeforeWrite':'failTopicAfterWrite']=true
    await assert.rejects(restoreProjectTransfer(f.destination,f.prepared),/Goal response lost/)
    const pending=JSON.parse(await readFile(path.join(f.output,'restore.json'),'utf8'))
    assert.equal(pending.metadataPending.topic,f.source.topic)
    assert.equal(pending.profile.topic,null)
    await restoreProjectTransfer(f.destination,f.prepared)
    assert.equal(f.target.creates,1);assert.equal(f.target.channel.topic,f.source.topic)
    assert.equal(f.calls.filter(call=>call.kind==='target-write'&&Object.hasOwn(call.body,'topic')).length,when==='before'?2:1)
    const receipt=JSON.parse(await readFile(path.join(f.output,'restore.json'),'utf8'))
    assert.equal(receipt.profile.topic,f.source.topic);assert.equal(Object.hasOwn(receipt,'metadataPending'),false)
  }
})

test('a user goal edit after a lost goal response is kept and blocks further restore writes',async t=>{
  const f=await fixture(t);f.source.topic='Keep the original project goal.';await f.stage();welcomeDestination(f);f.target.failTopicAfterWrite=true
  await assert.rejects(restoreProjectTransfer(f.destination,f.prepared),/Goal response lost/)
  f.target.channel.topic='The user changed this goal.'
  const writes=f.calls.filter(call=>call.kind==='target-write').length
  await assert.rejects(restoreProjectTransfer(f.destination,f.prepared),/changed before its goal update completed/)
  assert.equal(f.target.channel.topic,'The user changed this goal.')
  assert.equal(f.calls.filter(call=>call.kind==='target-write').length,writes)
  assert.equal(f.target.creates,1);assert.ok(f.target.files.get('result.bin').equals(f.file))
})

test('the destination coordinator can finish stopping before the bootstrap baseline is read',async t=>{
  const f=await fixture(t);await f.stage();welcomeDestination(f)
  let checks=0;f.destination.session=async id=>({id,status:'active',worker_status:++checks===1?'running':'idle'})
  await restoreProjectTransfer(f.destination,f.prepared)
  assert.ok(checks>=2)
})

test('a provisioning destination coordinator is polled until its state is known and idle',async t=>{
  const f=await fixture(t);await f.stage();welcomeDestination(f)
  let checks=0;f.destination.session=async id=>++checks===1?{id}:{id,status:'active',worker_status:'idle'}
  await restoreProjectTransfer(f.destination,f.prepared)
  assert.ok(checks>=2);assert.ok(f.target.channel.disabled_at)
})

test('a lost default-memory replacement response is recovered without a second update or project',async t=>{
  const f=await fixture(t);await f.stage();welcomeDestination(f);f.target.failMemoryAfterWrite=true
  await assert.rejects(restoreProjectTransfer(f.destination,f.prepared),/Memory response lost/)
  await restoreProjectTransfer(f.destination,f.prepared)
  assert.equal(f.target.creates,1)
  assert.equal(f.calls.filter(call=>call.kind==='target-write'&&call.endpoint.endsWith('/memories/mem_bootstrap')).length,1)
})

test('real user or agent work and unfamiliar onboarding data cannot become a restore baseline',async t=>{
  for(const kind of ['human','agent-work','binding','thread','wrong-agent','wrong-session','card','starter-only']){
    const f=await fixture(t);await f.stage();welcomeDestination(f,{notice:kind!=='starter-only'})
    const write=f.destination.projectWrite
    f.destination.projectWrite=async(endpoint,...args)=>{
      const value=await write(endpoint,...args)
      if(endpoint==='/v1/code/channels'){
        const starter=f.target.rows.at(-1)
        if(kind==='human')starter.author_account_id=TARGET
        if(kind==='agent-work')starter.body='I started other work.'
        if(kind==='binding')starter.bound_sessions=[{id:'cse_other'}]
        if(kind==='thread')f.target.roots=[{id:'cmsg_realThread',bound_sessions:[]}]
        if(kind==='wrong-agent')starter.author_agent_id='cagt_other'
        if(kind==='wrong-session')starter.author_session_id='cse_other'
        if(kind==='card'){const notice=JSON.parse(f.target.rows[0].body);notice.card.rows.push({key:'new_operation'});f.target.rows[0].body=JSON.stringify(notice)}
      }
      return value
    }
    await assert.rejects(restoreProjectTransfer(f.destination,f.prepared),/new conversation work/,kind)
    assert.equal(f.target.files.size,0);assert.equal(f.target.channel.disabled_at,NOW)
    assert.equal(f.calls.filter(call=>call.kind==='target-write'&&call.endpoint.includes('/memories')).length,0)
  }
})

test('a changed recorded welcome or default memory stops a retry without overwriting the edit',async t=>{
  for(const kind of ['welcome','memory','memory-owner']){
    const f=await fixture(t);await f.stage();welcomeDestination(f)
    if(kind==='welcome'){
      await restoreProjectTransfer(f.destination,f.prepared)
      const notice=JSON.parse(f.target.rows[0].body);notice.text='Changed welcome';f.target.rows[0].body=JSON.stringify(notice)
    }else{
      const write=f.destination.projectWrite
      f.destination.projectWrite=async(endpoint,...args)=>{
        const value=await write(endpoint,...args)
        if(endpoint.endsWith('/config')){
          const memory=f.target.memories.get('/MEMORY.md')
          if(kind==='memory')memory.content='User memory edit'
          else memory.updated_by={type:'account',account_id:TARGET}
        }
        return value
      }
    }
    await assert.rejects(restoreProjectTransfer(f.destination,f.prepared),/new conversation work|default destination memory changed/,kind)
    if(kind==='memory')assert.equal(f.target.memories.get('/MEMORY.md').content,'User memory edit')
    assert.equal(f.calls.filter(call=>call.kind==='target-write'&&call.endpoint.endsWith('/memories/mem_bootstrap')).length,kind==='welcome'?1:0)
  }
})

test('conversation checks require the exact recorded automatic messages',async t=>{
  const f=await fixture(t);await f.stage();welcomeDestination(f)
  await restoreProjectTransfer(f.destination,f.prepared)
  const saved=JSON.parse(await readFile(path.join(f.output,'restore.json'),'utf8'))
  assert.deepEqual(await assertDestinationConversation(f.destination,f.target.channel,saved.bootstrapMessages),saved.bootstrapMessages)
  await assert.rejects(assertDestinationConversation(f.destination,f.target.channel,[]),/new conversation work/)
  f.target.rows.pop()
  await assert.rejects(assertDestinationConversation(f.destination,f.target.channel,saved.bootstrapMessages),/new conversation work/)
})

test('a known onboarding card can change layout without changing its recorded welcome message',async t=>{
  const f=await fixture(t);await f.stage();welcomeDestination(f)
  await restoreProjectTransfer(f.destination,f.prepared)
  const saved=JSON.parse(await readFile(path.join(f.output,'restore.json'),'utf8')),notice=f.target.rows.find(row=>row.server_notice),body=JSON.parse(notice.body)
  body.card={version:1,variant:'code',rows:['next_steps','build_check','next_feature'].map(key=>({key,label:`Generated ${key}`,action:'start',prompt:`Generated suggestion ${key}`}))}
  notice.body=JSON.stringify(body)
  assert.equal((await assertDestinationConversation(f.destination,f.target.channel,saved.bootstrapMessages)).length,2)
  await restoreProjectTransfer(f.destination,f.prepared)
  assert.equal(f.target.creates,1)
  body.text='Changed welcome text';notice.body=JSON.stringify(body)
  await assert.rejects(assertDestinationConversation(f.destination,f.target.channel,saved.bootstrapMessages),/new conversation work/)
  body.text='Welcome';body.card.rows[0].key='unknown_suggestion';notice.body=JSON.stringify(body)
  await assert.rejects(assertDestinationConversation(f.destination,f.target.channel,saved.bootstrapMessages),/new conversation work/)
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
  assert.ok(f.calls.some(call=>call.kind==='target-read'&&call.endpoint.endsWith('/files:open')))
  await restoreProjectTransfer(f.destination,f.prepared)
  assert.equal(f.target.uploads,1)
})
