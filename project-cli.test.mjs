import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {runProjectCommand} from './project-cli.mjs'

const A={account:'11111111-1111-4111-8111-111111111111',org:'22222222-2222-4222-8222-222222222222',label:'Source'}
const B={account:'33333333-3333-4333-8333-333333333333',org:'44444444-4444-4444-8444-444444444444',label:'Target'}
const C={account:'55555555-5555-4555-8555-555555555555',org:'66666666-6666-4666-8666-666666666666',label:'Next'}
const PAUSED='2026-10-22T12:00:00Z'
const sha=value=>createHash('sha256').update(value).digest('hex')
const json=(file,value)=>writeFile(file,JSON.stringify(value),{mode:0o600})
const read=async file=>JSON.parse(await readFile(file,'utf8'))
async function fixture(t,{sourceRows=2}={}){
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'prepared-projects-')))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const paths={state:root},events=[],calls=[],projects=new Map([[A.account,[]],[B.account,[{id:'chan_targetExisting',name:'Existing target',body:'Keep this'}]],[C.account,[]]])
  for(let i=1;i<=sourceRows;i++)projects.get(A.account).push({id:`chan_source${i}`,name:`Source ${i}`,body:`Current ${i}`,disabled_at:null})
  let active=A,group={version:1,current:A,records:['local_fixture.json'],preserve:{}},nextId=0
  const get=(account,id)=>projects.get(account).find(row=>row.id===id)
  const stamp=(account,id)=>`${id}:${get(account,id).body}`
  const client=account=>({...account,
    async projectRequest(endpoint){
      const url=new URL(endpoint,'https://claude.ai')
      if(url.pathname==='/v1/code/channels'){calls.push(`list:${account.label}`);return{data:structuredClone(projects.get(account.account)),has_more:false}}
      const id=url.pathname.split('/').at(-1),row=get(account.account,id)
      assert.ok(row,'Unexpected project read '+endpoint)
      return{channel:structuredClone(row)}
    }
  })
  const io={
    collection:async()=>structuredClone(group),signedIn:async()=>active,
    accounts:async()=>{calls.push('verify-target');return[{...active,active:true,identityKnown:true,personal:true}]},
    clientFactory:async(_paths,expected)=>{calls.push(`desktop:${expected.label}`);assert.equal(expected.account,active.account);return client(expected)},
    sourceFactory:async()=>assert.fail('No separate source client may be loaded'),
    sourceMetadata:async()=>assert.fail('No separate source session may be read'),
    connectSource:async()=>assert.fail('No separate source sign-in may open'),
    locked:async(_paths,work)=>work(),stamp:async(source,id)=>stamp(source.account,id),
    stage:async(source,_paths,id,output)=>{
      calls.push(`stage:${id}`);const row=get(source.account,id);row.disabled_at=PAUSED
      await mkdir(path.join(output,'prepared'),{recursive:true,mode:0o700})
      const payload={id,body:row.body},bytes=JSON.stringify(payload)
      const transfer={status:'ready',sourcePaused:true,sourceDisabledAt:PAUSED,sourceStamp:stamp(source.account,id),source:{accountId:source.account,organizationId:source.org,projectId:id},payloadSha256:sha(bytes)}
      await json(path.join(output,'transfer.json'),transfer)
      await writeFile(path.join(output,'prepared','current.json'),bytes,{mode:0o600})
      return{path:output,ready:true,threads:1,transfer}
    },
    verifyStage:async prepared=>{
      calls.push('verify-stage')
      const receipt=await read(path.join(path.dirname(prepared),'transfer.json')),bytes=await readFile(path.join(prepared,'current.json'))
      if(sha(bytes)!==receipt.payloadSha256)throw Error('Saved project bytes changed')
      return{complete:true}
    },
    captureLocal:async(_paths,output,{source})=>{
      calls.push('capture-local');await mkdir(output,{mode:0o700})
      await json(path.join(output,'local.json'),{source,count:3,body:'Saved local conversations'})
      return{path:output,source,count:3}
    },
    verifyLocal:async(_paths,output,{source})=>{
      calls.push('verify-local');const captured=await read(path.join(output,'local.json'))
      if(captured.body!=='Saved local conversations'||captured.source.account!==source.account)throw Error('Saved local bytes changed')
      return{count:captured.count}
    },
    restore:async(destination,prepared)=>{
      const captured=await read(path.join(prepared,'current.json'));calls.push(`restore:${captured.id}`)
      const id=`chan_copy${++nextId}`
      projects.get(destination.account).push({id,name:captured.id,body:captured.body,disabled_at:PAUSED,created_by_account_id:destination.account,created_at:PAUSED})
      await json(path.join(path.dirname(prepared),'restore.json'),{status:'complete',verified:true,profile:{id,created_by_account_id:destination.account,created_at:PAUSED},destination:{accountId:destination.account,organizationId:destination.org,projectId:id}})
      return{restored:true,paused:true,projectId:id}
    },
    resume:async(destination,stage)=>{
      const restore=await read(path.join(stage,'restore.json'));calls.push(`resume:${restore.destination.projectId}`)
      await json(path.join(stage,'resume.json'),{status:'complete'})
      get(destination.account,restore.destination.projectId).disabled_at=null
      return{accepted:true,coordinatorStarted:null}
    }
  }
  const run=(cmd,args={})=>runProjectCommand(paths,{cmd,...args},value=>events.push(value),io)
  const state=()=>read(path.join(root,'account-projects.json'))
  const batch=async()=>{const stateValue=await state();return read(path.join(stateValue.pending??stateValue.lastBatch,'batch.json'))}
  const prepare=()=>run('project-stage-all')
  return{paths,io,events,calls,projects,run,get,state,batch,prepare,setActive:value=>{active=value},setGroup:value=>{group=value},getGroup:()=>structuredClone(group)}
}

