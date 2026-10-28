import test from 'node:test'
import assert from 'node:assert/strict'
import {cloudClient} from './transplant.js'

const ACCOUNT='11111111-1111-4111-8111-111111111111'
const ORG='22222222-2222-4222-8222-222222222222'
async function fixture(t,respond=()=>null) {
  const calls=[]
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const endpoint=new URL(url).pathname
    if(endpoint==='/api/account')return Response.json({uuid:ACCOUNT})
    if(endpoint==='/api/organizations')return Response.json([{uuid:ORG}])
    calls.push({endpoint,options})
    assert.equal(new URL(url).origin,'https://claude.ai')
    assert.equal(options.headers['x-organization-uuid'],ORG)
    return await respond(endpoint,options)??Response.json({},{headers:{'anthropic-organization-id':ORG}})
  })
  const client=await cloudClient({}, {account:ACCOUNT,org:ORG,label:'Source'}, {active:{state:'unknown'},cookies:new Map([['sessionKey','fixture']]),userAgent:'fixture'})
  return {client,calls}
}

test('project transfer writes are scoped and cannot overwrite destination content',async t=>{
  const {client,calls}=await fixture(t)
  await client.projectWrite('/v1/code/channels',{method:'POST',body:JSON.stringify({name:'New project',visibility:'private',disabled:true})})
  await client.projectWrite('/v1/code/memory/channel/chan_target/memories',{method:'POST',body:JSON.stringify({path:'/MEMORY.md',content:'memory',precondition:{type:'not_exists'}})})
  for(const [endpoint,options] of [
    ['https://example.com',{method:'POST',body:'{}'}],
    ['/v1/code/channels/chan_target/archive',{method:'POST',body:'{}'}],
    ['/v1/code/channels/chan_target',{method:'DELETE',body:'{}'}],
    ['/v1/code/channels/chan_target/files:write',{method:'POST',body:'{"files":[{"path":"old.txt","overwrite":true}]}'}],
    ['/v1/code/memory/channel/chan_target/memories',{method:'POST',body:'{"path":"/MEMORY.md","content":"replace"}'}]
  ])assert.throws(()=>client.projectWrite(endpoint,options),/Invalid project transfer write|cannot overwrite|requires a new path/)
  assert.equal(calls.length,2)
})

test('large uploads keep the temporary grant in memory and write only to a new project path',async t=>{
  const bytes=Buffer.from('Current project bytes')
  const {client,calls}=await fixture(t,async(endpoint,options)=>{
    if(endpoint.endsWith('/files:beginUpload')){
      assert.deepEqual(JSON.parse(options.body),{size_bytes:bytes.length})
      return Response.json({filesystem_id:'fs_fixture',filestore_jwt:'temporary-fixture-grant',upload_path:'/staged/fixture'},{headers:{'anthropic-organization-id':ORG}})
    }
    if(endpoint==='/v1/filestore/fs/createFile'){
      assert.equal(options.headers.authorization,'Bearer temporary-fixture-grant')
      assert.equal(options.body instanceof FormData,true)
      assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()),bytes)
      assert.equal(JSON.parse(await options.body.get('params').text()).path,'/staged/fixture')
    }
    if(endpoint.endsWith('/files:write'))assert.deepEqual(JSON.parse(options.body),{files:[{path:'history/current.jsonl',staged_upload_path:'/staged/fixture',overwrite:false}]})
  })
  await client.projectUpload('chan_target','history/current.jsonl',bytes)
  assert.deepEqual(calls.map(row=>row.endpoint),['/v1/code/channels/chan_target/files:beginUpload','/v1/filestore/fs/createFile','/v1/code/channels/chan_target/files:write'])
  await assert.rejects(client.projectUpload('chan_target','../escape',bytes),/Invalid project upload path/)
  assert.equal(calls.length,3)
})

test('a changed response organization stops a project mutation',async t=>{
  const {client}=await fixture(t,()=>Response.json({},{headers:{'anthropic-organization-id':ACCOUNT}}))
  await assert.rejects(client.projectWrite('/v1/code/channels',{method:'POST',body:'{"name":"New"}'}),/organization changed/)
})

test('project continuation sends only plain text with one stable request ID',async t=>{
  const {client,calls}=await fixture(t)
  await client.projectWrite('/v1/code/channels/chan_target/messages',{method:'POST',body:JSON.stringify({body:'Continue the unfinished task.',client_message_id:ACCOUNT})})
  for(const body of [{body:'Continue.'},{body:'Continue.',client_message_id:ACCOUNT,session_id:'cse_foreign'},{body:'',client_message_id:ACCOUNT}]){
    assert.throws(()=>client.projectWrite('/v1/code/channels/chan_target/messages',{method:'POST',body:JSON.stringify(body)}),/stable message ID/)
  }
  assert.equal(calls.length,1)
})

test('a separate source web login is pinned while Desktop is signed into another account',async t=>{
  const calls=[]
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push(new URL(url).pathname)
    assert.equal(new URL(url).origin,'https://claude.ai')
    assert.equal(options.headers.cookie,'sessionKey=fixture-source-session')
    assert.equal(Object.hasOwn(options.headers,'authorization'),false)
    if(new URL(url).pathname==='/api/account')return Response.json({uuid:ACCOUNT,email:'source@example.test'})
    if(new URL(url).pathname==='/api/organizations')return Response.json([{uuid:ORG}])
    assert.equal(options.headers['x-organization-uuid'],ORG)
    return Response.json({channel:{id:'chan_source'}},{headers:{'anthropic-organization-id':ORG}})
  })
  const io={cookies:new Map([['sessionKey','fixture-source-session']]),userAgent:'fixture',active:{state:'known',account:ORG,org:ACCOUNT}}
  const client=await cloudClient({}, {account:ACCOUNT,org:ORG,label:'Source'}, io)
  assert.equal(client.identity.email,'source@example.test')
  assert.equal((await client.projectRequest('/v1/code/channels/chan_source')).channel.id,'chan_source')
  assert.deepEqual(calls,['/api/account','/api/organizations','/v1/code/channels/chan_source'])
  await assert.rejects(cloudClient({}, {account:ORG,org:ORG,label:'Source'}, io),/sign Claude Desktop into Source/)
  assert.equal(calls.length,4)
})
