import {createHash,randomUUID} from 'node:crypto'
import {link,lstat,mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {accounts,cloudClient,locked,signedIn} from './transplant.js'
import {collection} from './local-workflow.mjs'
import {stageProjectTransfer,restoreProjectTransfer,projectTransferStamp} from './project-transfer.mjs'
import {resumeProjectTransfer} from './project-resume.mjs'
import {createProjectArtifactTextExporter} from './project-artifacts.mjs'
import {loadProjectWeb,projectWebSource,connectProjectWeb} from './project-web.mjs'

const ID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const PROJECT=/^chan_[A-Za-z0-9]+$/
const same=(a,b)=>a?.account===b?.account&&a?.org===b?.org
const valid=value=>ID.test(value?.account??'')&&ID.test(value?.org??'')
const ref=value=>({account:value.account,org:value.org,label:value.label??value.account})
const key=value=>`${value.account}/${value.org}`
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const read=async file=>{
  try{
    const info=await lstat(file)
    if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw new Error('Project settings and receipts must be private regular files')
    return JSON.parse(await readFile(file,'utf8'))
  }catch(error){if(error.code==='ENOENT')return null;throw error}
}
const save=async(file,value)=>{
  await mkdir(path.dirname(file),{recursive:true,mode:0o700})
  const temporary=`${file}.${randomUUID()}.tmp`
  await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600})
  try{await rename(temporary,file)}finally{await unlink(temporary).catch(()=>{})}
}
const initialize=async(file,value)=>{
  await mkdir(path.dirname(file),{recursive:true,mode:0o700})
  const temporary=`${file}.${randomUUID()}.tmp`
  await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600})
  try{await link(temporary,file)}catch(error){if(error.code!=='EEXIST')throw error}finally{await unlink(temporary).catch(()=>{})}
}
function selectedProject(value){
  if(value&&(value.version!==1||!valid(value.source)||!PROJECT.test(value.projectId??'')||typeof value.title!=='string'))throw new Error('Invalid project selection')
  return value
}
function accountProjects(value){
  if(value&&(value.version!==1||!valid(value.current)||!Array.isArray(value.ids)||value.ids.some(id=>!PROJECT.test(id))||!value.preserve||typeof value.preserve!=='object'||Array.isArray(value.preserve)||Object.values(value.preserve).some(ids=>!Array.isArray(ids)||ids.some(id=>!PROJECT.test(id)))))throw new Error('Invalid account project collection')
  return value
}
async function listProjects(client){
  const rows=[],ids=new Set(),cursors=new Set();let cursor
  for(let page=0;page<500;page++){
    const query=new URLSearchParams({scope:'joined',include_archived:'true',include_members:'true',limit:'200',...cursor?{cursor}:{}})
    const result=await client.projectRequest(`/v1/code/channels?${query}`)
    if(!Array.isArray(result?.data)||result.truncated===true)throw new Error('The account project list is incomplete')
    for(const row of result.data){
      if(!PROJECT.test(row?.id??'')||typeof row.name!=='string'||ids.has(row.id))throw new Error('The account project list changed or contains invalid IDs')
      ids.add(row.id);rows.push(row)
    }
    const next=result.next_cursor??result.cursor
    if(!next){if(result.has_more===true||Number(result.total??rows.length)>rows.length)throw new Error('The account project list is incomplete');return rows.sort((a,b)=>a.id.localeCompare(b.id))}
    if(typeof next!=='string'||cursors.has(next))throw new Error('The account project list cursor did not advance')
    cursors.add(next);cursor=next
  }
  throw new Error('The account project list exceeded its page limit')
}
const projected=rows=>rows.map(({id,name})=>({id,name}))

