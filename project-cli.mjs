import {randomUUID} from 'node:crypto'
import {lstat, mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {accounts, cloudClient, locked, signedIn} from './transplant.js'
import {stageProjectTransfer, restoreProjectTransfer, projectTransferStamp} from './project-transfer.mjs'
import {resumeProjectTransfer} from './project-resume.mjs'
import {createProjectArtifactTextExporter} from './project-artifacts.mjs'
import {loadProjectWeb,projectWebSource,connectProjectWeb} from './project-web.mjs'

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
  const sourceFactory=io.sourceFactory??(async(paths,expected)=>{
    const connection=await loadProjectWeb(paths,expected)
    return factory(paths,expected,{active:{state:'known',...expected},cookies:new Map(connection.cookies),userAgent:connection.userAgent})
  })
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
      Object.assign(status,{title:selected.title,projectId:selected.projectId,source:selected.source})
      let connection
      try {connection=await (io.sourceMetadata??projectWebSource)(paths,selected.source)}catch {connection={available:false}}
      const connected=connection?.available===true&&same(connection,selected.source)
      status.sourceConnected=connected
      status.canMove=!same(active,selected.source)&&connected
      status.note=!connected
        ?`Connect source once as ${selected.source.label??selected.source.account} in the separate login window. Claude Desktop can stay on its current account.`
        :same(active,selected.source)
          ?'When you change Desktop accounts, Move and resume will read the latest source project state through the separate source connection.'
          :'Move and resume will read the latest source project state. Claude Desktop can stay on this destination account.'
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
    if(args.cmd==='project-connect') {
      progress('Opening the separate source account login')
      const connected=await (io.connectSource??connectProjectWeb)(paths,selected.source)
      if(!same(connected,selected.source))throw new Error('The separate source login does not match the selected project account and organization. No project data was changed.')
      return emit({done:true,ok:true,sourceConnected:true,source:selected.source,title:selected.title,projectId:selected.projectId})
    }
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
      if(same(active,selected.source))throw new Error('Switch to the destination Personal plan in Claude Desktop, then use Move and resume')
      const all=await (io.accounts??accounts)(paths,null,{verifyIdentity:true})
      const to=all.find(row=>row.active)
      if(!to?.identityKnown||!to.personal||!same(to,active))throw new Error('Select a verified Personal Max or Pro destination in Claude Desktop')
      const client=await factory(paths,active)
      if(!same(client,active))throw new Error('The verified destination account changed. No source project was paused.')
      const receipt=selected.stagePath?await read(path.join(selected.stagePath,'restore.json')):null
      if(receipt&&(receipt.destination?.accountId!==active.account||receipt.destination?.organizationId!==active.org))throw new Error('An interrupted project restore belongs to another destination. Sign into that destination in Claude Desktop to finish; no duplicate project was created.')
      const source=await sourceFactory(paths,selected.source)
      if(!same(source,selected.source))throw new Error('The separate source connection does not match the selected project account and organization. No source project was paused.')
      if(receipt) {
        const transfer=await read(path.join(selected.stagePath,'transfer.json'))
        if(transfer?.status!=='ready'||transfer.sourcePaused!==true||transfer.source?.projectId!==selected.projectId||transfer.source?.accountId!==selected.source.account||transfer.source?.organizationId!==selected.source.org||!Number.isFinite(Date.parse(transfer.sourceDisabledAt))||typeof transfer.sourceStamp!=='string')throw new Error('The interrupted project restore has no verified source state. No duplicate project was created.')
        progress('Checking the live source before continuing the same destination restore')
        const response=await source.projectRequest(`/v1/code/channels/${selected.projectId}`)
        if(response?.channel?.id!==selected.projectId||response.channel.disabled_at!==transfer.sourceDisabledAt||await (io.stamp??projectTransferStamp)(source,selected.projectId)!==transfer.sourceStamp)throw new Error('The source changed after the interrupted project restore. The existing destination must be reconciled before retry; no duplicate project was created.')
      } else {
        const parent=path.join(paths.state,'project-transfers')
        await mkdir(parent,{recursive:true,mode:0o700})
        const output=path.join(parent,`${selected.projectId}-${randomUUID()}`)
        selected.stagePath=null
        await save(file,selected)
        progress('Reading the latest project state from the source account')
        const exportArtifact=io.exportArtifact??source.projectArtifactText??null
        const result=await (io.stage??stageProjectTransfer)(source,paths,selected.projectId,output,{report:progress,exportArtifact})
        if(!result.ready||result.path!==output)throw new Error('The latest source project state could not be captured. Keep the source paused and retry Move and resume.')
        selected.stagePath=result.path
        await save(file,selected)
      }
      const checked=await (io.signedIn??signedIn)(paths)
      if(!same(checked,active))throw new Error('The Claude Desktop destination changed during the project capture. Sign into the selected destination and retry Move and resume.')
      const resumeReceipt=receipt?.status==='complete'?await read(path.join(selected.stagePath,'resume.json')):null
      if(args.noResume&&resumeReceipt)throw new Error('A project continuation is pending. Retry Move and resume to check its saved message before changing the transfer.')
      const result=resumeReceipt?{restored:true,paused:true,projectId:receipt.destination.projectId}:await (io.restore??restoreProjectTransfer)(client,path.join(selected.stagePath,'prepared'),{report:progress})
      if(!result.restored||!result.paused||!PROJECT.test(result.projectId??''))throw new Error('The destination project has not been verified')
      const resumed=args.noResume?null:await (io.resume??resumeProjectTransfer)(client,selected.stagePath,{report:progress})
      if(resumed&&resumed.accepted!==true)throw new Error('The project continuation request has not been verified. Retry Move and resume.')
      const next={version:1,source:ref(to),projectId:result.projectId,title:selected.title,stagePath:null}
      await save(file,next)
      return emit({done:true,ok:true,title:next.title,projectId:next.projectId,target:active,paused:!resumed,nativeHistoryImport:false,autoResume:!!resumed,accepted:resumed?.accepted??false,coordinatorStarted:resumed?.coordinatorStarted??null})
    }
    throw new Error('Unknown project workflow command')
  }
  if(['project-status','project-connect'].includes(args.cmd))return work()
  return (io.locked??locked)(paths,work)
}