test('Transplant saves all current projects and local conversations before an account switch',async t=>{
  const f=await fixture(t);await f.prepare()
  const ready=f.events.at(-1),batch=await f.batch()
  assert.equal(ready.ready,true);assert.equal(ready.localCount,3);assert.equal(ready.count,2)
  assert.equal(batch.phase,'ready');assert.equal(batch.target,null)
  assert.equal(f.calls.filter(row=>row.startsWith('stage:')).length,2)
  assert.ok(f.calls.includes('capture-local'))
  assert.equal(f.calls.some(row=>row.startsWith('restore:')||row.startsWith('resume:')),false)
  assert.equal(f.projects.get(B.account).length,1)
})

test('restoring after sign-out uses saved bytes without any source account access',async t=>{
  const f=await fixture(t);await f.prepare();const before=f.calls.length
  f.projects.get(A.account).length=0
  f.setActive(B)
  await f.run('project-move')
  const moved=f.events.at(-1),calls=f.calls.slice(before)
  assert.equal(moved.count,2);assert.equal(moved.localCount,3);assert.equal(moved.accepted,true)
  assert.equal(calls.some(row=>row.includes('Source')||row.startsWith('stage:')),false)
  assert.equal(calls.filter(row=>row.startsWith('restore:')).length,2)
  assert.equal(f.get(B.account,'chan_targetExisting').body,'Keep this')
  assert.ok(f.calls.indexOf('verify-local',before)<f.calls.findIndex((row,i)=>i>=before&&row.startsWith('restore:')))
})

test('status after the account switch reads only the saved local receipt',async t=>{
  const f=await fixture(t);await f.prepare();f.setActive(B)
  f.io.clientFactory=async()=>assert.fail('Ready status must not call any cloud account')
  f.io.verifyLocal=async()=>assert.fail('Status must not hash saved local files')
  f.io.verifyStage=async()=>assert.fail('Status must not hash saved project files')
  await f.run('project-status')
  const status=f.events.at(-1)
  assert.equal(status.phase,'destination');assert.equal(status.ready,true);assert.equal(status.canMove,true)
  assert.equal(status.count,2);assert.equal(status.localCount,3)
  assert.match(status.note,/saved copy/)
})

test('a ready source status does not refresh cloud data in the background',async t=>{
  const f=await fixture(t);await f.prepare()
  f.io.clientFactory=async()=>assert.fail('Ready status uses its saved receipt')
  f.io.locked=async()=>assert.fail('Status must not hold the move lock')
  f.io.verifyLocal=async()=>assert.fail('Status must not hash saved local files')
  f.io.verifyStage=async()=>assert.fail('Status must not hash saved project files')
  await f.run('project-status')
  assert.equal(f.events.at(-1).phase,'ready')
  assert.equal(f.events.at(-1).canStage,true)
  assert.equal(f.events.at(-1).canMove,false)
})

