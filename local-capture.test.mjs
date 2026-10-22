import test from 'node:test'
import assert from 'node:assert/strict'
import {chmod,mkdtemp,mkdir,readFile,realpath,rm,stat,symlink,writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {captureLocal,verifyLocalCapture,verifyLocalMoveCapture} from './local-capture.mjs'

const SOURCE={account:'11111111-1111-4111-8111-111111111111',org:'22222222-2222-4222-8222-222222222222',label:'Source'}
const OTHER={account:'33333333-3333-4333-8333-333333333333',org:'44444444-4444-4444-8444-444444444444',label:'Other'}
const CLI1='55555555-5555-4555-8555-555555555555',CLI2='66666666-6666-4666-8666-666666666666',CLI3='77777777-7777-4777-8777-777777777777'
const IDS=['88888888-8888-4888-8888-888888888888','99999999-9999-4999-8999-999999999999','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']
const names=IDS.map(id=>`local_${id}.json`)
const json=async(file,value)=>writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600})
async function fixture(t){
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'local-capture-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const paths={state:path.join(root,'state'),records:path.join(root,'records'),pool:path.join(root,'pool')}
  const namespace=path.join(paths.records,SOURCE.account,SOURCE.org),folder=path.join(paths.pool,'-source-project'),output=path.join(root,'capture')
  await mkdir(paths.state,{recursive:true,mode:0o700});await mkdir(namespace,{recursive:true});await mkdir(folder,{recursive:true})
  const group={version:1,current:SOURCE,records:[names[0]],preserve:{[`${SOURCE.account}/${SOURCE.org}`]:[names[2]]}}
  await json(path.join(paths.state,'local-workflow.json'),group)
  for(const [index,cliSessionId] of [CLI1,CLI2,CLI3].entries())await json(path.join(namespace,names[index]),{sessionId:names[index].slice(0,-5),cliSessionId,title:`Conversation ${index+1}`,cwd:'/source/project'})
  const registry=Buffer.from('{"scheduledTasks":[{"id":"task-one","notifySessionId":"local_'+IDS[0]+'","enabled":false}]}\n')
  await writeFile(path.join(namespace,'scheduled-tasks.json'),registry)
  await writeFile(path.join(folder,`${CLI1}.jsonl`),'first transcript\n')
  await writeFile(path.join(folder,`${CLI3}.jsonl`),'unrelated preserved transcript\n')
  await mkdir(path.join(folder,CLI1,'subagents'),{recursive:true})
  await writeFile(path.join(folder,CLI1,'subagents','agent-child.jsonl'),'child transcript\n')
  return{root,paths,namespace,folder,output,group,registry,capture:options=>captureLocal(paths,output,{source:SOURCE,...options})}
}
async function preparedFixture(t){
  const f=await fixture(t),parent=path.join(f.paths.state,'project-batches'),root=path.join(parent,IDS[0]),localPath=path.join(root,`local-${IDS[1]}`)
  await mkdir(parent,{mode:0o700});await mkdir(root,{mode:0o700})
  const capture=await captureLocal(f.paths,localPath,{source:SOURCE})
  const stateFile=path.join(f.paths.state,'account-projects.json'),batchFile=path.join(root,'batch.json')
  const state={version:1,current:OTHER,lastBatch:root},batch={version:2,phase:'complete',root,source:SOURCE,target:OTHER,localPath,localCount:capture.count}
  await json(stateFile,state);await json(batchFile,batch)
  return{...f,stateFile,batchFile,state,batch,capture,plan:{from:SOURCE,to:OTHER,records:names.slice(0,2)}}
}

test('captures every selected record, exact history bytes, sidecars and scheduled settings with private modes',async t=>{
  const f=await fixture(t),result=await f.capture()
  assert.equal(result.count,2)
  assert.deepEqual(result.records.map(row=>row.name),names.slice(0,2))
  assert.equal(result.records.find(row=>row.name===names[1]).cliSessionId,CLI2)
  assert.equal(result.manifest.files.filter(file=>file.role==='transcript').length,1)
  assert.equal(result.manifest.files.filter(file=>file.role==='sidecar').length,1)
  assert.equal(result.manifest.files.some(file=>file.sourcePath.includes(CLI3)),false)
  assert.equal((await stat(f.output)).mode&0o777,0o700)
  for(const file of result.manifest.files){
    assert.deepEqual(await readFile(path.join(f.output,file.path)),await readFile(file.sourcePath))
    assert.equal((await stat(path.join(f.output,file.path))).mode&0o777,0o600)
  }
  const scheduled=result.manifest.files.find(file=>file.role==='scheduled-tasks')
  assert.deepEqual(await readFile(path.join(f.output,scheduled.path)),f.registry)
})

