import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, readFile, writeFile, mkdir, rm, readdir, stat, chmod, symlink, realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {writeCaptureBundle,verifyCaptureBundle,prepareProjectRestore,preflightRestoreUploads} from './project-workflow.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()),'project-capture-test-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const capture = {
    schemaVersion:1,
    source:{accountId:'00000000-0000-4000-8000-000000000001',organizationId:'00000000-0000-4000-8000-000000000002',projectId:'chan_project1',title:'Project',capturedAt:'2026-10-22T10:00:00Z'},
    channel:{id:'chan_project1',title:'Project',settings:{effort:'max'}},
    roots:[{id:'root_1',thread_ids:['thread_1','thread_2']}],
    coordinator:{history:[{role:'user',content:'Main task'}],sessionEvents:[]},
    expectedThreadIds:['thread_2','thread_1'],
    threads:[
      {id:'thread_2',title:'Same title',status:'resolved',history:[{role:'assistant',content:'Done'}],sessionEvents:[]},
      {id:'thread_1',title:'Same title',status:'idle',sessionId:'cse_session1',history:[{role:'user',content:'Use `apiKey` in the example.\n```\ncode\n```'}],sessionEvents:[{event_type:'assistant',payload:{message:{content:[{type:'text',text:'Result'}]},token_usage:{input_tokens:10}}}]}
    ],
    memoryFiles:[{path:'/MEMORY.md',bytes:Buffer.from('# Existing memory\nKeep this exactly.\n')},{path:'/notes/work.md',bytes:Buffer.from('Current task\n')}],
    libraryFiles:[{id:'file_1',name:'data.bin',originalPath:'/docs/data.bin',bytes:Buffer.from([0,255,1,128])}],
    localTranscripts:[{threadId:'thread_1',recordId:'local_record1',sessionId:'session_1',bytes:Buffer.from('{"type":"user","message":{"content":"Task"}}\n')}],
    complete:{channel:true,roots:true,coordinator:true,threads:true,memory:true,library:true,localTranscripts:true},
    missing:[]
  }
  return {root,capture,bundle:path.join(root,'capture'),prepared:path.join(root,'prepared')}
}

test('capture preserves raw data and file bytes with private modes and a verified manifest',async t=>{
  const f = await fixture(t)
  const written = await writeCaptureBundle(f.bundle,f.capture)
  assert.equal(written.complete,true)
  const verified = await verifyCaptureBundle(f.bundle)
  assert.equal(verified.complete,true)
  assert.equal(verified.manifest.source.projectId,'chan_project1')
  assert.equal(verified.manifest.nativeHistoryImport,false)
  assert.equal(verified.manifest.autoResume,false)
  assert.equal((await stat(f.bundle)).mode&0o777,0o700)
  for (const entry of verified.manifest.files) {
    assert.equal((await stat(path.join(f.bundle,entry.path))).mode&0o777,0o600)
    assert.match(entry.sha256,/^[a-f0-9]{64}$/)
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(f.bundle,'data/channel.json'),'utf8')),f.capture.channel)
  assert.deepEqual(await readFile(path.join(f.bundle,'data/library/file_1.bin')),f.capture.libraryFiles[0].bytes)
  assert.deepEqual(await readFile(path.join(f.bundle,'data/local-transcripts/thread_1/session_1.jsonl')),f.capture.localTranscripts[0].bytes)
})

test('restore preparation is deterministic, separates duplicate titles by ID, and preserves original memory',async t=>{
  const f = await fixture(t)
  await writeCaptureBundle(f.bundle,f.capture)
  const prepared = await prepareProjectRestore(f.bundle,f.prepared)
  const second = await prepareProjectRestore(f.bundle,path.join(f.root,'prepared2'))
  assert.equal(prepared.destinationChanged,false)
  assert.equal(prepared.nativeHistoryImport,false)
  assert.equal(prepared.autoResume,false)
  assert.deepEqual(prepared.preparation,second.preparation)
  assert.deepEqual((await readdir(path.join(f.prepared,'handoffs'))).sort(),['thread_1.md','thread_2.md'])
  const memoryEntry = (await verifyCaptureBundle(f.bundle)).manifest.files.find(file=>file.role==='memory'&&file.originalPath==='/MEMORY.md')
  const original = await readFile(path.join(f.prepared,'originals',memoryEntry.path))
  assert.deepEqual(original,f.capture.memoryFiles[0].bytes)
  const memory = await readFile(path.join(f.prepared,'MEMORY.md'))
  assert(memory.subarray(0,original.length).equals(original))
  const handoff = await readFile(path.join(f.prepared,'handoffs/thread_1.md'),'utf8')
  assert.match(handoff,/Source thread: thread_1/)
  assert.match(handoff,/Native history import: false/)
  assert.match(handoff,/````json/)
  assert.match(await readFile(path.join(f.prepared,'main-transcript.md'),'utf8'),/Main task/)
})

