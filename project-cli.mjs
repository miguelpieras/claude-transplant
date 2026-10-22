import {randomUUID} from 'node:crypto'
import {lstat, mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {accounts, cloudClient, locked, signedIn} from './transplant.js'
import {stageProjectTransfer, restoreProjectTransfer, projectTransferStamp} from './project-transfer.mjs'
import {createProjectArtifactTextExporter} from './project-artifacts.mjs'

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const PROJECT = /^chan_[A-Za-z0-9]+$/
const same = (a,b) => a?.account===b?.account && a?.org===b?.org
const ref = value => ({account:value.account,org:value.org,label:value.label??value.account})
const read = async file => {
  try {
    const info=await lstat(file)
    if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw new Error('Project selection must be a private regular file')
    return JSON.parse(await readFile(file,'utf8'))
  } catch(error) { if(error.code==='ENOENT')return null;throw error }
}
const save = async (file,value) => {
  await mkdir(path.dirname(file),{recursive:true,mode:0o700})
  const temporary=`${file}.${randomUUID()}.tmp`
  await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600})
  try {await rename(temporary,file)} finally {await unlink(temporary).catch(()=>{})}
}
function selection(value) {
  if(value && (value.version!==1||!ID.test(value.source?.account??'')||!ID.test(value.source?.org??'')||!PROJECT.test(value.projectId??'')||typeof value.title!=='string'))throw new Error('Invalid project selection')
  return value
}

export async function runProjectCommand(paths,args,emit,io={}) {
  const factory=io.clientFactory??cloudClient
  const current=await (io.signedIn??signedIn)(paths)
  if(!ID.test(current.account??'')||!ID.test(current.org??''))throw new Error('Sign into Claude Desktop before you select or transfer a project')
  const file=path.join(paths.state,'project-selection.json')
  const active=ref(current)
  const progress=text=>emit({text})
  const work=async()=>{
    const selected=selection(await read(file))
    if(args.cmd==='project-status') {
      const status={selected:!!selected,current:active,canStage:false,canMove:false,projects:[]}
      if(!selected) {
        try {
          const client=await factory(paths,active)
          const value=await client.projectRequest('/v1/code/channels?scope=joined&include_archived=true&include_members=true&limit=200')
          if(!Array.isArray(value?.data)||value.has_more===true||value.next_cursor)throw new Error('Project list is incomplete')
          status.projects=value.data.filter(row=>PROJECT.test(row.id??'')&&typeof row.name==='string').map(({id,name})=>({id,name}))
        } catch {status.note='The project list could not be read. Local conversation moves remain available.'}
        return emit(status)
      }
      Object.assign(status,{title:selected.title,projectId:selected.projectId,source:selected.source,canStage:same(active,selected.source)})
      const transfer=selected.stagePath?await read(path.join(selected.stagePath,'transfer.json')):null
      const ready=transfer?.status==='ready'&&transfer.sourcePaused===true&&transfer.source?.projectId===selected.projectId&&transfer.source?.accountId===selected.source.account&&transfer.source?.organizationId===selected.source.org
      if(ready) {
        status.preparedAt=transfer.readyAt
        status.canMove=!same(active,selected.source)
        status.note='Latest captured state is held in the paused source. Switch accounts, then transplant the project. Keep the source paused.'
      } else status.note=same(active,selected.source)?'Prepare before you switch accounts. This pauses the project and captures its latest state. Its workers must be idle.':'Sign into the project source and prepare its latest state before you switch accounts.'
      // A stage stops being usable if the source is opened and enabled again.
      if(ready&&same(active,selected.source)) {
        const client=await factory(paths,selected.source)
        const response=await client.projectRequest(`/v1/code/channels/${selected.projectId}`)
        const stamp=await (io.stamp??projectTransferStamp)(client,selected.projectId)
        if(!response?.channel?.disabled_at || response.channel.disabled_at!==transfer.sourceDisabledAt || stamp!==transfer.sourceStamp) {
          selected.stagePath=null
          await save(file,selected)
          status.preparedAt=null
          status.note='The source changed after preparation. Prepare its latest state again before you switch.'
        }
      }
      return emit(status)
    }
    if(args.cmd==='project-select') {
      if(args.source!==`${current.account}/${current.org}`)throw new Error('Select a project while signed into its source account and plan')
      if(selected?.stagePath)throw new Error('Finish the prepared project transfer before you select another source')
      const client=await factory(paths,active)
      const response=await client.projectRequest(`/v1/code/channels/${args.project}`)
      if(response?.channel?.id!==args.project||typeof response.channel.name!=='string')throw new Error('The selected project could not be verified')
      const next={version:1,source:{...active,label:client.identity?.email??active.label},projectId:args.project,title:response.channel.name,stagePath:null}
      await save(file,next)
      return emit({done:true,ok:true,selected:true,title:next.title,projectId:next.projectId,source:next.source})
    }
    if(!selected)throw new Error('Select the project while signed into its source account first')
    if(args.cmd==='project-stage') {
      if(!same(active,selected.source))throw new Error('Sign into the selected project source before you prepare its latest state')
      const client=await factory(paths,selected.source)
      const parent=path.join(paths.state,'project-transfers')
      await mkdir(parent,{recursive:true,mode:0o700})
      const output=path.join(parent,`${selected.projectId}-${randomUUID()}`)
      selected.stagePath=null
      await save(file,selected)
      const exportArtifact=io.exportArtifact??client.projectArtifactText??createProjectArtifactTextExporter({binary:path.join(paths.state,'Claude Transplant Resume.app/Contents/MacOS/Claude Transplant Resume'),account:client.account,org:client.org})
      const result=await (io.stage??stageProjectTransfer)(client,paths,selected.projectId,output,{report:progress,exportArtifact})
      if(!result.ready)throw new Error('Project preparation did not finish. Keep the source account open and retry.')
      selected.stagePath=result.path
      await save(file,selected)
      return emit({done:true,ok:true,title:selected.title,threads:result.threads,preparedAt:result.transfer.readyAt,sourcePaused:true})
    }
    if(args.cmd==='project-move') {
      if(same(active,selected.source))throw new Error('Switch to the destination Personal plan before you transplant the prepared project')
      if(!selected.stagePath)throw new Error('Prepare the latest project state in the source account before you switch')
      const all=await (io.accounts??accounts)(paths,null,{verifyIdentity:true})
      const to=all.find(row=>row.active)
      if(!to?.identityKnown||!to.personal||!same(to,active))throw new Error('Select a verified Personal Max or Pro destination in Claude Desktop')
      const client=await factory(paths,active)
      const result=await (io.restore??restoreProjectTransfer)(client,path.join(selected.stagePath,'prepared'),{report:progress})
      if(!result.restored||!result.paused||!PROJECT.test(result.projectId??''))throw new Error('The destination project has not been verified')
      const next={version:1,source:ref(to),projectId:result.projectId,title:selected.title,stagePath:null}
      await save(file,next)
      return emit({done:true,ok:true,title:next.title,projectId:next.projectId,target:active,paused:true,nativeHistoryImport:false,autoResume:false})
    }
    throw new Error('Unknown project workflow command')
  }
  return (io.locked??locked)(paths,work)
}