test('switching before Transplant cannot create any destination project',async t=>{
  const f=await fixture(t);f.setActive(B)
  f.io.clientFactory=async()=>assert.fail('No cloud client before a ready saved account copy')
  await assert.rejects(f.run('project-move'),/No ready local account copy/)
  await f.run('project-status')
  assert.equal(f.events.at(-1).ready,false);assert.equal(f.events.at(-1).canMove,false)
})

test('Transplant requires the source Desktop account and cannot prepare from a destination login',async t=>{
  const f=await fixture(t);f.setActive(B)
  f.io.stage=async()=>assert.fail('Wrong source must not pause a project')
  f.io.captureLocal=async()=>assert.fail('Wrong source must not copy conversations')
  await assert.rejects(f.prepare(),/source account and click Transplant before/)
})

test('an incomplete project capture cannot mark the account ready or start a restore',async t=>{
  const f=await fixture(t),stage=f.io.stage
  f.io.stage=async(...args)=>args[2]==='chan_source2'?{ready:false,path:args[3]}:stage(...args)
  await assert.rejects(f.prepare(),/project capture did not finish/)
  assert.equal((await f.batch()).phase,'capturing')
  assert.equal(f.calls.includes('capture-local'),false)
  f.setActive(B)
  await assert.rejects(f.run('project-move'),/No ready local account copy/)
  assert.equal(f.projects.get(B.account).length,1)
})

test('a failed local capture cannot mark the account ready',async t=>{
  const f=await fixture(t)
  f.io.captureLocal=async()=>{throw Error('Local file read failed')}
  await assert.rejects(f.prepare(),/Local file read failed/)
  assert.equal((await f.batch()).phase,'capturing')
  f.setActive(B)
  await assert.rejects(f.run('project-move'),/No ready local account copy/)
})

test('changed saved local or project bytes block all destination writes',async t=>{
  for(const changed of ['local','project']){
    const f=await fixture(t);await f.prepare();const batch=await f.batch()
    if(changed==='local')await json(path.join(batch.localPath,'local.json'),{source:A,count:3,body:'Changed'})
    else await json(path.join(batch.projects[1].stagePath,'prepared','current.json'),{id:'chan_source2',body:'Changed'})
    f.setActive(B)
    f.io.restore=async()=>assert.fail('Verify every saved capture before creating any destination project')
    await assert.rejects(f.run('project-move'),/Saved .* bytes changed/)
    assert.equal(f.projects.get(B.account).length,1)
  }
})

test('ready status reads the receipt without hashing data and move rejects damaged bytes before writes',async t=>{
  const f=await fixture(t);await f.prepare();const batch=await f.batch()
  await json(path.join(batch.localPath,'local.json'),{source:A,count:3,body:'Changed'})
  f.setActive(B);f.io.clientFactory=async()=>assert.fail('Status must use only its receipt')
  const verifyLocal=f.io.verifyLocal,verifyStage=f.io.verifyStage
  f.io.verifyLocal=async()=>assert.fail('Status must not hash saved local files')
  f.io.verifyStage=async()=>assert.fail('Status must not hash saved project files')
  await f.run('project-status')
  assert.equal(f.events.at(-1).ready,true)
  assert.equal(f.events.at(-1).canMove,true)
  f.io.verifyLocal=verifyLocal;f.io.verifyStage=verifyStage
  await assert.rejects(f.run('project-move'),/Saved local bytes changed/)
  assert.equal(f.projects.get(B.account).length,1)
})

test('source changes during local copying prevent Ready and a retry captures local data again',async t=>{
  for(const change of ['project','list']){
    const f=await fixture(t,{sourceRows:1}),capture=f.io.captureLocal;let first=true
    f.io.captureLocal=async(...args)=>{
      const result=await capture(...args)
      if(first){first=false;if(change==='project')f.get(A.account,'chan_source1').body='Changed during local copy';else f.projects.get(A.account).push({id:'chan_added',name:'Added during local copy',body:'Added state',disabled_at:null})}
      return result
    }
    await assert.rejects(f.prepare(),/during local copying/)
    assert.equal((await f.batch()).phase,'capturing')
    await f.prepare()
    assert.equal(f.events.at(-1).ready,true)
    assert.equal(f.calls.filter(row=>row==='capture-local').length,2)
    f.setActive(B);await f.run('project-move')
    assert.ok(f.projects.get(B.account).some(row=>row.body===(change==='project'?'Changed during local copy':'Added state')))
  }
})