test('changed raw content is refused before restore output is created',async t=>{
  const f = await fixture(t)
  await writeCaptureBundle(f.bundle,f.capture)
  await writeFile(path.join(f.bundle,'data/channel.json'),'{}\n')
  await assert.rejects(verifyCaptureBundle(f.bundle),/failed verification/)
  await assert.rejects(prepareProjectRestore(f.bundle,f.prepared),/failed verification/)
  await assert.rejects(stat(f.prepared),{code:'ENOENT'})
})

test('incomplete provider results can be saved but cannot prepare a restore',async t=>{
  const f = await fixture(t)
  f.capture.complete.library = false
  f.capture.missing = ['Library download returned 404']
  delete f.capture.coordinator.sessionEvents
  const result = await writeCaptureBundle(f.bundle,f.capture)
  assert.equal(result.complete,false)
  const verified = await verifyCaptureBundle(f.bundle)
  assert.equal(verified.complete,false)
  assert(verified.manifest.missing.includes('Library download returned 404'))
  await assert.rejects(prepareProjectRestore(f.bundle,f.prepared),/complete capture/)
})

test('missing expected threads are recorded as incomplete',async t=>{
  const f = await fixture(t)
  f.capture.expectedThreadIds.push('thread_missing')
  await writeCaptureBundle(f.bundle,f.capture)
  const result = await verifyCaptureBundle(f.bundle)
  assert.equal(result.complete,false)
  assert(result.manifest.missing.some(item=>item.includes('captured IDs')))
})

test('missing manifest data cannot be relabeled as a complete capture',async t=>{
  const f = await fixture(t)
  f.capture.complete.threads = false
  await writeCaptureBundle(f.bundle,f.capture)
  const file = path.join(f.bundle,'manifest.json')
  const manifest = JSON.parse(await readFile(file,'utf8'))
  manifest.complete = true
  await writeFile(file,JSON.stringify(manifest))
  await assert.rejects(verifyCaptureBundle(f.bundle),/completeness/)
})

test('existing output is never overwritten',async t=>{
  const f = await fixture(t)
  await writeCaptureBundle(f.bundle,f.capture)
  const before = await readFile(path.join(f.bundle,'manifest.json'))
  await assert.rejects(writeCaptureBundle(f.bundle,f.capture),{code:'EEXIST'})
  assert.deepEqual(await readFile(path.join(f.bundle,'manifest.json')),before)
  await prepareProjectRestore(f.bundle,f.prepared)
  await assert.rejects(prepareProjectRestore(f.bundle,f.prepared),{code:'EEXIST'})
})

for (const field of ['thread','memory','library']) test(`capture refuses ${field} path traversal`,async t=>{
  const f = await fixture(t)
  if (field==='thread') f.capture.threads[0].id = '../outside'
  if (field==='memory') f.capture.memoryFiles[0].path = '/notes/../../outside'
  if (field==='library') f.capture.libraryFiles[0].originalPath = '../outside'
  await assert.rejects(writeCaptureBundle(f.bundle,f.capture),/Invalid|Unsafe/)
  await assert.rejects(stat(f.bundle),{code:'ENOENT'})
})

test('output paths and captured entries refuse symlinks',async t=>{
  const f = await fixture(t)
  await mkdir(path.join(f.root,'actual'),{mode:0o700})
  await symlink(path.join(f.root,'actual'),path.join(f.root,'alias'))
  await assert.rejects(writeCaptureBundle(path.join(f.root,'alias/capture'),f.capture),/Symlinks/)
  await writeCaptureBundle(f.bundle,f.capture)
  const file = path.join(f.bundle,'data/channel.json')
  const content = await readFile(file)
  await rm(file)
  await writeFile(path.join(f.root,'other.json'),content,{mode:0o600})
  await symlink(path.join(f.root,'other.json'),file)
  await assert.rejects(verifyCaptureBundle(f.bundle),/Symlinks/)
})

test('manifest traversal and unlisted files are refused',async t=>{
  const f = await fixture(t)
  await writeCaptureBundle(f.bundle,f.capture)
  await writeFile(path.join(f.bundle,'extra.txt'),'unlisted',{mode:0o600})
  await assert.rejects(verifyCaptureBundle(f.bundle),/outside its manifest/)
  await rm(path.join(f.bundle,'extra.txt'))
  const file = path.join(f.bundle,'manifest.json')
  const manifest = JSON.parse(await readFile(file,'utf8'))
  manifest.files[0].path = '../outside'
  await writeFile(file,JSON.stringify(manifest))
  await assert.rejects(verifyCaptureBundle(f.bundle),/Unsafe/)
})

