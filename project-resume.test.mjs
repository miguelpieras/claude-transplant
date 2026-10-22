import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {chmod,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {resumeProjectTransfer} from './project-resume.mjs'

const SOURCE='11111111-1111-4111-8111-111111111111',SOURCE_ORG='22222222-2222-4222-8222-222222222222'
const TARGET='33333333-3333-4333-8333-333333333333',TARGET_ORG='44444444-4444-4444-8444-444444444444'
const TAGGED_TARGET='user_017KhXzYt7qMpxh9cLZ8cW5G',NOW='2026-10-22T10:00:00Z'
const clone=value=>JSON.parse(JSON.stringify(value))
const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex')
async function fixture(t){
  const dir=await mkdtemp(path.join(await realpath(tmpdir()),'project-resume-'));await chmod(dir,0o700)
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const source={accountId:SOURCE,organizationId:SOURCE_ORG,projectId:'chan_source',title:'Source',capturedAt:NOW}
  const destination={accountId:TARGET,organizationId:TARGET_ORG,projectId:'chan_target'}
  const channel={id:'chan_target',name:'Source',topic:null,icon:null,color:null,visibility:'private',created_by_account_id:TAGGED_TARGET,created_at:NOW,disabled_at:NOW}
  const config={agent_id:'cagt_destination',default_environment_id:'',memory_enabled:true}
  const transfer={schemaVersion:1,kind:'claude-code-project-transfer',status:'ready',sourcePaused:true,source,nativeHistoryImport:false,preparationSha256:'a'.repeat(64)}
  const restore={schemaVersion:1,kind:'claude-code-project-restore',status:'complete',verified:true,source,destination,nativeHistoryImport:false,preparationSha256:transfer.preparationSha256,profile:clone(channel),configSha256:hash(config)}
  const save=async(name,value)=>writeFile(path.join(dir,name),JSON.stringify(value),{mode:0o600})
  const receipt=async()=>JSON.parse(await readFile(path.join(dir,'resume.json'),'utf8'))
  await save('transfer.json',transfer);await save('restore.json',restore)
  const state={channel,config,rows:[],calls:[],sendMode:'normal',failTimelineAfterSend:false,pageSize:0}
  const client={account:TARGET,org:TARGET_ORG,
    async projectRequest(endpoint){
      state.calls.push({method:'GET',endpoint})
      if(endpoint==='/v1/code/channels/chan_target')return{channel:clone(channel)}
      if(endpoint.endsWith('/config'))return{config:clone(config)}
      if(endpoint.includes('/timeline?')){
        if(state.failTimelineAfterSend&&state.calls.some(call=>call.method==='POST')){state.failTimelineAfterSend=false;throw Error('Timeline read failed')}
        const query=new URL(endpoint,'https://claude.ai').searchParams,index=Number(query.get('cursor')??0),size=state.pageSize||200
        return{data:clone(state.rows.slice(index,index+size)),next_cursor:index+size<state.rows.length?String(index+size):null}
      }
      throw Error(`Unexpected read: ${endpoint}`)
    },
    async projectWrite(endpoint,options){
      const body=JSON.parse(options.body),saved=await receipt()
      assert.match(saved.client_message_id,/^[a-f0-9-]{36}$/)
      state.calls.push({method:options.method,endpoint,body})
      if(options.method==='PATCH'){assert.deepEqual(body,{disabled:false});channel.disabled_at=null;return{channel:clone(channel)}}
      assert.equal(endpoint,'/v1/code/channels/chan_target/messages')
      assert.equal(body.client_message_id,saved.client_message_id);assert.equal(body.body,saved.body)
      if(state.sendMode==='fail-before-store'){state.sendMode='normal';throw Error('Network failed before acceptance')}
      const existing=state.rows.find(row=>row.client_message_id===body.client_message_id)
      if(!existing)state.rows.push({id:'cmsg_resume',thread_root_id:'cmsg_resume',channel_id:channel.id,author_account_id:TARGET,client_message_id:body.client_message_id,body:body.body,created_at:NOW})
      if(state.sendMode==='lost-response'){state.sendMode='normal';throw Error('Message response lost')}
      return{message_id:'cmsg_resume',thread_root_id:'cmsg_resume',created_at:NOW}
    }
  }
  return{dir,transfer,restore,client,state,save,receipt,resume:()=>resumeProjectTransfer(client,dir)}
}
const posts=f=>f.state.calls.filter(call=>call.method==='POST')
const writes=f=>f.state.calls.filter(call=>call.method!=='GET')

test('resume saves one request ID before unpause and verifies the exact accepted user message',async t=>{
  const f=await fixture(t),result=await f.resume(),saved=await f.receipt()
  assert.equal(result.resumed,true);assert.equal(result.accepted,true);assert.equal(result.coordinatorStarted,null)
  assert.equal(saved.status,'complete');assert.equal(saved.verified,true);assert.equal(saved.nativeHistoryImport,false)
  assert.equal(f.state.channel.disabled_at,null);assert.equal(posts(f).length,1)
  assert.deepEqual(writes(f).map(call=>call.method),['PATCH','POST'])
  assert.match(posts(f)[0].body.body,/migration\/chan_source\/main-transcript\.md/)
  assert.match(posts(f)[0].body.body,/\/MEMORY\.md/);assert.match(posts(f)[0].body.body,/Do not repeat completed or resolved tasks/)
  await f.resume()
  assert.equal(posts(f).length,1);assert.equal((await f.receipt()).client_message_id,saved.client_message_id)
})

test('a lost response is recovered from the destination timeline without a second start',async t=>{
  const f=await fixture(t);f.state.sendMode='lost-response'
  assert.equal((await f.resume()).accepted,true)
  await f.resume();assert.equal(posts(f).length,1)
})

test('a failed send retry uses the same UUID after the project was unpaused',async t=>{
  const f=await fixture(t);f.state.sendMode='fail-before-store'
  await assert.rejects(f.resume(),/Network failed before acceptance/)
  const first=await f.receipt();assert.equal(first.status,'pending');assert.equal(f.state.channel.disabled_at,null)
  await f.resume()
  assert.equal(posts(f).length,2);assert.equal(posts(f)[0].body.client_message_id,posts(f)[1].body.client_message_id)
  assert.equal((await f.receipt()).client_message_id,first.client_message_id);assert.equal(f.state.rows.length,1)
  assert.equal(writes(f).filter(call=>call.method==='PATCH').length,1)
})

test('a failed read after an accepted send recovers before any new send',async t=>{
  const f=await fixture(t);f.state.failTimelineAfterSend=true
  await assert.rejects(f.resume(),/Timeline read failed/)
  assert.equal((await f.receipt()).messageId,'cmsg_resume')
  await f.resume();assert.equal(posts(f).length,1)
})

test('cross-account, unverified restore, changed owner or settings, and absent destination agent block writes',async t=>{
  for(const change of ['account','source','verified','owner','settings','agent','active','new-work','mode']){
    const f=await fixture(t)
    if(change==='account')f.client.account=SOURCE
    if(change==='source'){f.restore.source.projectId='chan_other';await f.save('restore.json',f.restore)}
    if(change==='verified'){f.restore.verified=false;await f.save('restore.json',f.restore)}
    if(change==='owner')f.state.channel.created_by_account_id=SOURCE
    if(change==='settings')f.state.config.memory_enabled=false
    if(change==='agent'){delete f.state.config.agent_id;f.restore.configSha256=hash(f.state.config);await f.save('restore.json',f.restore)}
    if(change==='active')f.state.channel.disabled_at=null
    if(change==='new-work')f.state.rows.push({id:'cmsg_other',body:'Unrelated work'})
    if(change==='mode')await chmod(path.join(f.dir,'restore.json'),0o644)
    await assert.rejects(f.resume(),/verified|match|identity|owner|changed|agent|paused|other conversation|private/)
    assert.equal(writes(f).length,0,change)
  }
})

test('a retry scans all timeline pages and refuses a mismatched or duplicate saved request',async t=>{
  const f=await fixture(t);await f.resume();f.state.pageSize=1
  f.state.rows.unshift({id:'cmsg_assistant',body:'Coordinator output',channel_id:'chan_target',author_agent_id:'cagt_destination'})
  await f.resume();assert.equal(posts(f).length,1)
  f.state.rows[1].body='Changed request'
  await assert.rejects(f.resume(),/does not match/);assert.equal(posts(f).length,1)
  f.state.rows[1].body=(await f.receipt()).body
  f.state.rows.push(clone(f.state.rows[1]))
  await assert.rejects(f.resume(),/ambiguous/);assert.equal(posts(f).length,1)
})
