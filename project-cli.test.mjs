import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,realpath,rm,mkdir,writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {runProjectCommand} from './project-cli.mjs'

const SOURCE={account:'11111111-1111-4111-8111-111111111111',org:'22222222-2222-4222-8222-222222222222',label:'Source'}
const TARGET={account:'33333333-3333-4333-8333-333333333333',org:'44444444-4444-4444-8444-444444444444',label:'Target'}
const THIRD={account:'55555555-5555-4555-8555-555555555555',org:'66666666-6666-4666-8666-666666666666',label:'Third'}
const PROJECT='chan_source',STAMP='a'.repeat(64),DISABLED='2026-10-22T12:00:00Z'
const json=(file,value)=>writeFile(file,JSON.stringify(value),{mode:0o600})
const read=async file=>JSON.parse(await readFile(file,'utf8'))

async function fixture(t) {
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'project-cli-')))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const paths={state:root},events=[],calls=[]
  let active=SOURCE,latest='initial',sourceDisabledAt=DISABLED,sourceStamp=STAMP
  const source={...SOURCE,projectRequest:async()=>({channel:{id:PROJECT,name:'Founderizer',disabled_at:sourceDisabledAt}})}
  const selected=()=>read(path.join(root,'project-selection.json'))
  const transfer=()=>({schemaVersion:1,kind:'claude-code-project-transfer',status:'ready',sourcePaused:true,sourceDisabledAt,sourceStamp,source:{accountId:SOURCE.account,organizationId:SOURCE.org,projectId:PROJECT},readyAt:'2026-10-22T12:05:00Z'})
  const saveStage=async output=>{
    await mkdir(output,{recursive:true,mode:0o700})
    await mkdir(path.join(output,'prepared'),{mode:0o700})
    const value=transfer()
    await json(path.join(output,'transfer.json'),value)
    await writeFile(path.join(output,'prepared','latest.txt'),latest,{mode:0o600})
    return {ready:true,path:output,threads:6,transfer:value}
  }
  const io={
    signedIn:async()=>active,
    clientFactory:async(_paths,expected)=>{calls.push('destination-client');assert.equal(expected.account,active.account);return {...source,account:active.account,org:active.org}},
    sourceFactory:async(_paths,expected)=>{calls.push('source-client');assert.deepEqual(expected,SOURCE);return source},
    sourceMetadata:async(_paths,expected)=>{assert.deepEqual(expected,SOURCE);return {available:true,...SOURCE}},
    connectSource:async(_paths,expected)=>{assert.deepEqual(expected,SOURCE);calls.push('connect-source');return SOURCE},
    locked:async(_paths,work)=>work(),
    accounts:async()=>{calls.push('verify-destination');return [{...active,active:true,identityKnown:true,personal:true}]},
    stamp:async(client,id)=>{calls.push('source-stamp');assert.equal(client,source);assert.equal(id,PROJECT);return sourceStamp},
    stage:async(client,_paths,id,output)=>{calls.push('stage');assert.equal(client,source);assert.equal(id,PROJECT);return saveStage(output)},
    restore:async(client,prepared)=>{calls.push('restore');assert.equal(client.account,TARGET.account);assert.equal(await readFile(path.join(prepared,'latest.txt'),'utf8'),latest);return {restored:true,paused:true,projectId:'chan_newTarget'}},
    resume:async(client,root)=>{calls.push('resume');assert.equal(client.account,TARGET.account);assert.equal(root,(await selected()).stagePath);return{accepted:true,coordinatorStarted:null}}
  }
  const run=(cmd,args={})=>runProjectCommand(paths,{cmd,...args},event=>events.push(event),io)
  const select=()=>run('project-select',{source:SOURCE.account+'/'+SOURCE.org,project:PROJECT})
  const ready=async()=>{
    const stage=path.join(root,'stage-'+calls.length)
    await saveStage(stage)
    const value=await selected();value.stagePath=stage
    await json(path.join(root,'project-selection.json'),value)
    return stage
  }
  const interrupt=async()=>{
    io.restore=async(client,prepared)=>{
      calls.push('restore')
      await json(path.join(path.dirname(prepared),'restore.json'),{schemaVersion:1,kind:'claude-code-project-restore',status:'restoring',source:transfer().source,destination:{accountId:client.account,organizationId:client.org,projectId:'chan_partial'},applied:[]})
      throw new Error('Upload interrupted')
    }
    await assert.rejects(run('project-move'),/Upload interrupted/)
    return (await selected()).stagePath
  }
  return {paths,io,events,calls,source,run,select,selected,ready,interrupt,setActive:value=>{active=value},setLatest:value=>{latest=value},setPaused:value=>{sourceDisabledAt=value},setStamp:value=>{sourceStamp=value}}
}

