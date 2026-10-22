import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {runProjectCommand} from './project-cli.mjs'

const A={account:'11111111-1111-4111-8111-111111111111',org:'22222222-2222-4222-8222-222222222222',label:'Source'}
const B={account:'33333333-3333-4333-8333-333333333333',org:'44444444-4444-4444-8444-444444444444',label:'Target'}
const C={account:'55555555-5555-4555-8555-555555555555',org:'66666666-6666-4666-8666-666666666666',label:'Next'}
const PAUSED='2026-10-22T12:00:00Z'
const json=(file,value)=>writeFile(file,JSON.stringify(value),{mode:0o600})
const read=async file=>JSON.parse(await readFile(file,'utf8'))
async function fixture(t,{sourceRows=2}={}){
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'account-projects-')))
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
    collection:async()=>structuredClone(group),
    signedIn:async()=>active,
    accounts:async()=>{calls.push('verify-target');return[{...active,active:true,identityKnown:true,personal:true}]},
    clientFactory:async(_paths,expected)=>{calls.push(`desktop:${expected.label}`);assert.equal(expected.account,active.account);return client(expected)},
    sourceFactory:async(_paths,expected,options)=>{calls.push(`source:${expected.label}`);return client(expected)},
    sourceMetadata:async(_paths,expected)=>({available:true,...expected}),
    connectSource:async(_paths,expected)=>{calls.push('connect');return expected},
    locked:async(_paths,work)=>work(),
    stamp:async(source,id)=>stamp(source.account,id),
    stage:async(source,_paths,id,output)=>{
      calls.push(`stage:${id}`);const row=get(source.account,id);row.disabled_at=PAUSED
      await mkdir(path.join(output,'prepared'),{recursive:true,mode:0o700})
      const transfer={status:'ready',sourcePaused:true,sourceDisabledAt:PAUSED,sourceStamp:stamp(source.account,id),source:{accountId:source.account,organizationId:source.org,projectId:id}}
      await json(path.join(output,'transfer.json'),transfer)
      await json(path.join(output,'prepared','current.json'),{id,body:row.body})
      return{path:output,ready:true,threads:1,transfer}
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
  return{paths,io,events,calls,projects,run,get,state:()=>read(path.join(root,'account-projects.json')),setActive:value=>{active=value},setGroup:value=>{group=value},getGroup:()=>structuredClone(group)}
}

test('status automatically includes every source project without a project selection or login action',async t=>{
  const f=await fixture(t)
  f.io.sourceFactory=async()=>assert.fail('Current source uses its verified Desktop login')
  f.io.connectSource=async()=>assert.fail('Status must not open a login')
  f.io.locked=async()=>assert.fail('Status must not hold the move lock')
  await f.run('project-status')
  const status=f.events.at(-1)
  assert.equal(status.count,2);assert.equal(status.allProjects,true);assert.equal(status.canMove,false)
  assert.deepEqual(status.projects.map(row=>row.id),['chan_source1','chan_source2'])
  assert.doesNotMatch(status.note,/select|Connect source/)
})

test('one move reads all latest source projects and leaves existing destination projects alone',async t=>{
  const f=await fixture(t);await f.run('project-status');f.setActive(B)
  f.get(A.account,'chan_source1').body='Changed after the status check'
  await f.run('project-move')
  assert.equal(f.events.at(-1).projectCount,2)
  assert.ok(f.projects.get(B.account).some(row=>row.body==='Changed after the status check'))
  assert.equal(f.get(B.account,'chan_targetExisting').body,'Keep this')
  assert.equal(f.calls.filter(row=>row.startsWith('stage:')).length,2)
  assert.equal(f.calls.filter(row=>row.startsWith('resume:')).length,2)
  assert.ok(f.calls.indexOf('verify-target')<f.calls.findIndex(row=>row.startsWith('source:')))
  const state=await f.state()
  assert.equal(state.current.account,B.account)
  assert.deepEqual(state.preserve[`${B.account}/${B.org}`],['chan_targetExisting'])
})

test('the collection includes new projects on its next account and preserves projects already there',async t=>{
  const f=await fixture(t);f.setActive(B);await f.run('project-move')
  f.setGroup({...f.getGroup(),current:B})
  f.projects.get(B.account).push({id:'chan_createdLater',name:'New work',body:'Later work',disabled_at:null})
  f.setActive(C);await f.run('project-move')
  assert.equal(f.events.at(-1).count,3)
  assert.equal(f.projects.get(C.account).length,3)
  assert.ok(f.projects.get(C.account).some(row=>row.body==='Later work'))
  assert.equal(f.projects.get(C.account).some(row=>row.body==='Keep this'),false)
})