test('preserves all matching local history locations and sidecars without a main transcript',async t=>{
  const f=await fixture(t),second=path.join(f.paths.pool,'-second-location')
  await mkdir(second);await writeFile(path.join(second,`${CLI1}.jsonl`),'another existing transcript\n')
  await mkdir(path.join(second,CLI2,'tool-results'),{recursive:true})
  await writeFile(path.join(second,CLI2,'tool-results','result.txt'),'saved local result\n')
  const result=await f.capture()
  assert.equal(result.manifest.files.filter(file=>file.role==='transcript').length,2)
  assert.equal(result.manifest.files.filter(file=>file.role==='sidecar').length,2)
})

test('restore verification uses only saved data after the source files and collection are gone',async t=>{
  const f=await fixture(t);await f.capture()
  await rm(f.paths.records,{recursive:true});await rm(f.paths.pool,{recursive:true});await rm(f.paths.state,{recursive:true})
  t.mock.method(globalThis,'fetch',async()=>assert.fail('Saved local capture verification must not use the network'))
  const result=await verifyLocalCapture(f.paths,f.output,{source:SOURCE})
  assert.equal(result.count,2)
  assert.equal(result.source.account,SOURCE.account)
})

test('a changed source file cannot produce a ready local capture',async t=>{
  const f=await fixture(t);let changed=false
  await assert.rejects(f.capture({io:{afterCopy:async({file})=>{
    if(file.role==='record'&&!changed){changed=true;await writeFile(file.sourcePath,'{"sessionId":"local_'+IDS[0]+'","cliSessionId":"'+CLI1+'","title":"Changed after copy"}\n')}
  }}}),/changed during capture/)
  await assert.rejects(stat(path.join(f.output,'manifest.json')),{code:'ENOENT'})
})

test('new records and new sidecar files during capture cannot be missed',async t=>{
  for(const kind of ['record','sidecar']){
    const f=await fixture(t);let changed=false
    await assert.rejects(f.capture({io:{afterCopy:async()=>{
      if(changed)return;changed=true
      if(kind==='record')await json(path.join(f.namespace,'local_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.json'),{sessionId:'local_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',cliSessionId:null})
      else await writeFile(path.join(f.folder,CLI1,'subagents','new.jsonl'),'new work\n')
    }}}),/changed during capture/)
    await assert.rejects(stat(path.join(f.output,'manifest.json')),{code:'ENOENT'})
  }
})

test('changed saved bytes, unlisted files, and a foreign source are refused',async t=>{
  for(const change of ['bytes','extra','source']){
    const f=await fixture(t),result=await f.capture()
    if(change==='bytes')await writeFile(path.join(f.output,result.records[0].path),'changed')
    if(change==='extra')await writeFile(path.join(f.output,'unlisted.txt'),'unexpected',{mode:0o600})
    await assert.rejects(verifyLocalCapture(f.paths,f.output,{source:change==='source'?OTHER:SOURCE}),/changed|outside its manifest|Invalid saved/)
  }
})

test('captures refuse the wrong collection and never overwrite an output directory',async t=>{
  const f=await fixture(t)
  await assert.rejects(captureLocal(f.paths,f.output,{source:OTHER}),/source changed/)
  await f.capture()
  await assert.rejects(f.capture(),{code:'EEXIST'})
  assert.equal((await verifyLocalCapture(f.paths,f.output,{source:SOURCE})).count,2)
})

test('source and saved history symlinks are refused',async t=>{
  const f=await fixture(t)
  await symlink(path.join(f.folder,`${CLI1}.jsonl`),path.join(f.folder,CLI1,'subagents','linked.jsonl'))
  await assert.rejects(f.capture(),/symlinks/)
  await assert.rejects(stat(f.output),{code:'ENOENT'})
  const g=await fixture(t),result=await g.capture(),record=result.records[0]
  await rm(path.join(g.output,record.path))
  await symlink(path.join(g.namespace,record.name),path.join(g.output,record.path))
  await assert.rejects(verifyLocalCapture(g.paths,g.output,{source:SOURCE}),/symlinks/)
})

