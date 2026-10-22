import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp, mkdir, realpath, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {collectProject,loadArtifactExports,readProjectFileBytes} from './project-source.mjs'
import {writeCaptureBundle, verifyCaptureBundle} from './project-workflow.mjs'

const ACCOUNT='11111111-1111-4111-8111-111111111111'
const ORG='22222222-2222-4222-8222-222222222222'
const PROJECT='chan_testProject'
const THREAD='cmsg_testThread'
const sha=value=>createHash('sha256').update(value).digest('hex')
const clone=value=>JSON.parse(JSON.stringify(value))
function fixture(overrides={}) {
  const calls=[]
  const root={id:THREAD,channel_id:PROJECT,thread_root_id:THREAD,reply_count:'1',last_reply_at:'2026-10-22T10:00:00Z',thread_status:'idle',bound_sessions:[{id:'cse_worker',title:'A thread'}]}
  const index={sections:[{status:'idle',count:'1',data:[root]}],truncated:false}
  const channel={id:PROJECT,name:'Founderizer',thread_count:'1',overview_session_id:'cse_coordinator',last_message_seq:'3',last_timeline_seq:'3'}
  const memory='# Saved memory\n'
  const client={account:ACCOUNT,org:ORG,
    async projectRequest(endpoint,options={}) {
      calls.push({endpoint,options})
      const u=new URL(endpoint,'https://claude.ai'),suffix=u.pathname.replace(`/v1/code/channels/${PROJECT}`,'')
      if(overrides.request){const v=await overrides.request(u,options,calls);if(v!==undefined)return clone(v)}
      if(u.pathname===`/v1/code/memory/channel/${PROJECT}/memories`)return {data:[{id:'mem_saved',path:'/MEMORY.md',content_sha256:sha(memory)}],prefixes:[]}
      if(u.pathname.endsWith('/memories/mem_saved'))return {content:memory,content_sha256:sha(memory)}
      if(suffix==='')return {channel:clone(channel)}
      if(suffix==='/config')return {config:{default_model:'model',limit_auto_continue:true}}
      if(suffix==='/threads')return clone(index)
      if(suffix==='/timeline')return {data:[{id:'cmsg_main',body:'Main conversation'}],has_more:false}
      if(suffix===`/threads/${THREAD}`)return {data:[{id:THREAD,body:'Task'},{id:'cmsg_reply',body:'Done'}],has_more:false}
      if(suffix==='/files:list')return {entries:[{path:'/result.txt',is_directory:false,size_bytes:6}]}
      if(suffix==='/files:open')return {type:'text',content:'result',size_bytes:6}
      if(suffix==='/artifacts'||suffix==='/attachments')return {data:[],truncated:false}
      throw new Error('Unexpected synthetic request')
    },
    async session(id){return {id,title:id,created_at:'2026-10-22T10:00:00Z',access_token:'do not capture',session_context:{secret_key:'do not capture'}}},
    async eventRows(id){if(overrides.events)return overrides.events(id);return [{event_type:'message',sequence_num:'1',payload:{type:'assistant',message:{content:`events for ${id}`}}}]}
  }
  return {client,calls,index,root,channel,memory}
}

test('large project files are read in exact byte ranges with one content revision',async()=>{
  const bytes=Buffer.alloc(16*1024*1024+7,5),requests=[]
  const client={async projectRequest(endpoint,options){
    assert.equal(endpoint,`/v1/code/channels/${PROJECT}/files:open`)
    const body=JSON.parse(options.body);requests.push(body)
    if(body.range_offset===undefined)return{type:'unsupported',reason:'too_large',size_bytes:String(bytes.length)}
    return{type:'download',size_bytes:String(bytes.length),content_revision:'revision1',data:bytes.subarray(body.range_offset,body.range_offset+body.range_length).toString('base64')}
  }}
  const value=await readProjectFileBytes(client,PROJECT,'/large.bin')
  assert.ok(value.bytes.equals(bytes));assert.equal(value.revision,'revision1')
  assert.deepEqual(requests,[{path:'/large.bin'},{path:'/large.bin',range_offset:0,range_length:16*1024*1024},{path:'/large.bin',range_offset:16*1024*1024,range_length:7}])
})