test('selects an exact project only in its verified source account',async t=>{
  const f=await fixture(t)
  await assert.rejects(f.run('project-select',{source:TARGET.account+'/'+TARGET.org,project:PROJECT}),/source account/)
  await f.select()
  assert.equal((await f.selected()).projectId,PROJECT)
  assert.equal((await f.selected()).stagePath,null)
})

test('status permits a one-switch move using source metadata without loading its browser session',async t=>{
  const f=await fixture(t);await f.select();f.setActive(TARGET)
  f.io.sourceFactory=async()=>assert.fail('Status must not load source credentials')
  f.io.clientFactory=async()=>assert.fail('Selected status must not read a Desktop project')
  await f.run('project-status')
  const status=f.events.at(-1)
  assert.equal(status.canMove,true)
  assert.equal(status.canStage,false)
  assert.equal(status.sourceConnected,true)
  assert.match(status.note,/latest source project state/)
  assert.doesNotMatch(status.note,/prepare|switch back/i)
  assert.equal((await f.selected()).stagePath,null)
})

test('status requires the exact separate source login and keeps Desktop on its current account',async t=>{
  const f=await fixture(t);await f.select();f.setActive(TARGET)
  for(const metadata of [{available:false},{available:true,...TARGET}]){
    f.io.sourceMetadata=async()=>metadata
    await f.run('project-status')
    const status=f.events.at(-1)
    assert.equal(status.canMove,false)
    assert.equal(status.canStage,false)
    assert.equal(status.sourceConnected,false)
    assert.match(status.note,/Connect source once as Source/)
    assert.match(status.note,/Desktop can stay/)
  }
})

test('same-account status waits for the destination switch without a prepare action',async t=>{
  const f=await fixture(t);await f.select();await f.run('project-status')
  assert.equal(f.events.at(-1).canStage,false)
  assert.equal(f.events.at(-1).canMove,false)
  assert.match(f.events.at(-1).note,/When you change Desktop accounts/)
})

test('one Desktop switch captures the latest source state on the move click and ignores an old stage',async t=>{
  const f=await fixture(t);await f.select();const previous=await f.ready()
  f.setLatest('updated after the old capture')
  f.setActive(TARGET)
  await f.run('project-move')
  assert.deepEqual(f.calls.slice(-6),['verify-destination','destination-client','source-client','stage','restore','resume'])
  assert.equal(f.calls.filter(value=>value==='stage').length,1)
  assert.notEqual(f.events.find(value=>value.text?.includes('latest project state')),undefined)
  assert.equal(await readFile(path.join(previous,'prepared','latest.txt'),'utf8'),'initial')
  assert.deepEqual(await f.selected(),{version:1,source:TARGET,projectId:'chan_newTarget',title:'Founderizer',stagePath:null})
  assert.equal(f.events.at(-1).target.account,TARGET.account)
  assert.equal(f.events.at(-1).accepted,true)
  assert.equal(f.events.at(-1).paused,false)
})