test('saved history identity and original file paths cannot escape the selected source',async t=>{
  const f=await fixture(t),result=await f.capture(),file=result.manifest.files.find(file=>file.role==='record')
  file.sourcePath='/private/not-the-source/credential.json'
  await json(path.join(f.output,'manifest.json'),result.manifest)
  await assert.rejects(verifyLocalCapture(f.paths,f.output,{source:SOURCE}),/outside its source account/)
})

test('a completed account move verifies its saved copy and permits logout runtime changes',async t=>{
  const f=await preparedFixture(t),file=path.join(f.namespace,names[0]),record=JSON.parse(await readFile(file,'utf8'))
  await json(file,{...record,error:'Signed out',lastActivityAt:1234})
  const result=await verifyLocalMoveCapture(f.paths,{...f.plan,records:[...f.plan.records].reverse()})
  assert.equal(result.path,f.batch.localPath)
  assert.equal(result.count,2)
  assert.equal(JSON.parse(await readFile(file,'utf8')).error,'Signed out')
})

test('legacy local moves and unrelated or unfinished batches have no capture guard',async t=>{
  const f=await fixture(t),plan={from:SOURCE,to:OTHER,records:names.slice(0,2)}
  assert.equal(await verifyLocalMoveCapture(f.paths,plan),null)
  await json(path.join(f.paths.state,'account-projects.json'),{version:1,current:SOURCE})
  assert.equal(await verifyLocalMoveCapture(f.paths,plan),null)
  const g=await preparedFixture(t)
  for(const change of [{version:1},{phase:'ready'},{source:OTHER},{target:SOURCE}]){
    await json(g.batchFile,{...g.batch,...change})
    assert.equal(await verifyLocalMoveCapture(g.paths,g.plan),null)
  }
})

test('new local conversations can join the move without dropping a saved conversation',async t=>{
  const f=await preparedFixture(t),extra='local_cccccccc-cccc-4ccc-8ccc-cccccccccccc.json'
  await json(path.join(f.namespace,extra),{sessionId:extra.slice(0,-5),cliSessionId:null})
  assert.equal((await verifyLocalMoveCapture(f.paths,{...f.plan,records:[...f.plan.records,extra]})).count,2)
})

test('a saved account move refuses changed lists, identities, missing originals and saved byte changes',async t=>{
  for(const kind of ['list','duplicate','identity','missing','saved']){
    const f=await preparedFixture(t),plan={...f.plan}
    if(kind==='list')plan.records=[names[0]]
    if(kind==='duplicate')plan.records=[names[0],names[0]]
    if(kind==='identity')await json(path.join(f.namespace,names[0]),{sessionId:names[0].slice(0,-5),cliSessionId:CLI3})
    if(kind==='missing')await rm(path.join(f.namespace,names[0]))
    if(kind==='saved')await writeFile(path.join(f.batch.localPath,f.capture.records[0].path),'changed')
    await assert.rejects(verifyLocalMoveCapture(f.paths,plan),/differs|identity changed|ENOENT|data changed/)
    if(kind==='missing')await assert.rejects(stat(path.join(f.namespace,names[0])),{code:'ENOENT'})
  }
})

test('recovery checks the saved set while the move journal checks records at either account',async t=>{
  const f=await preparedFixture(t)
  await rm(path.join(f.namespace,names[0]))
  assert.equal((await verifyLocalMoveCapture(f.paths,{...f.plan,recovery:true})).count,2)
  await assert.rejects(verifyLocalMoveCapture(f.paths,{...f.plan,recovery:true,records:[names[0]]}),/list differs/)
})

test('the move guard requires private regular state and batch files and contained capture paths',async t=>{
  for(const kind of ['state-mode','batch-mode','state-link','batch-link','batch-outside','local-outside','root-mismatch']){
    const f=await preparedFixture(t)
    if(kind==='state-mode')await chmod(f.stateFile,0o644)
    if(kind==='batch-mode')await chmod(f.batchFile,0o644)
    if(kind==='state-link'||kind==='batch-link'){
      const file=kind==='state-link'?f.stateFile:f.batchFile,value=kind==='state-link'?f.state:f.batch,other=path.join(f.root,`${kind}.json`)
      await json(other,value);await rm(file);await symlink(other,file)
    }
    if(kind==='batch-outside')await json(f.stateFile,{...f.state,lastBatch:f.root})
    if(kind==='local-outside')await json(f.batchFile,{...f.batch,localPath:f.output})
    if(kind==='root-mismatch')await json(f.batchFile,{...f.batch,root:f.root})
    await assert.rejects(verifyLocalMoveCapture(f.paths,f.plan),/private and regular|symlinks|Invalid saved/)
  }
})
