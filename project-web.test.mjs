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
    return{stdout:JSON.stringify({...SOURCE,cookies:[{name:'sessionKey',value:'private-source-cookie',domain:'.claude.ai',path:'/'},{name:'foreign',value:'ignore',domain:'.example.test',path:'/'},{name:'injected',value:'unsafe; cookie',domain:'.claude.ai',path:'/'}]})}
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

test('a missing or expired source asks for Connect source without a Desktop switch',async t=>{
  const paths=await fixture(t)
  await assert.rejects(loadProjectWeb(paths,SOURCE,{run:async()=>assert.fail('No credential request before connection')}),/Connect source/)
  await connect(paths)
  await assert.rejects(loadProjectWeb(paths,SOURCE,{run:async()=>({stdout:JSON.stringify({...SOURCE,cookies:[]})})}),/expired/)
})

test('private helper output and errors do not appear in public errors',async t=>{
  const paths=await fixture(t);await connect(paths)
  await assert.rejects(loadProjectWeb(paths,SOURCE,{run:async()=>{throw Object.assign(new Error('secret-cookie'),{stdout:'secret-cookie',stderr:'private-source'})}}),error=>error.code==='PROJECT_SOURCE_LOGIN'&&!error.message.includes('secret-cookie')&&!error.message.includes('private-source'))
})