test('a partial batch retries each unfinished project without copying completed projects again',async t=>{
  const f=await fixture(t);f.setActive(B)
  const stage=f.io.stage;let failed=false
  f.io.stage=async(...args)=>{if(args[2]==='chan_source2'&&!failed){failed=true;throw Error('Capture interrupted')}return stage(...args)}
  await assert.rejects(f.run('project-move'),/Capture interrupted/)
  assert.equal(f.projects.get(B.account).length,2)
  f.get(A.account,'chan_source2').body='Latest after interruption'
  await f.run('project-move')
  assert.equal(f.projects.get(B.account).length,3)
  assert.equal(f.calls.filter(row=>row==='restore:chan_source1').length,1)
  assert.ok(f.projects.get(B.account).some(row=>row.body==='Latest after interruption'))
})

test('a lost coordinator start reply reuses the same restored destination',async t=>{
  const f=await fixture(t,{sourceRows:1});f.setActive(B)
  const resume=f.io.resume;let failed=false
  f.io.resume=async(destination,stage)=>{
    await json(path.join(stage,'resume.json'),{status:'pending'})
    if(!failed){failed=true;throw Error('Start reply lost')}
    return resume(destination,stage)
  }
  await assert.rejects(f.run('project-move'),/Start reply lost/)
  await f.run('project-move')
  assert.equal(f.calls.filter(row=>row.startsWith('restore:')).length,1)
  assert.equal(f.calls.filter(row=>row.startsWith('stage:')).length,1)
  assert.equal(f.events.at(-1).accepted,true)
})

test('a retry after the project phase finishes can continue local conversations without another project move',async t=>{
  const f=await fixture(t);f.setActive(B);await f.run('project-move')
  const before=f.calls.length
  f.io.sourceFactory=async()=>assert.fail('No source login is needed for the finished project phase')
  await f.run('project-move')
  assert.equal(f.calls.length,before)
  assert.equal(f.events.at(-1).alreadyCurrent,true)
  assert.equal(f.events.at(-1).count,0)
})

test('a source project edit after its partial move blocks duplicate destination creation',async t=>{
  const f=await fixture(t);f.setActive(B)
  const stage=f.io.stage;let failed=false
  f.io.stage=async(...args)=>{if(args[2]==='chan_source2'&&!failed){failed=true;throw Error('Interrupted')}return stage(...args)}
  await assert.rejects(f.run('project-move'),/Interrupted/)
  f.get(A.account,'chan_source1').body='Changed after this project was moved'
  await assert.rejects(f.run('project-move'),/changed after a partial move/)
  assert.equal(f.projects.get(B.account).length,2)
})

test('a non-Personal destination is refused before source access or project pause',async t=>{
  const f=await fixture(t);f.setActive(B)
  f.io.accounts=async()=>[{...B,active:true,identityKnown:true,personal:false}]
  f.io.sourceFactory=async()=>assert.fail('No source access for a rejected target')
  f.io.stage=async()=>assert.fail('No source pause for a rejected target')
  await assert.rejects(f.run('project-move'),/Personal Max or Pro/)
})

test('missing source access and an incomplete destination index stop before project pause',async t=>{
  for(const failure of ['source','destination']){
    const f=await fixture(t);f.setActive(B)
    f.io.stage=async()=>assert.fail('Preflight must finish before any source pause')
    if(failure==='source')f.io.sourceFactory=async()=>{throw Error('Source login unavailable')}
    else{
      const factory=f.io.clientFactory
      f.io.clientFactory=async(...args)=>{const client=await factory(...args);client.projectRequest=async()=>({data:[],has_more:true});return client}
    }
    await assert.rejects(f.run('project-move'),failure==='source'?/Source login unavailable/:/list is incomplete/)
  }
})

test('project discovery reads every page before pausing and captures every page result',async t=>{
  const f=await fixture(t);f.setActive(B)
  const factory=f.io.sourceFactory
  f.io.sourceFactory=async(...args)=>{
    const client=await factory(...args),request=client.projectRequest
    client.projectRequest=async endpoint=>{
      const url=new URL(endpoint,'https://claude.ai')
      if(url.pathname!=='/v1/code/channels')return request(endpoint)
      const rows=f.projects.get(A.account)
      return url.searchParams.get('cursor')==='page-two'?{data:[structuredClone(rows[1])],has_more:false}:{data:[structuredClone(rows[0])],has_more:true,next_cursor:'page-two'}
    }
    return client
  }
  await f.run('project-move')
  assert.equal(f.events.at(-1).count,2)
})

test('a repeated project list cursor is refused before any pause',async t=>{
  const f=await fixture(t);f.setActive(B)
  f.io.sourceFactory=async()=>({...A,projectRequest:async endpoint=>({data:[],next_cursor:'repeated',has_more:true})})
  f.io.stage=async()=>assert.fail('Incomplete source discovery must not pause projects')
  await assert.rejects(f.run('project-move'),/cursor did not advance/)
})

test('a project added during the move joins that same account move',async t=>{
  const f=await fixture(t,{sourceRows:1});f.setActive(B)
  const stage=f.io.stage
  f.io.stage=async(...args)=>{
    const result=await stage(...args)
    if(args[2]==='chan_source1')f.projects.get(A.account).push({id:'chan_addedDuringMove',name:'Added',body:'New state',disabled_at:null})
    return result
  }
  await f.run('project-move')
  assert.equal(f.events.at(-1).count,2)
  assert.equal(f.projects.get(B.account).length,3)
})

