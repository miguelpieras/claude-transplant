import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,readdir,realpath,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {connectProjectWeb,loadProjectWeb,projectWebSource} from './project-web.mjs'

const SOURCE={account:'11111111-1111-4111-8111-111111111111',org:'22222222-2222-4222-8222-222222222222'}
async function fixture(t){
  const state=await realpath(await mkdtemp(path.join(os.tmpdir(),'project-web-')))
  t.after(()=>rm(state,{recursive:true,force:true}))
  return{state}
}
const connected={...SOURCE,done:true,ok:true,email:'source@example.test'}
const connect=paths=>connectProjectWeb(paths,SOURCE,{run:async()=>({stdout:JSON.stringify(connected)})})

test('one source connection saves public metadata and no credential',async t=>{
  const paths=await fixture(t),calls=[]
  const value=await connectProjectWeb(paths,SOURCE,{run:async(binary,args,options)=>{
    calls.push({binary,args,options})
    return{stdout:JSON.stringify({...connected,cookies:[{name:'sessionKey',value:'do-not-save'}]})}
  }})
  assert.equal(value.ok,true)
  assert.equal(calls[0].args[0],'--project-source-connect')
  assert.equal(JSON.stringify(calls).includes('do-not-save'),false)
  assert.equal((await projectWebSource(paths,SOURCE)).available,true)
  const files=await readdir(path.join(paths.state,'project-connections'))
  const stored=await readFile(path.join(paths.state,'project-connections',files[0]),'utf8')
  assert.equal(stored.includes('do-not-save'),false)
  assert.equal(stored.includes('cookies'),false)
})

test('each load checks the live private source and keeps its cookies in memory',async t=>{
  const paths=await fixture(t);await connect(paths)
  let calls=0
  const value=await loadProjectWeb(paths,SOURCE,{run:async(_binary,args)=>{
    calls++;assert.equal(args[0],'--project-source-credentials')
    return{stdout:JSON.stringify({...connected,cookies:[{name:'sessionKey',value:'private-source-cookie',domain:'.claude.ai',path:'/'},{name:'foreign',value:'ignore',domain:'.example.test',path:'/'},{name:'injected',value:'unsafe; cookie',domain:'.claude.ai',path:'/'}]})}
  }})
  assert.equal(calls,1)
  assert.deepEqual(value.cookies,[['sessionKey','private-source-cookie']])
  assert.equal(JSON.stringify(await projectWebSource(paths,SOURCE)).includes('private-source-cookie'),false)
})

test('a wrong source is refused before connection metadata is saved',async t=>{
  const paths=await fixture(t)
  await assert.rejects(connectProjectWeb(paths,SOURCE,{run:async()=>({stdout:JSON.stringify({...connected,account:SOURCE.org})})}),/another account/)
  assert.equal((await projectWebSource(paths,SOURCE)).available,false)
})

test('a valid private source session recovers missing public metadata without a sign-in window',async t=>{
  const paths=await fixture(t)
  assert.equal((await projectWebSource(paths,SOURCE)).available,false)
  const result=await loadProjectWeb(paths,SOURCE,{run:async(_binary,args)=>{
    assert.equal(args[0],'--project-source-credentials')
    return{stdout:JSON.stringify({...connected,cookies:[{name:'sessionKey',value:'recovered-private-cookie',domain:'.claude.ai',path:'/'}]})}
  }})
  assert.deepEqual(result.cookies,[['sessionKey','recovered-private-cookie']])
  assert.equal((await projectWebSource(paths,SOURCE)).available,true)
  const [name]=await readdir(path.join(paths.state,'project-connections'))
  const metadata=await readFile(path.join(paths.state,'project-connections',name),'utf8')
  assert.equal(metadata.includes('recovered-private-cookie'),false)
  assert.equal(metadata.includes('cookies'),false)
})

test('a wrong private source or expired session cannot create recovered metadata',async t=>{
  const paths=await fixture(t)
  await assert.rejects(loadProjectWeb(paths,SOURCE,{run:async()=>({stdout:JSON.stringify({...connected,account:SOURCE.org,cookies:[{name:'sessionKey',value:'foreign-cookie',domain:'.claude.ai',path:'/'}]})})}),/another account/)
  assert.equal((await projectWebSource(paths,SOURCE)).available,false)
  await assert.rejects(loadProjectWeb(paths,SOURCE,{run:async()=>({stdout:JSON.stringify({...connected,cookies:[]})})}),/expired.*Move and resume/)
  assert.equal((await projectWebSource(paths,SOURCE)).available,false)
})

test('an unavailable private session asks for sign-in during Move and resume without opening a window',async t=>{
  const paths=await fixture(t),modes=[]
  await assert.rejects(loadProjectWeb(paths,SOURCE,{run:async(_binary,args)=>{modes.push(args[0]);throw new Error('Native session is unavailable')}}),/Retry Move and resume/)
  assert.deepEqual(modes,['--project-source-credentials'])
  assert.equal((await projectWebSource(paths,SOURCE)).available,false)
})

test('private helper output and errors do not appear in public errors',async t=>{
  const paths=await fixture(t);await connect(paths)
  await assert.rejects(loadProjectWeb(paths,SOURCE,{run:async()=>{throw Object.assign(new Error('secret-cookie'),{stdout:'secret-cookie',stderr:'private-source'})}}),error=>error.code==='PROJECT_SOURCE_LOGIN'&&!error.message.includes('secret-cookie')&&!error.message.includes('private-source'))
})