test('ranged reads reject changed size or revision, partial chunks, bad encoding, and invalid bounds',async()=>{
  for(const change of ['size','revision','short','encoding','offset','length','truncated','missing-revision','bound']){
    let ranges=0
    const client={async projectRequest(endpoint,options){
      const body=JSON.parse(options.body)
      if(body.range_offset===undefined)return{type:'unsupported',reason:'too_large',size_bytes:change==='bound'?'480000001':'2'}
      ranges++
      const value={type:'download',size_bytes:'2',content_revision:'revision1',data:Buffer.from('ok').toString('base64')}
      if(change==='size')value.size_bytes='3'
      if(change==='revision'||change==='missing-revision')delete value.content_revision
      if(change==='short')value.data=Buffer.from('o').toString('base64')
      if(change==='encoding')value.data='b2t='
      if(change==='offset')value.range_offset=1
      if(change==='length')value.range_length=1
      if(change==='truncated')value.truncated=true
      return value
    }}
    await assert.rejects(readProjectFileBytes(client,PROJECT,'/large.bin'),/Library|Output bytes/,change)
    assert.equal(ranges,change==='bound'?0:1)
  }
  const bytes=Buffer.alloc(16*1024*1024+1),client={async projectRequest(endpoint,options){
    const body=JSON.parse(options.body)
    return body.range_offset===undefined?{type:'unsupported',reason:'too_large',size_bytes:bytes.length}:{type:'download',size_bytes:bytes.length,content_revision:body.range_offset===0?'first':'changed',data:bytes.subarray(body.range_offset,body.range_offset+body.range_length).toString('base64')}
  }}
  await assert.rejects(readProjectFileBytes(client,PROJECT,'/large.bin'),/revision or byte length changed/)
})

test('project capture uses range bytes and checks their final revision',async()=>{
  const bytes=Buffer.from('range bytes'),{client,calls}=fixture({request(u,options){
    if(u.pathname.endsWith('/files:list'))return{entries:[{path:'/result.txt',size_bytes:bytes.length}]}
    if(u.pathname.endsWith('/files:open')){
      const body=JSON.parse(options.body)
      if(body.range_offset===undefined)return{type:'unsupported',reason:'too_large',size_bytes:String(bytes.length)}
      return{type:'download',size_bytes:String(bytes.length),content_revision:'revision1',data:bytes.subarray(body.range_offset,body.range_offset+body.range_length).toString('base64')}
    }
  }})
  const capture=await collectProject(client,{},PROJECT)
  assert.ok(capture.complete.library);assert.ok(capture.libraryFiles[0].bytes.equals(bytes))
  assert.ok(calls.some(call=>call.endpoint.endsWith('/files:open')&&JSON.parse(call.options.body).range_length===1))
})

test('collects source history, bytes and exact session IDs in a valid complete bundle',async()=>{
  const {client,calls}=fixture(),capture=await collectProject(client,{},PROJECT)
  assert.equal(capture.source.title,'Founderizer')
  assert.deepEqual(capture.expectedThreadIds,[THREAD])
  assert.equal(capture.threads[0].sessionEvents[0].id,'cse_worker')
  assert.equal(capture.coordinator.sessionEvents[0].id,'cse_coordinator')
  assert.equal(capture.memoryFiles[0].bytes.toString(),'# Saved memory\n')
  assert.equal(capture.libraryFiles[0].bytes.toString(),'result')
  assert.ok(Object.values(capture.complete).every(Boolean))
  assert.deepEqual(capture.missing,[])
  assert.equal(capture.threads[0].sessionEvents[0].metadata.access_token,undefined)
  assert.equal(capture.threads[0].sessionEvents[0].metadata.session_context,undefined)
  assert.ok(calls.every(call=>call.options.method!=='POST'||/files:(list|open)$/.test(call.endpoint)))
  const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'project-source-')))
  try{const result=await writeCaptureBundle(path.join(dir,'capture'),capture);assert.equal(result.complete,true);assert.equal((await verifyCaptureBundle(result.path)).complete,true)}finally{await rm(dir,{recursive:true,force:true})}
})