test('move without resume leaves the verified project paused and sends no message',async t=>{
  const f=await fixture(t);await f.select();f.setActive(TARGET)
  f.io.resume=async()=>assert.fail('Move-only must not send a continuation')
  await f.run('project-move',{noResume:true})
  assert.equal(f.events.at(-1).paused,true)
  assert.equal(f.events.at(-1).accepted,false)
})

test('a failed project start keeps the staged transfer for the next attempt',async t=>{
  const f=await fixture(t);await f.select();f.setActive(TARGET)
  f.io.resume=async()=>{throw new Error('The continuation is not verified')}
  await assert.rejects(f.run('project-move'),/continuation is not verified/)
  const selected=await f.selected()
  assert.equal(selected.source.account,SOURCE.account)
  assert.ok(selected.stagePath)
})

test('a pending start retries the same destination without restoring an unpaused project again',async t=>{
  const f=await fixture(t);await f.select();f.setActive(TARGET)
  f.io.resume=async(_client,root)=>{
    await json(path.join(root,'restore.json'),{status:'complete',destination:{accountId:TARGET.account,organizationId:TARGET.org,projectId:'chan_newTarget'}})
    await json(path.join(root,'resume.json'),{status:'pending'})
    throw new Error('Start reply lost')
  }
  await assert.rejects(f.run('project-move'),/Start reply lost/)
  const staged=(await f.selected()).stagePath
  f.io.restore=async()=>assert.fail('The unpaused destination must not be restored again')
  f.io.resume=async(_client,root)=>{assert.equal(root,staged);return{accepted:true}}
  await f.run('project-move')
  assert.equal(f.calls.filter(value=>value==='stage').length,1)
  assert.equal(f.events.at(-1).accepted,true)
})

test('a non-Personal destination is rejected before source credentials or source pause',async t=>{
  const f=await fixture(t);await f.select();f.setActive(TARGET)
  f.io.accounts=async()=>[{...TARGET,active:true,identityKnown:true,personal:false}]
  f.io.sourceFactory=async()=>assert.fail('Source credentials must not be loaded')
  f.io.stage=async()=>assert.fail('Source must not be paused')
  await assert.rejects(f.run('project-move'),/Personal Max or Pro/)
  assert.equal((await f.selected()).stagePath,null)
})

test('a changed verified destination is rejected before any source action',async t=>{
  const f=await fixture(t);await f.select();f.setActive(TARGET)
  f.io.clientFactory=async()=>({...f.source,...THIRD})
  f.io.sourceFactory=async()=>assert.fail('Source credentials must not be loaded')
  await assert.rejects(f.run('project-move'),/verified destination account changed/)
})

test('a mismatched separate source client cannot pause or capture the project',async t=>{
  const f=await fixture(t);await f.select();f.setActive(TARGET)
  f.io.sourceFactory=async()=>({...f.source,...TARGET})
  f.io.stage=async()=>assert.fail('A different source must not be paused')
  await assert.rejects(f.run('project-move'),/separate source connection does not match/)
  assert.equal((await f.selected()).stagePath,null)
})

test('a failed fresh capture clears an old unused stage and never restores its old data',async t=>{
  const f=await fixture(t);await f.select();const previous=await f.ready();f.setActive(TARGET)
  f.io.stage=async(_client,_paths,_id,output)=>{assert.notEqual(output,previous);throw new Error('Source changed during capture')}
  f.io.restore=async()=>assert.fail('An old stage must not be restored')
  await assert.rejects(f.run('project-move'),/Source changed during capture/)
  assert.equal((await f.selected()).stagePath,null)
})

