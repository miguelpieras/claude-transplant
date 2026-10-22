import assert from 'node:assert/strict'
import test from 'node:test'
import {createProjectArtifactTextExporter,exportCurrentProjectArtifact} from './project-artifacts.mjs'

const account='11111111-1111-1111-1111-111111111111',org='22222222-2222-2222-2222-222222222222',id='33333333-3333-3333-3333-333333333333',projectId='chan_example'
const metadata={id,title:'A report',updatedAt:'2026-10-22T15:00:00Z'},indexEntry={id,updated_at:metadata.updatedAt}
const fixture=(changes={})=>({binary:'/Applications/Claude Transplant Resume.app/Contents/MacOS/Claude Transplant Resume',account,org,id,projectId,metadata,indexEntry,...changes})
const exported=(changes={})=>({ok:true,documentIdVerified:true,id,organizationId:org,accountId:account,projectId,text:'The current report text.',links:[{text:'Source',url:'https://example.com/source'}],...changes})
const output=value=>({stdout:JSON.stringify(value)})

test('exports each report through the installed helper on each call, with exact source identities',async()=>{
  const calls=[]
  const run=async(binary,args,options)=>{calls.push({binary,args,options});return output(exported({text:`Current text ${calls.length}.`}))}
  const exporter=createProjectArtifactTextExporter({binary:fixture().binary,account,org,run})
  const first=await exporter({id,projectId,metadata,indexEntry}),second=await exporter({id,projectId,metadata,indexEntry})
  assert.equal(calls.length,2)
  assert.deepEqual(calls[0].args,['--project-artifact-export',id,'--organization',org,'--account',account,'--project',projectId,'--title',metadata.title])
  assert.equal(calls[0].options.timeout,30000)
  assert.match(first.bytes.toString(),/Current text 1/)
  assert.match(second.bytes.toString(),/Current text 2/)
  assert.match(second.bytes.toString(),/Source: https:\/\/example.com\/source/)
  assert.equal(second.updatedAt,metadata.updatedAt)
  assert.equal(second.nativeStateCaptured,false)
})

test('refuses a stale report index before opening the app',async()=>{
  let called=false
  await assert.rejects(exportCurrentProjectArtifact(fixture({indexEntry:{id,updated_at:'2026-10-22T14:00:00Z'},run:async()=>{called=true}})),/metadata does not match/)
  assert.equal(called,false)
})

test('refuses a duplicate title with another document identity',async()=>{
  for(const change of [{id:org},{accountId:org},{organizationId:account},{projectId:'chan_other'},{documentIdVerified:false}]){
    await assert.rejects(exportCurrentProjectArtifact(fixture({run:async()=>output(exported(change))})),/document identity/)
  }
})

test('returns actionable locked and permission errors without using a saved export',async()=>{
  for(const [message,code] of [['Unlock the Mac and run the project capture again. No saved report was used.','PROJECT_REPORT_LOCKED'],['Enable Claude Transplant Resume in System Settings > Privacy & Security > Accessibility, then run the project capture again.','PROJECT_REPORT_ACCESSIBILITY']]){
    const run=async()=>{throw Object.assign(new Error('secret transport error'),{stdout:JSON.stringify({ok:false,error:message}),stderr:'access-bearing URL'})}
    await assert.rejects(exportCurrentProjectArtifact(fixture({run})),error=>error.message===message&&error.code===code)
  }
})

test('redacts arbitrary process output and refuses malformed exports',async()=>{
  const run=async()=>{throw Object.assign(new Error('secret token'),{stdout:JSON.stringify({ok:false,error:'secret token'}),stderr:'secret token'})}
  await assert.rejects(exportCurrentProjectArtifact(fixture({run})),error=>!error.message.includes('secret')&&error.code==='PROJECT_REPORT_UNAVAILABLE')
  for(const result of [{stdout:'not JSON'},output(exported({text:''})),output(exported({links:[{text:'Viewer',url:'https://example.com/?__frame_t=secret'}]})),output(exported({links:[{text:'Code',url:'javascript:alert(1)'}]}))]){
    await assert.rejects(exportCurrentProjectArtifact(fixture({run:async()=>result})))
  }
})