export async function runProjectCommand(paths,args,emit,io={}){
  const factory=io.clientFactory??cloudClient
  const progress=text=>emit({text})
  const connect=async expected=>{
    progress('Sign in to the source account to continue this move')
    const result=await(io.connectSource??connectProjectWeb)(paths,expected)
    if(!same(result,expected))throw new Error('The source login does not match the account being moved. No project data was changed.')
  }
  const sourceFactory=io.sourceFactory??(async(paths,expected,{allowConnect=false}={})=>{
    let connection
    try{connection=await loadProjectWeb(paths,expected)}catch(error){
      if(!allowConnect||error.code!=='PROJECT_SOURCE_LOGIN')throw error
      await connect(expected);connection=await loadProjectWeb(paths,expected)
    }
    return factory(paths,expected,{active:{state:'known',...expected},cookies:new Map(connection.cookies),userAgent:connection.userAgent})
  })
  const current=await(io.signedIn??signedIn)(paths)
  if(!valid(current))throw new Error('Sign into Claude Desktop before you move projects and conversations')
  const active=ref(current),selectionFile=path.join(paths.state,'project-selection.json'),stateFile=path.join(paths.state,'account-projects.json')
  const work=async()=>{
    const selected=selectedProject(await read(selectionFile))
    const storedState=accountProjects(await read(stateFile))
    let state=storedState
    const local=await(io.collection??collection)(paths),anchor=local?fingerprint(local):null
    const follows=state&&(!valid(local?.current)||same(local.current,state.current)||state.localAnchor===anchor)
    let source=ref(follows?state.current:valid(local?.current)?local.current:selected?.source??active)
    if(state?.pending&&!follows)throw new Error('Finish the pending project move before you change the conversation source')
    if(!follows)state={version:1,current:source,ids:[],preserve:{},localAnchor:anchor,pending:null}
    if(state.pending&&(!path.isAbsolute(state.pending)||path.dirname(state.pending)!==path.join(paths.state,'project-batches')))throw new Error('Invalid pending account project move')
    const kept=new Set(state.preserve[key(source)]??[])
    const eligible=rows=>rows.filter(row=>!kept.has(row.id))
    const clientForSource=async allowConnect=>{
      const client=same(active,source)?await factory(paths,source):await sourceFactory(paths,source,{allowConnect})
      if(!same(client,source))throw new Error('The source connection does not match the account and organization. No source project was paused.')
      return client
    }
    if(args.cmd==='project-status'){
      let connection
      try{connection=await(io.sourceMetadata??projectWebSource)(paths,source)}catch{connection={available:false}}
      const connected=connection?.available===true&&same(connection,source)
      const status={selected:true,current:active,source,canStage:false,canMove:!same(active,source),sourceConnected:connected,projects:[],count:null,allProjects:true,note:'All projects and conversations move with the same button.'}
      try{
        const rows=eligible(await listProjects(await clientForSource(false)))
        status.projects=projected(rows);status.count=rows.length;status.selected=rows.length>0
        if(!storedState)await initialize(stateFile,{...state,ids:rows.map(row=>row.id),localAnchor:anchor})
      }catch(error){
        if(same(active,source))throw error
        status.note='Move and resume will check all current source projects. Sign in to the source if Claude asks.'
      }
      return emit(status)
    }
    if(args.cmd==='project-select'){
      if(args.source!==key(active))throw new Error('Select a project while signed into its source account and plan')
      if(selected?.stagePath)throw new Error('Finish the prepared project transfer before you select another source')
      const client=await factory(paths,active),response=await client.projectRequest(`/v1/code/channels/${args.project}`)
      if(response?.channel?.id!==args.project||typeof response.channel.name!=='string')throw new Error('The selected project could not be verified')
      const next={version:1,source:{...active,label:client.identity?.email??active.label},projectId:args.project,title:response.channel.name,stagePath:null}
      await save(selectionFile,next)
      return emit({done:true,ok:true,selected:true,title:next.title,projectId:next.projectId,source:next.source})
    }
    if(args.cmd==='project-connect'){
      await connect(source)
      return emit({done:true,ok:true,sourceConnected:true,source,allProjects:true})
    }
    if(args.cmd==='project-stage'){
      if(!selected)throw new Error('The advanced stage command requires a selected project')
      if(!same(active,selected.source))throw new Error('Sign into the selected project source before you prepare its latest state')
      const client=await factory(paths,selected.source),parent=path.join(paths.state,'project-transfers')
      await mkdir(parent,{recursive:true,mode:0o700})
      const output=path.join(parent,`${selected.projectId}-${randomUUID()}`)
      selected.stagePath=null;await save(selectionFile,selected)
      const exportArtifact=io.exportArtifact??client.projectArtifactText??createProjectArtifactTextExporter({binary:path.join(paths.state,'Claude Transplant Resume.app/Contents/MacOS/Claude Transplant Resume'),account:client.account,org:client.org})
      const result=await(io.stage??stageProjectTransfer)(client,paths,selected.projectId,output,{report:progress,exportArtifact})
      if(!result.ready)throw new Error('Project preparation did not finish. Keep the source account open and retry.')
      selected.stagePath=result.path;await save(selectionFile,selected)
      return emit({done:true,ok:true,title:selected.title,threads:result.threads,preparedAt:result.transfer.readyAt,sourcePaused:true})
    }
    if(args.cmd!=='project-move')throw new Error('Unknown project workflow command')
    // Projects can finish before the local move. A retry on that destination
    // must continue local records without moving the new projects a second time.
    if(same(active,source))return emit({done:true,ok:true,count:0,alreadyCurrent:true,target:active,allProjects:true,accepted:false,paused:false})
    const all=await(io.accounts??accounts)(paths,null,{verifyIdentity:true}),to=all.find(row=>row.active)
    if(!to?.identityKnown||!to.personal||!same(to,active))throw new Error('Select a verified Personal Max or Pro destination in Claude Desktop')
    const destination=await factory(paths,active)
    if(!same(destination,active))throw new Error('The verified destination account changed. No source project was paused.')
    let batch=state.pending?await read(path.join(state.pending,'batch.json')):null
    if(state.pending&&!batch)throw new Error('The pending project move receipt is missing. No duplicate project was created.')
    if(batch&&(batch.version!==1||!same(batch.source,source)||!same(batch.target,active)||!Array.isArray(batch.projects)||new Set(batch.projects.map(row=>row.id)).size!==batch.projects.length||batch.projects.some(row=>!PROJECT.test(row.id??'')||typeof row.title!=='string'||typeof row.complete!=='boolean'||typeof row.accepted!=='boolean'||typeof row.resume!=='boolean'||row.targetProjectId!==null&&!PROJECT.test(row.targetProjectId??'')||row.complete&&(!row.stagePath||!row.targetProjectId)||row.stagePath&&(!path.isAbsolute(row.stagePath)||path.dirname(row.stagePath)!==state.pending))||!Array.isArray(batch.preserveTarget)||batch.preserveTarget.some(id=>!PROJECT.test(id))||batch.noResume!==!!args.noResume))throw new Error('Finish the pending project move on its recorded destination with the same resume choice. No duplicate project was created.')
    const sourceClient=await clientForSource(true)
    let sourceRows=eligible(await listProjects(sourceClient))
    const targetRows=await listProjects(destination)
    if(!batch){
      const root=path.join(paths.state,'project-batches',randomUUID())
      await mkdir(root,{recursive:true,mode:0o700})
      batch={version:1,status:'moving',source,target:ref(to),noResume:!!args.noResume,root,projects:[],preserveTarget:targetRows.map(row=>row.id),localAnchor:anchor}
      state.pending=root;await save(path.join(root,'batch.json'),batch);await save(stateFile,state)
    }
    if(batch.root!==state.pending||!path.isAbsolute(batch.root)||path.dirname(batch.root)!==path.join(paths.state,'project-batches'))throw new Error('Invalid pending account project move')
    const saveBatch=()=>save(path.join(batch.root,'batch.json'),batch)
    const checkDestination=async()=>{if(!same(await(io.signedIn??signedIn)(paths),active))throw new Error('The Claude Desktop destination changed during the project move. Return to the recorded destination and retry.')}
    const checkSource=async row=>{
      const transfer=await read(path.join(row.stagePath,'transfer.json'))
      if(transfer?.status!=='ready'||transfer.sourcePaused!==true||transfer.source?.projectId!==row.id||transfer.source?.accountId!==source.account||transfer.source?.organizationId!==source.org||!Number.isFinite(Date.parse(transfer.sourceDisabledAt))||typeof transfer.sourceStamp!=='string')throw new Error('A pending project has no verified source state. No duplicate project was created.')
      const response=await sourceClient.projectRequest(`/v1/code/channels/${row.id}`)
      if(response?.channel?.id!==row.id||response.channel.disabled_at!==transfer.sourceDisabledAt||await(io.stamp??projectTransferStamp)(sourceClient,row.id)!==transfer.sourceStamp)throw new Error(`The source project ${row.title} changed after a partial move. Reconcile its existing destination before retry. No duplicate project was created.`)
      if(transfer.hasConversationWork===false)row.resume=false
    }
    const checkCompletedDestination=async row=>{
      const receipt=await read(path.join(row.stagePath,'restore.json'))
      if(receipt?.status!=='complete'||receipt.verified!==true||receipt.destination?.accountId!==active.account||receipt.destination?.organizationId!==active.org||receipt.destination?.projectId!==row.targetProjectId||receipt.profile?.id!==row.targetProjectId||!receipt.profile.created_by_account_id||!receipt.profile.created_at)throw new Error('A completed destination has no verified restore receipt. No duplicate project was created.')
      let channel
      try{channel=(await destination.projectRequest(`/v1/code/channels/${row.targetProjectId}`))?.channel}catch{}
      if(channel?.id!==row.targetProjectId||channel.created_by_account_id!==receipt.profile.created_by_account_id||channel.created_at!==receipt.profile.created_at)throw new Error('A completed destination project is missing or its owner changed. No duplicate project was created.')
    }
    for(let pass=0;pass<5;pass++){
      const liveIds=new Set(sourceRows.map(row=>row.id))
      if(batch.projects.some(row=>!liveIds.has(row.id)))throw new Error('A source project was removed during the account move. No duplicate destination was created.')
      for(const row of sourceRows)if(!batch.projects.some(item=>item.id===row.id))batch.projects.push({id:row.id,title:row.name,stagePath:null,targetProjectId:null,complete:false,accepted:false,resume:!args.noResume&&!row.archived_at&&!row.disabled_at})
      await saveBatch()
      for(const row of batch.projects){
        await checkDestination()
        if(row.complete){await checkSource(row);await checkCompletedDestination(row);continue}
        let restore=row.stagePath?await read(path.join(row.stagePath,'restore.json')):null
        if(restore){
          if(restore.destination?.accountId!==active.account||restore.destination?.organizationId!==active.org)throw new Error('A partial restore belongs to another destination. No duplicate project was created.')
          await checkSource(row)
        }else{
          const output=path.join(batch.root,`${row.id}-${randomUUID()}`)
          row.stagePath=null;await saveBatch()
          progress(`Reading the latest project state: ${row.title}`)
          const result=await(io.stage??stageProjectTransfer)(sourceClient,paths,row.id,output,{report:progress,exportArtifact:io.exportArtifact??sourceClient.projectArtifactText??null})
          if(!result.ready||result.path!==output)throw new Error('The latest source project state could not be captured. Retry the same Move and resume action.')
          row.stagePath=output;if(result.hasConversationWork===false)row.resume=false;await saveBatch()
        }
        await checkDestination()
        const resumeReceipt=restore?.status==='complete'?await read(path.join(row.stagePath,'resume.json')):null
        const result=resumeReceipt?{restored:true,paused:true,projectId:restore.destination.projectId}:await(io.restore??restoreProjectTransfer)(destination,path.join(row.stagePath,'prepared'),{report:progress})
        if(!result.restored||!result.paused||!PROJECT.test(result.projectId??''))throw new Error('The destination project has not been verified')
        row.targetProjectId=result.projectId;await saveBatch()
        const resumed=row.resume?await(io.resume??resumeProjectTransfer)(destination,row.stagePath,{report:progress}):null
        if(resumed&&resumed.accepted!==true)throw new Error('The project continuation request has not been verified. Retry Move and resume.')
        row.accepted=resumed?.accepted===true;row.complete=true;await saveBatch()
      }
      sourceRows=eligible(await listProjects(sourceClient))
      if(sourceRows.some(row=>!batch.projects.some(item=>item.id===row.id)))continue
      if(sourceRows.length!==batch.projects.length)throw new Error('The source project list changed during the move')
      await checkDestination()
      const next={version:1,current:ref(to),ids:batch.projects.map(row=>row.targetProjectId),preserve:{...state.preserve,[key(to)]:batch.preserveTarget},localAnchor:batch.localAnchor,pending:null}
      batch.status='complete';batch.completedAt=new Date().toISOString();await saveBatch();await save(stateFile,next)
      return emit({done:true,ok:true,count:batch.projects.length,projectCount:batch.projects.length,target:active,source,allProjects:true,accepted:batch.projects.some(row=>row.accepted),paused:batch.projects.every(row=>!row.accepted),nativeHistoryImport:false,autoResume:batch.projects.some(row=>row.accepted),coordinatorStarted:null})
    }
    throw new Error('The source keeps adding projects. Retry the same Move and resume action after that work stops.')
  }
  if(['project-status','project-connect'].includes(args.cmd))return work()
  return(io.locked??locked)(paths,work)
}