test('transport credentials and credential files are refused while raw code and tool inputs remain exact',async t=>{
  const f = await fixture(t)
  f.capture.source.authorization = 'Bearer secret'
  await assert.rejects(writeCaptureBundle(f.bundle,f.capture),/Credential field/)
  delete f.capture.source.authorization
  f.capture.memoryFiles.push({path:'/.env',bytes:'SECRET=private'})
  await assert.rejects(writeCaptureBundle(f.bundle,f.capture),/Credential files/)
  f.capture.memoryFiles.pop()
  f.capture.threads[1].history.push({type:'tool_use',input:{apiKey:'example-only',password:'placeholder'}})
  await writeCaptureBundle(f.bundle,f.capture)
  assert.deepEqual(JSON.parse(await readFile(path.join(f.bundle,'data/threads/thread_1/history.json'),'utf8')),f.capture.threads[1].history)
})

test('duplicate stable IDs and unknown local links are refused',async t=>{
  const f = await fixture(t)
  f.capture.threads.push({...f.capture.threads[0]})
  await assert.rejects(writeCaptureBundle(f.bundle,f.capture),/Duplicate/)
  f.capture.threads.pop()
  f.capture.localTranscripts[0].threadId = 'thread_unknown'
  await assert.rejects(writeCaptureBundle(f.bundle,f.capture),/unknown thread/)
})

test('public file permissions cause verification to fail',async t=>{
  const f = await fixture(t)
  await writeCaptureBundle(f.bundle,f.capture)
  await chmod(path.join(f.bundle,'data/channel.json'),0o644)
  await assert.rejects(verifyCaptureBundle(f.bundle),/0600/)
})

test('restore plan keeps portable config, lists scoped settings, and maps local bytes exactly once',async t=>{
  const f = await fixture(t)
  const portable = {system_prompt_addendum:'Project instructions',channel_session_model:'model-a',channel_session_effort_level:'max',default_model:'model-b',default_effort_level:'high',default_source_urls:['https://example.com/repository'],memory_enabled:true}
  const scoped = {env:{id:'environment1'},mcp_servers:['server1'],plugins:['plugin1'],skills:['skill1'],device_id:'device1',auto_mode_rules:['rule1'],permissions:{mode:'source-only'}}
  f.capture.channel = {...f.capture.channel,name:'Source name',topic:'Source topic',icon:'icon1',color:'blue',config:{...portable,...scoped,empty_plugins:[],unused_device:null}}
  await writeCaptureBundle(f.bundle,f.capture)
  await prepareProjectRestore(f.bundle,f.prepared)
  const plan = JSON.parse(await readFile(path.join(f.prepared,'restore-plan.json'),'utf8'))
  assert.deepEqual(plan.project,{name:'Source name',topic:'Source topic',icon:'icon1',color:'blue',config:portable})
  assert.deepEqual(plan.reconnect.map(item=>item.field).sort(),Object.keys(scoped).sort())
  assert.equal(plan.requiresDestinationPaused,true)
  assert.equal(plan.createsThreads,false)
  assert.equal(plan.nativeHistoryImport,false)
  assert.equal(plan.autoResume,false)
  assert.equal(plan.overwriteExisting,false)
  assert.deepEqual(plan.memoryUploads.map(item=>item.path).sort(),['/MEMORY.md','/notes/work.md'])
  assert.equal(plan.memoryUploads.find(item=>item.path==='/MEMORY.md').sourcePath,'MEMORY.md')
  assert(plan.libraryUploads.some(item=>item.path==='/docs/data.bin'&&item.kind==='original-library'))
  assert(plan.libraryUploads.some(item=>item.path==='migration/chan_project1/main-transcript.md'))
  assert(plan.libraryUploads.some(item=>item.path==='migration/chan_project1/handoffs/thread_1.md'))
  assert(plan.libraryUploads.some(item=>item.kind==='original-local-transcript'))
  const uploads = [...plan.memoryUploads,...plan.libraryUploads]
  assert.equal(new Set(uploads.map(item=>item.sourcePath)).size,uploads.length)
  for (const upload of uploads) {
    const data = await readFile(path.join(f.prepared,upload.sourcePath))
    assert.equal(data.length,upload.bytes)
    assert.equal(createHash('sha256').update(data).digest('hex'),upload.sha256)
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(f.prepared,plan.sourceSettingsPath),'utf8')),f.capture.channel)
  const instructions = await readFile(path.join(f.prepared,'RESTORE.md'),'utf8')
  assert.match(instructions,/Pause the destination/)
  assert.match(instructions,/do not use a private source URL/)
})

test('restore preparation refuses duplicate upload destinations before creating output',async t=>{
  const f = await fixture(t)
  f.capture.libraryFiles.push({id:'file_2',name:'other.bin',originalPath:'/docs/data.bin',bytes:Buffer.from('other content')})
  await writeCaptureBundle(f.bundle,f.capture)
  await assert.rejects(prepareProjectRestore(f.bundle,f.prepared),/Duplicate library upload path/)
  await assert.rejects(stat(f.prepared),{code:'ENOENT'})
})