test('reads opaque cursors and all memory prefixes without a numeric first page',async()=>{
  const {client,calls}=fixture({request(u){
    if(u.pathname.endsWith('/timeline'))return u.searchParams.get('cursor')==='opaque-page'?{data:[{id:'cmsg_old'}],has_more:false}:{data:[{id:'cmsg_new'}],next_cursor:'opaque-page',has_more:true}
    if(u.pathname.endsWith('/memories')){
      assert.equal(u.searchParams.has('page'),false)
      return u.searchParams.get('path_prefix')?{data:[],prefixes:[]}:{data:[],prefixes:['/notes/']}
    }
  }})
  const capture=await collectProject(client,{},PROJECT)
  assert.deepEqual(capture.coordinator.history.data.map(row=>row.id),['cmsg_new','cmsg_old'])
  assert.equal(capture.memoryFiles.length,0)
  assert.ok(calls.some(call=>call.endpoint.includes('path_prefix=%2Fnotes%2F')))
  assert.deepEqual(capture.missing,[])
})

test('an empty project needs no coordinator session but existing conversation work does',async()=>{
  for(const empty of [true,false]){
    const {client,channel}=fixture({request(u){
      if(u.pathname.endsWith('/threads'))return{sections:[],truncated:false}
      if(empty&&u.pathname.endsWith('/timeline'))return{data:[],has_more:false}
    }})
    delete channel.overview_session_id
    client.session=async()=>assert.fail('An empty project has no session to read')
    const capture=await collectProject(client,{},PROJECT)
    assert.equal(capture.complete.coordinator,empty)
    assert.deepEqual(capture.threads,[])
    assert.deepEqual(capture.coordinator.sessionEvents,[])
    if(!empty)assert.ok(capture.missing.some(value=>value.includes('coordinator session ID is missing')))
  }
})

test('fails closed on a repeated history cursor and missing worker events',async()=>{
  const {client}=fixture({request(u){if(u.pathname.endsWith(`/threads/${THREAD}`))return {data:[{id:THREAD}],next_cursor:'same',has_more:true}},events(id){if(id==='cse_worker')throw new Error('transport detail must not appear');return []}})
  const capture=await collectProject(client,{},PROJECT)
  assert.equal(capture.complete.threads,false)
  assert.ok(capture.missing.some(row=>row.includes('history')))
  assert.ok(capture.missing.some(row=>row.includes('events')))
  assert.ok(capture.missing.every(row=>!row.includes('transport detail')))
})

test('reports changed source thread graph and memory without claiming completeness',async()=>{
  let reads=0,mem=0
  const {client}=fixture({request(u){
    if(u.pathname.endsWith('/threads')){reads++;return {sections:[{status:'idle',count:'1',data:[{id:THREAD,thread_root_id:THREAD,reply_count:reads===1?'1':'2',bound_sessions:[]}]}],truncated:false}}
    if(u.pathname.endsWith('/memories')){mem++;return {data:mem===1?[]:[{id:'mem_new',path:'/NEW.md',content_sha256:sha('new')}],prefixes:[]}}
  }})
  const capture=await collectProject(client,{},PROJECT)
  assert.equal(capture.complete.roots,false)
  assert.equal(capture.complete.threads,false)
  assert.equal(capture.complete.memory,false)
  assert.ok(capture.missing.some(row=>row.includes('changed during capture')))
})