test('source edits after the account switch cannot replace the saved project state',async t=>{
  const f=await fixture(t);await f.prepare()
  f.get(A.account,'chan_source1').body='A later source edit'
  f.setActive(B);await f.run('project-move')
  assert.ok(f.projects.get(B.account).some(row=>row.body==='Current 1'))
  assert.equal(f.projects.get(B.account).some(row=>row.body==='A later source edit'),false)
})

test('a project added during preparation joins the same saved account copy',async t=>{
  const f=await fixture(t,{sourceRows:1}),stage=f.io.stage
  f.io.stage=async(...args)=>{
    const result=await stage(...args)
    if(args[2]==='chan_source1')f.projects.get(A.account).push({id:'chan_added',name:'Added',body:'Added state',disabled_at:null})
    return result
  }
  await f.prepare()
  assert.equal(f.events.at(-1).count,2)
  f.setActive(B);await f.run('project-move')
  assert.ok(f.projects.get(B.account).some(row=>row.body==='Added state'))
})

test('a partial source preparation can retry without recapturing an unchanged paused project',async t=>{
  const f=await fixture(t),stage=f.io.stage;let failed=false
  f.io.stage=async(...args)=>{if(args[2]==='chan_source2'&&!failed){failed=true;throw Error('Interrupted')}return stage(...args)}
  await assert.rejects(f.prepare(),/Interrupted/)
  await f.prepare()
  assert.equal(f.calls.filter(row=>row==='stage:chan_source1').length,1)
  assert.equal(f.events.at(-1).ready,true)
})

test('an explicit fresh Transplant copy preserves the original resume choice for tool-paused sources',async t=>{
  const f=await fixture(t);await f.prepare();const old=(await f.batch()).root
  f.get(A.account,'chan_source1').body='Updated before a new preparation'
  await f.prepare()
  assert.notEqual((await f.batch()).root,old)
  assert.equal((await f.batch()).projects.every(row=>row.resumeCandidate),true)
  f.setActive(B);await f.run('project-move')
  assert.equal(f.calls.filter(row=>row.startsWith('resume:')).length,2)
  assert.ok(f.projects.get(B.account).some(row=>row.body==='Updated before a new preparation'))
})

test('a partial destination restore retries without duplicating completed projects',async t=>{
  const f=await fixture(t);await f.prepare();f.setActive(B)
  const restore=f.io.restore;let failed=false
  f.io.restore=async(...args)=>{if((await read(path.join(args[1],'current.json'))).id==='chan_source2'&&!failed){failed=true;throw Error('Upload interrupted')}return restore(...args)}
  await assert.rejects(f.run('project-move'),/Upload interrupted/)
  f.projects.get(A.account).length=0
  await f.run('project-move')
  assert.equal(f.calls.filter(row=>row==='restore:chan_source1').length,1)
  assert.equal(f.projects.get(B.account).length,3)
})

test('a lost coordinator start response reuses the same restored project',async t=>{
  const f=await fixture(t,{sourceRows:1});await f.prepare();f.setActive(B)
  const resume=f.io.resume;let failed=false
  f.io.resume=async(destination,stage)=>{await json(path.join(stage,'resume.json'),{status:'pending'});if(!failed){failed=true;throw Error('Start reply lost')}return resume(destination,stage)}
  await assert.rejects(f.run('project-move'),/Start reply lost/)
  await f.run('project-move')
  assert.equal(f.calls.filter(row=>row.startsWith('restore:')).length,1)
})

test('project completion remains ready while local conversations still need to move',async t=>{
  const f=await fixture(t);await f.prepare();f.setActive(B);await f.run('project-move')
  f.io.clientFactory=async()=>assert.fail('The completed project phase must not open a cloud client')
  const verifyLocal=f.io.verifyLocal
  f.io.verifyLocal=async()=>assert.fail('Completed status must not hash saved local files')
  f.io.verifyStage=async()=>assert.fail('Completed status must not hash saved project files')
  await f.run('project-status')
  assert.equal(f.events.at(-1).phase,'restored');assert.equal(f.events.at(-1).canMove,true)
  f.io.verifyLocal=verifyLocal
  await f.run('project-move')
  assert.equal(f.events.at(-1).alreadyCurrent,true)
  assert.equal(f.events.at(-1).count,0)
})

