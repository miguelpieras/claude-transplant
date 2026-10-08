import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {accountIdentity, accounts} from './transplant.js'
import {collection, selectSource, planLocal, moveRecords, recoverLocal, resumeReason, runLocal} from './local-workflow.mjs'

const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const name=n=>`local_${uuid(n)}.json`
const hash=value=>createHash('sha256').update(value).digest('hex')
const put=async(file,value)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value)+'\n')}
const get=async file=>JSON.parse(await readFile(file,'utf8'))
const stopped=async()=>{}

async function fixture(t) {
  const root=await mkdtemp(path.join(tmpdir(),'transplant-test-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const paths={home:root,state:path.join(root,'state'),records:path.join(root,'records'),pool:path.join(root,'pool')}
  const from={account:uuid(1),org:uuid(2),label:'source@example.com · Personal Max',identityKnown:true,personal:true,active:false}
  const to={account:uuid(3),org:uuid(4),label:'target@example.com · Personal Max',identityKnown:true,personal:true,active:true}
  const src=path.join(paths.records,from.account,from.org),dst=path.join(paths.records,to.account,to.org)
  for(const dir of [src,dst,paths.state,paths.pool])await mkdir(dir,{recursive:true})
  const original=[]
  for(let n=10;n<13;n++){
    const data={sessionId:name(n).slice(0,-5),cliSessionId:uuid(n+100),title:`Conversation ${n}`,lastActivityAt:Date.now(),...(n===11?{scheduledTaskId:'deleted-routine'}:{}),...(n===12?{forkedFromSessionId:uuid(300)}:{})}
    await put(path.join(src,name(n)),data)
    original.push(await readFile(path.join(src,name(n)),'utf8'))
  }
  await put(path.join(dst,name(20)),{sessionId:name(20).slice(0,-5),cliSessionId:uuid(120),title:'Pre-existing destination conversation'})
  const history=path.join(paths.pool,'project',`${uuid(110)}.jsonl`)
  await put(history,{type:'user',timestamp:new Date().toISOString(),message:{content:'Continue existing work'}})
  const sidecar=path.join(paths.pool,'project',uuid(110),'tasks','result.txt')
  await mkdir(path.dirname(sidecar),{recursive:true});await writeFile(sidecar,'existing result\n')
  await selectSource(paths,`${from.account}/${from.org}`,{allAccounts:[from,to]})
  const plan=await planLocal(paths,{allAccounts:[from,to]})
  return {paths,from,to,src,dst,plan,original,history,sidecar}
}

test('identity uses chat memberships and distinguishes Max from Team',()=>{
  const identity=accountIdentity({account:uuid(1),email:'new@example.com',organizations:[
    {org:uuid(2),name:'Personal organization',capabilities:['chat','claude_max']},
    {org:uuid(3),name:'Company',capabilities:['chat','raven']},
    {org:uuid(4),name:'API',capabilities:['api']}
  ]})
  assert.deepEqual(identity.organizations,[{org:uuid(2),label:'Personal Max',personal:true},{org:uuid(3),label:'Company',personal:false}])
  assert.throws(()=>accountIdentity({account:uuid(1),email:'unknown',organizations:[]}),/verified/)
})

test('planning follows the active Personal plan and refuses a Team plan',async t=>{
  const f=await fixture(t)
  assert.equal(f.plan.count,3);assert.equal(f.plan.moving,true)
  const same=await planLocal(f.paths,{allAccounts:[{...f.from,active:true},{...f.to,active:false}]})
  assert.equal(same.moving,false)
  await assert.rejects(planLocal(f.paths,{allAccounts:[f.from,{...f.to,personal:false}]}),/Personal Max or Pro/)
  await assert.rejects(planLocal(f.paths,{allAccounts:[f.from,{...f.to,identityKnown:false}]}),/verified/)
})

test('fresh setup requires an explicit source and does not need an old receipt',async t=>{
  const f=await fixture(t)
  await rm(path.join(f.paths.state,'local-workflow.json'))
  assert.equal(await collection(f.paths),null)
  assert.deepEqual(await planLocal(f.paths,{allAccounts:[f.from,f.to]}),{setup:true})
  assert.deepEqual(await readdir(f.paths.state),[])
  await assert.rejects(selectSource(f.paths,'unknown',{allAccounts:[f.from,f.to]}),/Select a source/)
  await selectSource(f.paths,`${f.from.account}/${f.from.org}`,{allAccounts:[f.from,f.to]})
  assert.equal((await planLocal(f.paths,{allAccounts:[f.from,f.to]})).count,3)
  assert.deepEqual(await readdir(f.paths.state),['local-workflow.json'])
})

test('move-only planning omits continuation requests and keeps the same account token',async t=>{
  const f=await fixture(t)
  assert(f.plan.resume.length>0)
  const plan=await planLocal(f.paths,{allAccounts:[f.from,f.to],includeResume:false})
  assert.deepEqual(plan.resume,[])
  assert.equal(plan.token,f.plan.token)
  await moveRecords(f.paths,plan,{checkStopped:stopped})
  assert.deepEqual((await collection(f.paths)).resume,[])
  const output=[]
  await runLocal(f.paths,'local-status',null,row=>output.push(row))
  assert.deepEqual(output,[{rows:[]}])
})

test('unreadable records stop a plan before any move',async t=>{
  const f=await fixture(t)
  await assert.rejects(planLocal(f.paths,{allAccounts:[{...f.from,unreadable:[{file:'broken.json'}]},f.to]}),/unreadable/)
  await assert.rejects(selectSource(f.paths,`${f.from.account}/${f.from.org}`,{allAccounts:[{...f.from,taskError:'invalid JSON'},f.to]}),/unreadable/)
})

test('new source conversations join the saved collection',async t=>{
  const f=await fixture(t)
  await put(path.join(f.src,name(31)),{sessionId:name(31).slice(0,-5),cliSessionId:uuid(131)})
  const plan=await planLocal(f.paths,{allAccounts:[f.from,f.to]})
  assert.equal(plan.count,4);assert(plan.records.includes(name(31)))
})

test('new active accounts appear before they have a session directory',async t=>{
  const f=await fixture(t)
  const paths={...f.paths,claudeApp:'/Applications/Claude.app',desktop:path.join(f.paths.home,'desktop.json'),logs:path.join(f.paths.home,'logs'),login:path.join(f.paths.home,'.claude.json'),switchAccounts:path.join(f.paths.home,'switch'),backups:path.join(f.paths.home,'backups'),agentSessions:path.join(f.paths.home,'agent')}
  await rm(f.dst,{recursive:true})
  await put(paths.desktop,{lastKnownAccountUuid:f.to.account})
  const identity={email:'new@example.com',checkedAt:new Date().toISOString(),organizations:[{org:f.to.org,label:'Personal Max',personal:true}]}
  await put(path.join(paths.state,'identities.json'),{accounts:{[f.to.account]:identity}})
  await mkdir(paths.logs)
  await writeFile(path.join(paths.logs,'main.log'),`${new Date(Date.now()-4*3600_000).toISOString().slice(0,19).replace('T',' ')} [info] [LocalSessionManager] Initialization succeeded accountId=${f.to.account}, orgId=${f.to.org}\n`)
  const processes=[{executable:'/Applications/Claude.app/Contents/MacOS/Claude',started:new Date(Date.now()-24*3600_000).toISOString()}]
  const list=await accounts(paths,processes)
  const active=list.filter(row=>row.active)
  assert.equal(active.length,1);assert.equal(active[0].email,'new@example.com');assert.equal(active[0].orgName,'Personal Max');assert.equal(active[0].sessions.length,0)
  assert.equal(active[0].identityKnown,true)
  identity.checkedAt=new Date(Date.now()-6*60_000).toISOString()
  await put(path.join(paths.state,'identities.json'),{accounts:{[f.to.account]:identity}})
  assert.equal((await accounts(paths,processes)).find(row=>row.active).identityKnown,false)
})

test('resume verification requires activity and reports a missing or changed destination record',async t=>{
  const f=await fixture(t)
  await moveRecords(f.paths,f.plan,{checkStopped:stopped})
  const group=await collection(f.paths)
  group.lastResumeAt='2000-01-01T00:00:00.000Z'
  await put(path.join(f.paths.state,'local-workflow.json'),group)
  await put(f.history,{type:'assistant',timestamp:new Date().toISOString(),message:{content:[{type:'tool_use',name:'Read'}]}})
  let output
  const check=async()=>{await runLocal(f.paths,'local-status',null,row=>{output=row});return output.rows[0]}
  assert.equal((await check()).activity,true)
  assert.equal((await check()).error,null)
  await rm(path.join(f.dst,name(10)))
  assert.match((await check()).error,/record is missing/)
  await put(path.join(f.dst,name(10)),{cliSessionId:uuid(999)})
  assert.match((await check()).error,/identity changed/)
})

test('move retains exact records, missing-history records, orphan metadata and existing destination data',async t=>{
  const f=await fixture(t)
  const before=await Promise.all([f.history,f.sidecar,path.join(f.dst,name(20))].map(file=>readFile(file,'utf8')))
  const inode=(await stat(path.join(f.src,name(10)))).ino
  assert.deepEqual(await moveRecords(f.paths,f.plan,{checkStopped:stopped}),{moved:3})
  assert.equal((await stat(path.join(f.dst,name(10)))).ino,inode)
  assert.deepEqual(await Promise.all([10,11,12].map(n=>readFile(path.join(f.dst,name(n)),'utf8'))),f.original)
  assert.deepEqual(await Promise.all([f.history,f.sidecar,path.join(f.dst,name(20))].map(file=>readFile(file,'utf8'))),before)
  assert.deepEqual((await readdir(f.src)).filter(n=>n.startsWith('local_')),[])
  assert.equal((await collection(f.paths)).current.account,f.to.account)
  await put(path.join(f.dst,name(30)),{sessionId:name(30).slice(0,-5),cliSessionId:uuid(130)})
  const next=await planLocal(f.paths,{allAccounts:[{...f.to,active:false},{...f.from,active:true}]})
  assert.equal(next.count,4);assert(!next.records.includes(name(20)))
  await moveRecords(f.paths,next,{checkStopped:stopped})
  assert.deepEqual((await readdir(f.dst)).filter(n=>n.startsWith('local_')),[name(20)])
})

for(const collision of ['filename','session','deleted'])test(`refuses ${collision} collision before moving any record`,async t=>{
  const f=await fixture(t)
  if(collision==='filename')await put(path.join(f.dst,name(10)),{unrelated:true})
  if(collision==='session')await put(path.join(f.dst,name(21)),{sessionId:name(21).slice(0,-5),cliSessionId:uuid(110)})
  if(collision==='deleted')await writeFile(path.join(f.dst,`deleted_${uuid(10)}`),'')
  const before=await readdir(f.dst)
  await assert.rejects(moveRecords(f.paths,f.plan,{checkStopped:stopped}),/collision|already has/)
  assert.deepEqual(await readdir(f.dst),before)
  assert.deepEqual(await Promise.all([10,11,12].map(n=>readFile(path.join(f.src,name(n)),'utf8'))),f.original)
})

test('a failed move restores the source and leaves history unchanged',async t=>{
  const f=await fixture(t),history=await readFile(f.history,'utf8')
  await assert.rejects(moveRecords(f.paths,f.plan,{checkStopped:stopped,afterRecord:()=>{throw Error('simulated failure')}}),/simulated failure/)
  assert.deepEqual(await Promise.all([10,11,12].map(n=>readFile(path.join(f.src,name(n)),'utf8'))),f.original)
  assert.deepEqual(await readdir(f.dst),[name(20)])
  assert.equal(await readFile(f.history,'utf8'),history)
  assert.equal((await collection(f.paths)).current.account,f.from.account)
})

test('disabled scheduled tasks and their retry state stay disabled and intact',async t=>{
  const f=await fixture(t)
  const task={id:'retained',enabled:false,notifySessionId:name(10).slice(0,-5)}
  await put(path.join(f.src,'scheduled-tasks.json'),{scheduledTasks:[task],recordedSkips:{retained:['one']},runRetries:{retained:{attempt:1}}})
  await put(path.join(f.dst,'scheduled-tasks.json'),{scheduledTasks:[{id:'other',enabled:false}],runRetries:{other:{attempt:2}}})
  await moveRecords(f.paths,f.plan,{checkStopped:stopped})
  const target=await get(path.join(f.dst,'scheduled-tasks.json'))
  assert.deepEqual(target.scheduledTasks,[{id:'other',enabled:false},task])
  assert.deepEqual(target.recordedSkips,{retained:['one']})
  assert.deepEqual(target.runRetries,{other:{attempt:2},retained:{attempt:1}})
  assert.deepEqual((await get(path.join(f.src,'scheduled-tasks.json'))).scheduledTasks,[])
})

async function crash(f) {
  const code=`import {moveRecords} from ${JSON.stringify(new URL('./local-workflow.mjs',import.meta.url).href)};await moveRecords(JSON.parse(process.argv[1]),JSON.parse(process.argv[2]),{checkStopped:async()=>{},afterRecord:()=>process.exit(99)})`
  const result=spawnSync(process.execPath,['--input-type=module','-e',code,JSON.stringify(f.paths),JSON.stringify(f.plan)],{encoding:'utf8'})
  assert.equal(result.status,99,result.stderr)
}

test('recovery after abrupt exit puts every record back before a retry',async t=>{
  const f=await fixture(t)
  await crash(f)
  assert((await readdir(f.dst)).includes(name(10)))
  const pending=await planLocal(f.paths,{allAccounts:[f.from,f.to]})
  assert.equal(pending.recovery,true)
  await assert.rejects(selectSource(f.paths,`${f.from.account}/${f.from.org}`,{allAccounts:[f.from,f.to]}),/Recover/)
  await recoverLocal(f.paths,{checkStopped:stopped})
  assert.deepEqual(await Promise.all([10,11,12].map(n=>readFile(path.join(f.src,name(n)),'utf8'))),f.original)
  await moveRecords(f.paths,f.plan,{checkStopped:stopped})
  assert.equal((await collection(f.paths)).current.account,f.to.account)
})

test('recovery refuses changed data after an abrupt exit',async t=>{
  const f=await fixture(t)
  await crash(f)
  await put(path.join(f.dst,name(10)),{changed:true})
  await assert.rejects(recoverLocal(f.paths,{checkStopped:stopped}),/record changed/)
  assert.deepEqual(await get(path.join(f.dst,name(10))),{changed:true})
})

for(const phase of ['target-written','both-written'])test(`scheduled-task recovery after ${phase} preserves disabled status and prior maps`,async t=>{
  const f=await fixture(t)
  const task={id:'retained',enabled:false,notifySessionId:name(10).slice(0,-5)}
  const other={id:'other',enabled:false}
  const source={scheduledTasks:[task,other],recordedSkips:{retained:['one'],other:['two']},runRetries:{retained:{attempt:1}}}
  const target={scheduledTasks:[]}
  await put(path.join(f.src,'scheduled-tasks.json'),source)
  await put(path.join(f.dst,'scheduled-tasks.json'),target)
  await crash(f)
  await put(path.join(f.dst,'scheduled-tasks.json'),{scheduledTasks:[task],recordedSkips:{retained:['one']},runRetries:{retained:{attempt:1}}})
  if(phase==='both-written')await put(path.join(f.src,'scheduled-tasks.json'),{scheduledTasks:[other],recordedSkips:{other:['two']},runRetries:{}})
  await recoverLocal(f.paths,{checkStopped:stopped})
  assert.deepEqual(await get(path.join(f.src,'scheduled-tasks.json')),source)
  assert.deepEqual(await get(path.join(f.dst,'scheduled-tasks.json')),target)
})

test('resume selection excludes finished work and user decisions',()=>{
  const record={cliSessionId:uuid(10),lastActivityAt:Date.now()}
  const request=[{type:'user',message:{content:'Continue'}}]
  const finished=[{type:'assistant',message:{stop_reason:'end_turn',content:[{type:'text',text:'Done'}]}}]
  assert.equal(resumeReason(record,request),'Unanswered request')
  assert.equal(resumeReason(record,finished),null)
  assert.equal(resumeReason({...record,postTurnSummary:{needs_action:'Please approve'}},request),null)
  assert.equal(resumeReason({...record,isArchived:true},request),null)
  assert.equal(resumeReason({...record,scheduledTaskId:'routine'},request),null)
  assert.equal(resumeReason({...record,lastActivityAt:1},request),null)
  assert.equal(resumeReason({...record,error:'Rate limit reached'},request),'Interrupted')
})