test('matches local transcripts by bridge ID and captures bytes without title matching',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'project-source-local-'))
  const recordId='local_33333333-3333-4333-8333-333333333333',sessionId='44444444-4444-4444-8444-444444444444'
  const paths={records:path.join(dir,'records'),pool:path.join(dir,'pool')},cwd='/source/repo',bytes=Buffer.from('{"type":"assistant","text":"source bytes"}\n')
  try{
    await mkdir(path.join(paths.records,ACCOUNT,ORG),{recursive:true})
    await mkdir(path.join(paths.pool,'-source-repo'),{recursive:true})
    await writeFile(path.join(paths.records,ACCOUNT,ORG,'local_55555555-5555-4555-8555-555555555555.json'),'{not valid JSON')
    await writeFile(path.join(paths.records,ACCOUNT,ORG,`${recordId}.json`),JSON.stringify({sessionId:recordId,cliSessionId:sessionId,cwd,bridgeSessionIds:['cse_worker'],title:'Old title'}))
    await writeFile(path.join(paths.pool,'-source-repo',`${sessionId}.jsonl`),bytes)
    const {client}=fixture(),capture=await collectProject(client,paths,PROJECT)
    assert.equal(capture.complete.localTranscripts,true)
    assert.deepEqual(capture.localTranscripts,[{threadId:THREAD,recordId,sessionId,bytes}])
  }finally{await rm(dir,{recursive:true,force:true})}
})

test('keeps empty real memory empty and marks unresolved artifact content as missing',async()=>{
  const {client}=fixture({request(u){if(u.pathname.endsWith('/memories'))return {data:[],prefixes:[]};if(u.pathname.endsWith('/artifacts'))return {data:[{slug:'published-output',title:'Output'}],total:1,truncated:false}}})
  const capture=await collectProject(client,{},PROJECT)
  assert.equal(capture.memoryFiles.length,0)
  assert.equal(capture.complete.memory,true)
  assert.equal(capture.complete.library,false)
  assert.ok(capture.missing.some(row=>row.includes('content route is not supported')))
})


test('retries changed worker events once and ignores placeholder project counts',async()=>{
  const {client,channel}=fixture();channel.thread_count='0';let workerReads=0,workerEvents=0
  client.session=async id=>({id,last_event_at:id==='cse_worker'&&workerReads++>0?'new':'old'})
  client.eventRows=async id=>[{payload:{message:id==='cse_worker'?`worker-${++workerEvents}`:'coordinator'}}]
  const capture=await collectProject(client,{},PROJECT)
  assert.equal(capture.complete.roots,true)
  assert.equal(capture.complete.threads,true)
  assert.equal(workerEvents,2)
  assert.equal(capture.threads[0].sessionEvents[0].events[0].payload.message,'worker-2')
})

test('captures artifact hook bytes and every attached output reference',async()=>{
  const {client}=fixture({request(u){
    if(u.pathname.endsWith('/artifacts'))return {data:[{slug:'public-output',title:'Report'}],total:1,truncated:false}
    if(u.pathname.endsWith(`/threads/${THREAD}`))return {data:[{id:THREAD,attached_outputs:[{id:'output1',filename:'report.txt'}]}]}
    if(u.pathname.endsWith('/attached_outputs/output1'))return {type:'download',data:Buffer.from('output').toString('base64')}
  }})
  client.projectArtifact=async slug=>({bytes:Buffer.from('<html>artifact</html>'),metadata:{slug}})
  const capture=await collectProject(client,{},PROJECT)
  assert.equal(capture.complete.library,true)
  assert.equal(capture.libraryFiles.find(row=>row.id==='artifact-public-output').bytes.toString(),'<html>artifact</html>')
  assert.equal(capture.libraryFiles.find(row=>row.id==='output-output1').bytes.toString(),'output')
})

test('verifies the final native report body even when its index timestamp stays the same',async()=>{
  const id='33333333-3333-4333-8333-333333333333'
  for(const changed of [false,true]){
    const {client}=fixture({request(u){if(u.pathname.endsWith('/artifacts'))return {data:[{slug:id,title:'Report',updated_at:'2026-10-22T10:00:00Z'}],total:1,truncated:false}}})
    let reads=0
    client.projectArtifact=async()=>({metadata:{nativeStateCaptured:true,captureFormat:'native-state-json',contentSha256:sha(changed&&reads++?'changed':'current')},files:[{path:'native-state.json',bytes:Buffer.from('current native values')}]})
    const capture=await collectProject(client,{},PROJECT)
    assert.equal(capture.complete.library,!changed)
    assert.equal(capture.libraryFiles.find(row=>row.originalPath===`artifacts/${id}/native-state.json`).nativeStateCaptured,true)
    if(changed)assert.ok(capture.missing.some(row=>row.includes('native state changed')))
  }
})