test('new projects on the moved account join its next prepared copy and existing destination projects stay there',async t=>{
  const f=await fixture(t);await f.prepare();f.setActive(B);await f.run('project-move')
  f.setGroup({...f.getGroup(),current:B})
  f.projects.get(B.account).push({id:'chan_newWork',name:'New work',body:'New body',disabled_at:null})
  await f.prepare()
  assert.equal(f.events.at(-1).count,3)
  f.setActive(C);await f.run('project-move')
  assert.equal(f.projects.get(C.account).some(row=>row.body==='Keep this'),false)
  assert.ok(f.projects.get(C.account).some(row=>row.body==='New body'))
})

test('an account with zero projects still captures and restores its local conversations',async t=>{
  const f=await fixture(t,{sourceRows:0});await f.prepare()
  assert.equal(f.events.at(-1).count,0);assert.equal(f.events.at(-1).localCount,3)
  f.setActive(B);await f.run('project-move')
  assert.equal(f.events.at(-1).count,0);assert.equal(f.events.at(-1).localCount,3)
})

test('paused, archived, and empty projects are restored without starting new work',async t=>{
  const f=await fixture(t,{sourceRows:3}),stage=f.io.stage
  f.get(A.account,'chan_source2').disabled_at=PAUSED
  f.get(A.account,'chan_source3').archived_at=PAUSED
  f.io.stage=async(...args)=>({...await stage(...args),hasConversationWork:args[2]!=='chan_source1'})
  await f.prepare();f.setActive(B)
  f.io.resume=async()=>assert.fail('Stopped and empty projects must stay stopped')
  await f.run('project-move')
  assert.equal(f.events.at(-1).accepted,false)
})

test('move-only leaves every restored project paused',async t=>{
  const f=await fixture(t);await f.prepare();f.setActive(B)
  f.io.resume=async()=>assert.fail('Move-only must not send continuation')
  await f.run('project-move',{noResume:true})
  assert.equal(f.events.at(-1).paused,true)
})

test('a prepared restore cannot be redirected after its destination has been bound',async t=>{
  const f=await fixture(t);await f.prepare();f.setActive(B)
  f.io.restore=async()=>{throw Error('Interrupted')}
  await assert.rejects(f.run('project-move'),/Interrupted/)
  f.setActive(C);await f.run('project-status')
  assert.equal(f.events.at(-1).canMove,false)
  await assert.rejects(f.run('project-move'),/recorded destination/)
})

test('a non-Personal target is refused before destination creation',async t=>{
  const f=await fixture(t);await f.prepare();f.setActive(B)
  f.io.accounts=async()=>[{...B,active:true,identityKnown:true,personal:false}]
  f.io.clientFactory=async()=>assert.fail('Rejected destination must not get a client')
  await assert.rejects(f.run('project-move'),/Personal Max or Pro/)
})

test('source identity changes during preparation prevent Ready to switch accounts',async t=>{
  const f=await fixture(t),capture=f.io.captureLocal
  f.io.captureLocal=async(...args)=>{const result=await capture(...args);f.setActive(B);return result}
  await assert.rejects(f.prepare(),/Desktop account changed/)
  assert.equal((await f.batch()).phase,'capturing')
})

test('cloud project pagination is complete before source capture begins',async t=>{
  const f=await fixture(t),factory=f.io.clientFactory
  f.io.clientFactory=async(...args)=>{
    const client=await factory(...args),request=client.projectRequest
    client.projectRequest=async endpoint=>{
      const url=new URL(endpoint,'https://claude.ai')
      if(url.pathname!=='/v1/code/channels')return request(endpoint)
      const rows=f.projects.get(A.account)
      return url.searchParams.get('cursor')==='two'?{data:[structuredClone(rows[1])],has_more:false}:{data:[structuredClone(rows[0])],has_more:true,next_cursor:'two'}
    }
    return client
  }
  await f.prepare()
  assert.equal(f.events.at(-1).count,2)
})

test('a separate source login is no longer part of the procedure',async t=>{
  const f=await fixture(t)
  await assert.rejects(f.run('project-connect'),/separate source login is not used/)
})