test('an account with no projects still completes its project phase before local conversations',async t=>{
  const f=await fixture(t,{sourceRows:0});f.setActive(B)
  f.io.stage=async()=>assert.fail('There are no source projects to pause')
  await f.run('project-move')
  assert.equal(f.events.at(-1).count,0)
  assert.equal((await f.state()).current.account,B.account)
})

test('paused and archived source projects keep their stopped state after transfer',async t=>{
  const f=await fixture(t,{sourceRows:3});f.setActive(B)
  f.get(A.account,'chan_source2').disabled_at=PAUSED
  f.get(A.account,'chan_source3').archived_at=PAUSED
  await f.run('project-move')
  assert.equal(f.events.at(-1).count,3)
  assert.equal(f.calls.filter(row=>row.startsWith('resume:')).length,1)
})

test('move-only transfers all projects without a coordinator continuation',async t=>{
  const f=await fixture(t);f.setActive(B)
  f.io.resume=async()=>assert.fail('Move-only must not send a continuation')
  await f.run('project-move',{noResume:true})
  assert.equal(f.events.at(-1).paused,true)
  assert.equal(f.events.at(-1).accepted,false)
})

test('a source connection can complete inside the main move flow without a selection',async t=>{
  const f=await fixture(t)
  f.io.locked=async()=>assert.fail('Interactive login must not hold the move lock')
  await f.run('project-connect')
  assert.equal(f.events.at(-1).sourceConnected,true)
  assert.equal(f.events.at(-1).allProjects,true)
})

test('changing the Desktop target during a source capture stops before destination creation',async t=>{
  const f=await fixture(t);f.setActive(B)
  const stage=f.io.stage
  f.io.stage=async(...args)=>{const result=await stage(...args);f.setActive(C);return result}
  f.io.restore=async()=>assert.fail('Changed Desktop target must not receive a project')
  await assert.rejects(f.run('project-move'),/destination changed/)
  assert.equal(f.projects.get(B.account).length,1)
  assert.equal(f.projects.get(C.account).length,0)
})

test('a pending account batch cannot be redirected to a different Desktop account',async t=>{
  const f=await fixture(t);f.setActive(B)
  f.io.stage=async()=>{throw Error('Capture interrupted')}
  await assert.rejects(f.run('project-move'),/Capture interrupted/)
  f.setActive(C)
  f.io.sourceFactory=async()=>assert.fail('Do not load source credentials for a redirected pending batch')
  await assert.rejects(f.run('project-move'),/recorded destination/)
})

test('advanced single-project staging remains available without changing the all-project scope',async t=>{
  const f=await fixture(t)
  await f.run('project-select',{source:`${A.account}/${A.org}`,project:'chan_source1'})
  await f.run('project-stage')
  assert.equal(f.events.at(-1).sourcePaused,true)
  await f.run('project-status')
  assert.equal(f.events.at(-1).count,2)
  assert.equal(f.events.at(-1).allProjects,true)
})

test('a missing or changed completed destination blocks a partial retry without a duplicate',async t=>{
  for(const change of ['missing','owner']){
    const f=await fixture(t);f.setActive(B)
    const stage=f.io.stage;let failed=false
    f.io.stage=async(...args)=>{if(args[2]==='chan_source2'&&!failed){failed=true;throw Error('Interrupted')}return stage(...args)}
    await assert.rejects(f.run('project-move'),/Interrupted/)
    if(change==='missing')f.projects.get(B.account).splice(1,1)
    else f.projects.get(B.account)[1].created_by_account_id=A.account
    await assert.rejects(f.run('project-move'),/destination project is missing or its owner changed/)
    assert.equal(f.calls.filter(row=>row.startsWith('restore:')).length,1)
  }
})

test('an empty project transfers without starting new conversation work',async t=>{
  const f=await fixture(t,{sourceRows:1});f.setActive(B)
  const stage=f.io.stage
  f.io.stage=async(...args)=>({...await stage(...args),hasConversationWork:false})
  f.io.resume=async()=>assert.fail('Empty project must not get a new task')
  await f.run('project-move')
  assert.equal(f.events.at(-1).count,1)
  assert.equal(f.events.at(-1).accepted,false)
  assert.equal(f.events.at(-1).paused,true)
})

test('a slow status read cannot erase an account move receipt written while it was reading',async t=>{
  const f=await fixture(t)
  const factory=f.io.clientFactory
  const pending=path.join(f.paths.state,'project-batches','pending')
  f.io.clientFactory=async(...args)=>{
    const client=await factory(...args),request=client.projectRequest
    client.projectRequest=async endpoint=>{
      const result=await request(endpoint)
      await json(path.join(f.paths.state,'account-projects.json'),{version:1,current:A,ids:[],preserve:{},pending,localAnchor:null})
      return result
    }
    return client
  }
  await f.run('project-status')
  assert.equal((await f.state()).pending,pending)
})
