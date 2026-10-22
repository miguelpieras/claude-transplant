import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, readFile, realpath, rm, mkdir, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {runProjectCommand} from './project-cli.mjs'

const SOURCE={account:'11111111-1111-4111-8111-111111111111',org:'22222222-2222-4222-8222-222222222222',label:'Source'}
const TARGET={account:'33333333-3333-4333-8333-333333333333',org:'44444444-4444-4444-8444-444444444444',label:'Target'}
const PROJECT='chan_source'
async function fixture(t) {
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'project-cli-')))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const paths={state:root},events=[]
  let active=SOURCE
  const client={account:SOURCE.account,org:SOURCE.org,projectRequest:async()=>({channel:{id:PROJECT,name:'Founderizer',disabled_at:'2026-10-22T12:00:00Z'}})}
  const io={signedIn:async()=>active,clientFactory:async(_paths,expected)=>{assert.equal(expected.account,active.account);return {...client,account:active.account,org:active.org}},locked:async(_paths,work)=>work(),accounts:async()=>[{...active,active:true,identityKnown:true,personal:true}]}
  const run=(cmd,args={})=>runProjectCommand(paths,{cmd,...args},event=>events.push(event),io)
  const selected=()=>readFile(path.join(root,'project-selection.json'),'utf8').then(JSON.parse)
  const select=()=>run('project-select',{source:`${SOURCE.account}/${SOURCE.org}`,project:PROJECT})
  const ready=async()=>{
    const stage=path.join(root,'stage')
    await mkdir(stage,{recursive:true,mode:0o700})
    const transfer={status:'ready',sourcePaused:true,sourceDisabledAt:'2026-10-22T12:00:00Z',sourceStamp:'current',source:{accountId:SOURCE.account,organizationId:SOURCE.org,projectId:PROJECT},readyAt:'2026-10-22T12:05:00Z'}
    await writeFile(path.join(stage,'transfer.json'),JSON.stringify(transfer),{mode:0o600})
    const value=await selected();value.stagePath=stage
    await writeFile(path.join(root,'project-selection.json'),JSON.stringify(value),{mode:0o600})
    return stage
  }
  return {paths,io,events,run,select,selected,ready,setActive:value=>{active=value}}
}

test('selects an exact project only in its verified source account',async t=>{
  const f=await fixture(t)
  await assert.rejects(f.run('project-select',{source:`${TARGET.account}/${TARGET.org}`,project:PROJECT}),/source account/)
  await f.select()
  assert.equal((await f.selected()).projectId,PROJECT)
  assert.equal((await f.selected()).stagePath,null)
})

test('preparation reads current state each time and invalidates an old stage before a failed capture',async t=>{
  const f=await fixture(t);await f.select();const previous=await f.ready()
  let calls=0
  f.io.stage=async(client,paths,id,output)=>{
    calls++
    assert.equal(client.account,SOURCE.account)
    assert.equal(id,PROJECT)
    assert.notEqual(output,previous)
    assert.equal((await f.selected()).stagePath,null)
    throw new Error('Source changed during capture')
  }
  await assert.rejects(f.run('project-stage'),/Source changed/)
  assert.equal(calls,1)
  assert.equal((await f.selected()).stagePath,null)
})

test('a ready source is invalidated when its latest state differs from the capture',async t=>{
  const f=await fixture(t);await f.select();await f.ready()
  f.io.stamp=async()=> 'changed'
  await f.run('project-status')
  assert.equal((await f.selected()).stagePath,null)
  assert.match(f.events.at(-1).note,/changed after preparation/)
})

test('transfer requires the prepared source and a verified Personal destination',async t=>{
  const f=await fixture(t);await f.select()
  await assert.rejects(f.run('project-move'),/Switch to the destination/)
  f.setActive(TARGET)
  await assert.rejects(f.run('project-move'),/Prepare the latest/)
  await f.ready()
  f.io.accounts=async()=>[{...TARGET,active:true,identityKnown:true,personal:false}]
  await assert.rejects(f.run('project-move'),/Personal Max or Pro/)
})

test('project selection follows the new target so another transfer captures its latest state',async t=>{
  const f=await fixture(t);await f.select();const stage=await f.ready();f.setActive(TARGET)
  let restores=0
  f.io.restore=async(client,prepared)=>{
    restores++;assert.equal(client.account,TARGET.account)
    assert.equal(prepared,path.join(stage,'prepared'))
    return {restored:true,paused:true,projectId:'chan_newTarget'}
  }
  await f.run('project-move')
  assert.equal(restores,1)
  assert.deepEqual(await f.selected(),{version:1,source:TARGET,projectId:'chan_newTarget',title:'Founderizer',stagePath:null})
  await f.run('project-status')
  assert.equal(f.events.at(-1).canStage,true)
  assert.equal(f.events.at(-1).canMove,false)
  assert.equal(f.events.at(-1).projectId,'chan_newTarget')
})