test('Pages reports require a current explicit content export and preserve its text limit',async()=>{
  const id='77777777-7777-4777-8777-777777777777',updatedAt='2026-10-22T10:00:00Z',bytes=Buffer.from('Full report text and original links')
  const {client}=fixture({request(u){
    if(u.pathname.endsWith('/artifacts'))return {data:[{slug:id,title:'Report',updated_at:updatedAt}],total:1,truncated:false}
    if(u.pathname.endsWith(`/threads/${THREAD}`))return {data:[{id:THREAD,attached_outputs:[{id:`${THREAD}.0`,kind:'frame',frame_slug:id},{kind:'link',href:'https://example.com'}]}]}
  }})
  client.projectArtifact=async()=>({requiresContentExport:true,metadata:{id,updatedAt,contentStore:'pages'}})
  const absent=await collectProject(client,{},PROJECT)
  assert.equal(absent.complete.library,false)
  const stale=await collectProject(client,{},PROJECT,{artifactExports:new Map([[id,{bytes,updatedAt:'2026-10-21T10:00:00Z'}]])})
  assert.equal(stale.complete.library,false)
  const saved=await collectProject(client,{},PROJECT,{artifactExports:new Map([[id,{bytes,updatedAt}]])})
  assert.equal(saved.complete.library,true)
  assert.equal(saved.limitations.length,1)
  assert.equal(saved.libraryFiles.find(file=>file.id===`artifact-${id}-text`).nativeStateCaptured,false)
})

test('a live report exporter reads current content and cannot fall back to an older export',async()=>{
  const id='77777777-7777-4777-8777-777777777777',updatedAt='2026-10-22T11:00:00Z',bytes=Buffer.from('Current report text')
  const {client}=fixture({request(u){if(u.pathname.endsWith('/artifacts'))return {data:[{slug:id,title:'Report',updated_at:updatedAt}],total:1,truncated:false}}})
  client.projectArtifact=async()=>({requiresContentExport:true,metadata:{id,updatedAt,contentStore:'pages'}})
  const calls=[]
  const saved=await collectProject(client,{},PROJECT,{artifactExports:new Map([[id,{bytes:Buffer.from('Old text'),updatedAt:'2026-10-21T10:00:00Z'}]]),exportArtifact:async request=>{calls.push(request);return {bytes,updatedAt}}})
  assert.equal(saved.complete.library,true)
  assert.equal(saved.libraryFiles.find(file=>file.id===`artifact-${id}-text`).bytes.toString(),'Current report text')
  assert.equal(calls.length,1)
  assert.equal(calls[0].projectId,PROJECT)
  assert.equal(calls[0].id,id)
  assert.equal(calls[0].metadata.updatedAt,updatedAt)
  assert.equal(calls[0].indexEntry.slug,id)
  const stale=await collectProject(client,{},PROJECT,{artifactExports:new Map([[id,{bytes,updatedAt}]]),exportArtifact:async()=>({bytes,updatedAt:'2026-10-21T10:00:00Z'})})
  assert.equal(stale.complete.library,false)
  assert.equal(stale.libraryFiles.some(file=>file.id===`artifact-${id}-text`),false)
})

test('changed report or attachment indexes prevent a complete capture',async()=>{
  for(const kind of ['artifacts','attachments']){
    let reads=0
    const {client}=fixture({request(u){if(u.pathname.endsWith(`/${kind}`))return {data:++reads===1?[]:[{slug:'new-report',file_id:'new-file'}],total:reads===1?0:1,truncated:false}}})
    const capture=await collectProject(client,{},PROJECT)
    assert.equal(capture.complete.library,false,kind)
    assert.ok(capture.missing.some(row=>row.includes(`${kind.slice(0,-1)} index changed during capture`)))
  }
})