test('restore upload preflight rejects oversized files, private URL sources, and memory path collisions',()=>{
  const entry = {path:'migration/chan_project1/history.md',sourcePath:'main-transcript.md',bytes:480_000_001,sha256:'a'.repeat(64)}
  const plan = {memoryUploads:[],libraryUploads:[entry],maxLibraryFileBytes:480_000_000}
  assert.throws(()=>preflightRestoreUploads(plan),/480 MB limit/)
  entry.bytes = 480_000_000
  assert.deepEqual(preflightRestoreUploads(plan),{ok:true,memoryFiles:0,libraryFiles:1})
  entry.sourcePath = 'https://claude.ai/private/history'
  assert.throws(()=>preflightRestoreUploads(plan),/Unsafe/)
  plan.libraryUploads = []
  plan.memoryUploads = [{...entry,path:'/MEMORY.md',sourcePath:'originals/memory.bin'},{...entry,path:'MEMORY.md',sourcePath:'originals/other.bin'}]
  assert.throws(()=>preflightRestoreUploads(plan),/Duplicate memory upload path/)
})

test('capture representation limits remain explicit without making captured data incomplete',async t=>{
  const f = await fixture(t)
  f.capture.limitations = ['Native Pages reports were captured as text and links. Native layout and widget state were not captured.']
  f.capture.libraryFiles[0].captureFormat = 'text'
  f.capture.libraryFiles[0].nativeStateCaptured = false
  const saved = await writeCaptureBundle(f.bundle,f.capture)
  assert.equal(saved.complete,true)
  const verified = await verifyCaptureBundle(f.bundle)
  assert.equal(verified.complete,true)
  assert.deepEqual(verified.manifest.limitations,f.capture.limitations)
  const entry = verified.manifest.files.find(file=>file.role==='library')
  assert.equal(entry.captureFormat,'text')
  assert.equal(entry.nativeStateCaptured,false)
  assert.deepEqual(await readFile(path.join(f.bundle,entry.path)),f.capture.libraryFiles[0].bytes)
  const result = await prepareProjectRestore(f.bundle,f.prepared)
  assert.deepEqual(result.preparation.limitations,f.capture.limitations)
  const plan = JSON.parse(await readFile(path.join(f.prepared,'restore-plan.json'),'utf8'))
  assert.deepEqual(plan.limitations,f.capture.limitations)
  const upload = plan.libraryUploads.find(file=>file.kind==='original-library')
  assert.equal(upload.captureFormat,'text')
  assert.equal(upload.nativeStateCaptured,false)
  const instructions = await readFile(path.join(f.prepared,'RESTORE.md'),'utf8')
  assert(instructions.includes(f.capture.limitations[0]))
  assert(instructions.indexOf('## Capture limits')<instructions.indexOf('1. Verify'))
})

test('capture rejects invalid limitation values and artifact capture metadata',async t=>{
  const f = await fixture(t)
  f.capture.limitations = [{message:'Not a string'}]
  await assert.rejects(writeCaptureBundle(f.bundle,f.capture),/limitations must be nonempty strings/)
  f.capture.limitations = ['']
  await assert.rejects(writeCaptureBundle(f.bundle,f.capture),/limitations must be nonempty strings/)
  f.capture.limitations = []
  f.capture.libraryFiles[0].nativeStateCaptured = 'false'
  await assert.rejects(writeCaptureBundle(f.bundle,f.capture),/must be boolean/)
  delete f.capture.libraryFiles[0].nativeStateCaptured
  await writeCaptureBundle(f.bundle,f.capture)
  const file = path.join(f.bundle,'manifest.json')
  const manifest = JSON.parse(await readFile(file,'utf8'))
  manifest.limitations = ['valid',null]
  await writeFile(file,JSON.stringify(manifest))
  await assert.rejects(verifyCaptureBundle(f.bundle),/limitations must be nonempty strings/)
})

test('restore gives attachments with the same filename separate stable paths',async t=>{
  const f=await fixture(t)
  f.capture.libraryFiles=[{id:'attachment_one',name:'image.png',bytes:Buffer.from('first')},{id:'attachment_two',name:'image.png',bytes:Buffer.from('second')}]
  await writeCaptureBundle(f.bundle,f.capture)
  await prepareProjectRestore(f.bundle,f.prepared)
  const plan=JSON.parse(await readFile(path.join(f.prepared,'restore-plan.json'),'utf8'))
  assert.deepEqual(plan.libraryUploads.filter(row=>row.kind==='original-library').map(row=>row.path),['captured-files/attachment_one/image.png','captured-files/attachment_two/image.png'])
})