test('a partial restore resumes the same destination only after checking the live paused source',async t=>{
  const f=await fixture(t);await f.select();f.setActive(TARGET)
  const stage=await f.interrupt()
  f.io.stage=async()=>assert.fail('A partial destination must not get a new stage')
  f.io.restore=async(client,prepared)=>{f.calls.push('restore');assert.equal(client.account,TARGET.account);assert.equal(prepared,path.join(stage,'prepared'));return {restored:true,paused:true,projectId:'chan_partial'}}
  await f.run('project-move')
  assert.equal(f.calls.filter(value=>value==='stage').length,1)
  assert.equal(f.calls.filter(value=>value==='restore').length,2)
  assert.equal(f.calls.filter(value=>value==='source-stamp').length,1)
  assert.equal((await f.selected()).projectId,'chan_partial')
})

test('a changed or unpaused source blocks partial retry without a duplicate destination',async t=>{
  for(const change of ['content','pause']){
    const f=await fixture(t);await f.select();f.setActive(TARGET)
    const stage=await f.interrupt()
    if(change==='content')f.setStamp('b'.repeat(64));else f.setPaused(null)
    f.io.stage=async()=>assert.fail('No new source stage may replace the partial restore')
    f.io.restore=async()=>assert.fail('Changed source must not be restored into the old target')
    await assert.rejects(f.run('project-move'),/source changed.*no duplicate project was created/i)
    assert.equal((await f.selected()).stagePath,stage)
    assert.equal(f.calls.filter(value=>value==='stage').length,1)
  }
})

test('a partial restore cannot move to another destination or mutate the source again',async t=>{
  const f=await fixture(t);await f.select();f.setActive(TARGET)
  await f.interrupt();f.setActive(THIRD)
  f.io.sourceFactory=async()=>assert.fail('Wrong target must be rejected before source use')
  await assert.rejects(f.run('project-move'),/restore belongs to another destination.*no duplicate project was created/i)
})

test('a Desktop account change during fresh capture stops before destination restore',async t=>{
  const f=await fixture(t);await f.select();f.setActive(TARGET)
  const stage=f.io.stage
  f.io.stage=async(...args)=>{const result=await stage(...args);f.setActive(THIRD);return result}
  f.io.restore=async()=>assert.fail('The original destination must not be used after a Desktop account change')
  await assert.rejects(f.run('project-move'),/destination changed during the project capture/)
  assert.ok((await f.selected()).stagePath)
})

test('advanced source staging still reads fresh state and invalidates a failed old stage',async t=>{
  const f=await fixture(t);await f.select();const previous=await f.ready()
  let calls=0
  f.io.stage=async(client,_paths,id,output)=>{calls++;assert.equal(client.account,SOURCE.account);assert.equal(id,PROJECT);assert.notEqual(output,previous);assert.equal((await f.selected()).stagePath,null);throw new Error('Source changed during capture')}
  await assert.rejects(f.run('project-stage'),/Source changed/)
  assert.equal(calls,1)
  assert.equal((await f.selected()).stagePath,null)
})

test('Connect source uses a separate source login from either Desktop account',async t=>{
  for(const current of [SOURCE,TARGET]){
    const f=await fixture(t);await f.select();f.setActive(current)
    f.io.stage=async()=>assert.fail('Connection must not pause the source')
    f.io.restore=async()=>assert.fail('Connection must not create a project')
    f.io.locked=async()=>assert.fail('An interactive source login must not hold the move lock')
    const before=await f.selected()
    await f.run('project-connect')
    assert.equal(f.calls.at(-1),'connect-source')
    assert.equal(f.events.at(-1).sourceConnected,true)
    assert.equal(f.events.at(-1).source.account,SOURCE.account)
    assert.deepEqual(await f.selected(),before)
    await f.run('project-status')
    assert.equal(f.events.at(-1).sourceConnected,true)
  }
})

test('a separate login for a different account is refused without changing the project selection',async t=>{
  const f=await fixture(t);await f.select();f.setActive(TARGET)
  const before=await f.selected()
  f.io.connectSource=async()=>TARGET
  await assert.rejects(f.run('project-connect'),/source login does not match/)
  assert.deepEqual(await f.selected(),before)
  assert.equal(f.events.some(event=>event.done===true&&event.sourceConnected===true),false)
})