test('changed project metadata prevents a complete capture',async()=>{
  let reads=0
  const {client,channel}=fixture({request(u){if(u.pathname===`/v1/code/channels/${PROJECT}`)return {channel:{...channel,name:++reads===1?'Founderizer':'New project name'}}}})
  const capture=await collectProject(client,{},PROJECT)
  assert.equal(capture.source.title,'Founderizer')
  assert.equal(capture.complete.channel,false)
  assert.ok(capture.missing.some(row=>row.includes('project metadata changed during capture')))
})

test('changed thread titles and states prevent a complete capture without new replies',async()=>{
  for(const change of [{display_name:'Renamed task'},{thread_status:'resolved'}]){
    let reads=0
    const {client,index}=fixture({request(u){if(u.pathname.endsWith('/threads')){const value=clone(index);if(++reads===2)Object.assign(value.sections[0].data[0],change);return value}}})
    const capture=await collectProject(client,{},PROJECT)
    assert.equal(capture.complete.roots,false)
    assert.equal(capture.complete.threads,false)
  }
})

test('a linked local transcript that grows during capture prevents completeness',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'project-source-growing-'))
  const recordId='local_33333333-3333-4333-8333-333333333333',sessionId='44444444-4444-4444-8444-444444444444'
  const paths={records:path.join(dir,'records'),pool:path.join(dir,'pool')},cwd='/source/repo',bytes=Buffer.from('{"type":"assistant","text":"Initial state"}\n')
  const file=path.join(paths.pool,'-source-repo',`${sessionId}.jsonl`)
  let reads=0
  try{
    await mkdir(path.join(paths.records,ACCOUNT,ORG),{recursive:true})
    await mkdir(path.dirname(file),{recursive:true})
    await writeFile(path.join(paths.records,ACCOUNT,ORG,`${recordId}.json`),JSON.stringify({sessionId:recordId,cliSessionId:sessionId,cwd,bridgeSessionIds:['cse_worker']}))
    await writeFile(file,bytes)
    const {client}=fixture({async request(u){if(u.pathname===`/v1/code/channels/${PROJECT}`&&++reads===2)await writeFile(file,Buffer.concat([bytes,Buffer.from('{"type":"assistant","text":"Later state"}\n')]))}})
    const capture=await collectProject(client,paths,PROJECT)
    assert.equal(capture.localTranscripts[0].bytes.toString(),bytes.toString())
    assert.equal(capture.complete.localTranscripts,false)
    assert.ok(capture.missing.some(row=>row.includes('local transcript changed during capture')))
  }finally{await rm(dir,{recursive:true,force:true})}
})

test('artifact export loader rejects a different project, changed bytes, and path traversal',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'project-text-exports-'))
  const id='77777777-7777-4777-8777-777777777777',file=`${id}.txt`,bytes=Buffer.from('Original report')
  const manifest={schemaVersion:1,projectId:PROJECT,artifacts:[{id,file,format:'text',updatedAt:'2026-10-22T10:00:00Z',sha256:sha(bytes)}]}
  try{
    await writeFile(path.join(dir,file),bytes,{mode:0o600})
    const save=()=>writeFile(path.join(dir,'artifacts.json'),JSON.stringify(manifest),{mode:0o600})
    await save()
    assert.equal((await loadArtifactExports(dir,PROJECT)).get(id).bytes.toString(),'Original report')
    await assert.rejects(loadArtifactExports(dir,'chan_other'),/do not match/)
    await writeFile(path.join(dir,file),'Changed')
    await assert.rejects(loadArtifactExports(dir,PROJECT),/failed verification/)
    manifest.artifacts[0].file='../report.txt';await save()
    await assert.rejects(loadArtifactExports(dir,PROJECT),/Invalid artifact/)
  }finally{await rm(dir,{recursive:true,force:true})}
})
