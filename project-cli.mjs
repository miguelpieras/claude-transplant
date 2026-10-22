import {createHash,randomUUID} from 'node:crypto'
import {link,lstat,mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {accounts,cloudClient,locked,signedIn} from './transplant.js'
import {collection} from './local-workflow.mjs'
import {stageProjectTransfer,restoreProjectTransfer,projectTransferStamp} from './project-transfer.mjs'
import {resumeProjectTransfer} from './project-resume.mjs'
import {createProjectArtifactTextExporter} from './project-artifacts.mjs'

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
const save=async(file,value,exclusive=false)=>{
  await mkdir(path.dirname(file),{recursive:true,mode:0o700})
  const temporary=`${file}.${randomUUID()}.tmp`
  await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600})
  try{if(exclusive){try{await link(temporary,file)}catch(error){if(error.code!=='EEXIST')throw error}}else await rename(temporary,file)}finally{await unlink(temporary).catch(()=>{})}
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
const projected=rows=>rows.map(({id,name,title})=>({id,name:name??title}))

export async function runProjectCommand(paths,args,emit,io={}){
  const factory=io.clientFactory??cloudClient,progress=text=>emit({text})
  const captureLocal=io.captureLocal??(async(...args)=>(await import('./local-capture.mjs')).captureLocal(...args))
  const verifyLocal=io.verifyLocal??(async(...args)=>(await import('./local-capture.mjs')).verifyLocalCapture(...args))
  const verifyStage=io.verifyStage??(async directory=>(await import('./project-transfer.mjs')).verifyPreparedProjectTransfer(directory))
  const current=await(io.signedIn??signedIn)(paths)
  if(!valid(current))throw new Error('Sign into Claude Desktop before you prepare or move projects and conversations')
  const active=ref(current),selectionFile=path.join(paths.state,'project-selection.json'),stateFile=path.join(paths.state,'account-projects.json')
  const parent=path.join(paths.state,'project-batches')
  const batchAt=async root=>{
    if(!path.isAbsolute(root??'')||path.dirname(root)!==parent)throw new Error('Invalid saved account capture path')
    const batch=await read(path.join(root,'batch.json'))
    if(!batch||batch.version!==2||batch.root!==root||!valid(batch.source)||batch.target!==null&&!valid(batch.target)||!['capturing','ready','restoring','complete'].includes(batch.phase)||!Array.isArray(batch.projects)||new Set(batch.projects.map(row=>row.id)).size!==batch.projects.length||batch.projects.some(row=>!PROJECT.test(row.id??'')||typeof row.title!=='string'||typeof row.resumeCandidate!=='boolean'||typeof row.complete!=='boolean'||row.stagePath!==null&&(typeof row.stagePath!=='string'||!path.isAbsolute(row.stagePath)||path.dirname(row.stagePath)!==root)||row.targetProjectId!==null&&!PROJECT.test(row.targetProjectId??''))||batch.localPath!==null&&(typeof batch.localPath!=='string'||!path.isAbsolute(batch.localPath)||path.dirname(batch.localPath)!==root))throw new Error('The saved account capture is invalid. Prepare it again while signed into its source account.')
    return batch
  }
  const work=async()=>{
    const selected=selectedProject(await read(selectionFile)),stored=accountProjects(await read(stateFile))
    const local=await(io.collection??collection)(paths),anchor=local?fingerprint(local):null
    const follows=stored&&(!valid(local?.current)||same(local.current,stored.current)||stored.localAnchor===anchor)
    const source=ref(follows?stored.current:valid(local?.current)?local.current:selected?.source??active)
    if(stored?.pending&&!follows)throw new Error('Finish the prepared move before you change the conversation source')
    let state=follows?stored:{version:1,current:source,ids:[],preserve:{},localAnchor:anchor,pending:null}
    let batch=state.pending?await batchAt(state.pending):null
    const completed=state.lastBatch?await batchAt(state.lastBatch):null
    const localPending=completed?.phase==='complete'&&same(completed.target,active)&&valid(local?.current)&&!same(local.current,state.current)&&completed.localAnchor===anchor
    const kept=new Set(state.preserve[key(source)]??[]),eligible=rows=>rows.filter(row=>!kept.has(row.id))
    const saveBatch=()=>save(path.join(batch.root,'batch.json'),batch)
    const sameDesktop=async expected=>{if(!same(await(io.signedIn??signedIn)(paths),expected))throw new Error('The Claude Desktop account changed. Return to the recorded account and retry.')}
    const captureClient=async()=>{
      if(!same(active,source))throw new Error('Sign into the source account and click Transplant before you switch accounts.')
      const client=await factory(paths,source)
      if(!same(client,source))throw new Error('The source account and organization changed. No project was paused.')
      return client
    }
    const savedTransfer=async row=>{
      const transfer=await read(path.join(row.stagePath,'transfer.json'))
      if(transfer?.status!=='ready'||transfer.sourcePaused!==true||transfer.source?.projectId!==row.id||transfer.source?.accountId!==batch.source.account||transfer.source?.organizationId!==batch.source.org||!Number.isFinite(Date.parse(transfer.sourceDisabledAt))||typeof transfer.sourceStamp!=='string')throw new Error('A project has no verified local capture. Prepare it again before switching accounts.')
      return transfer
    }
    const verifySaved=async()=>{
      if(!batch.localPath)throw new Error('The local conversations have not been saved. Prepare the account before switching.')
      for(const row of batch.projects){await savedTransfer(row);await verifyStage(path.join(row.stagePath,'prepared'))}
      return verifyLocal(paths,batch.localPath,{source:batch.source})
    }
    if(args.cmd==='project-status'){
      if(localPending)return emit({selected:completed.projects.length>0,count:completed.projects.length,current:active,source:completed.source,projects:projected(completed.projects),allProjects:true,phase:'restored',ready:true,canStage:false,canMove:true,preparedAt:completed.readyAt,localCount:completed.localCount,localPath:completed.localPath,note:'Projects are restored. Move and resume will finish the saved local conversations.'})
      const ready=!!batch&&['ready','restoring'].includes(batch.phase)
      const targetAllowed=!batch?.target||same(batch.target,active)
      const status={selected:true,count:batch?.projects.length??null,current:active,source:batch?.source??source,projects:batch?projected(batch.projects):[],allProjects:true,phase:ready?(same(active,source)?'ready':'destination'):'source',ready,canStage:same(active,source)&&!batch?.target,canMove:ready&&!same(active,source)&&targetAllowed,preparedAt:batch?.readyAt??null,localCount:batch?.localCount??null,localPath:batch?.localPath??null,note:ready?'Ready to switch accounts. The saved copy will be used for the move.':'Click Transplant while signed into the source account, then wait for Ready to switch accounts.'}
      if(batch?.target&&!targetAllowed)status.note='Sign into the recorded destination to finish this move.'
      if(!batch&&same(active,source)){
        const rows=eligible(await listProjects(await captureClient()));status.projects=projected(rows);status.count=rows.length;status.selected=rows.length>0
        if(!stored)await save(stateFile,{...state,ids:rows.map(row=>row.id)},true)
      }
      return emit(status)
    }
    if(args.cmd==='project-connect')throw new Error('A separate source login is not used. Click Transplant while signed into the source account.')
    if(args.cmd==='project-select'){
      if(args.source!==key(active))throw new Error('Select a project while signed into its source account and plan')
      if(selected?.stagePath)throw new Error('Finish the prepared project transfer before you select another source')
      const client=await factory(paths,active),response=await client.projectRequest(`/v1/code/channels/${args.project}`)
      if(response?.channel?.id!==args.project||typeof response.channel.name!=='string')throw new Error('The selected project could not be verified')
      const next={version:1,source:{...active,label:client.identity?.email??active.label},projectId:args.project,title:response.channel.name,stagePath:null}
      await save(selectionFile,next)
      return emit({done:true,ok:true,selected:true,title:next.title,projectId:next.projectId,source:next.source})
    }
    if(args.cmd==='project-stage'){
      if(!selected||!same(active,selected.source))throw new Error('The advanced stage command requires a selected project in the current source account')
      const client=await factory(paths,selected.source),root=path.join(paths.state,'project-transfers')
      await mkdir(root,{recursive:true,mode:0o700})
      const output=path.join(root,`${selected.projectId}-${randomUUID()}`)
      selected.stagePath=null;await save(selectionFile,selected)
      const exportArtifact=io.exportArtifact??client.projectArtifactText??createProjectArtifactTextExporter({binary:path.join(paths.state,'Claude Transplant Resume.app/Contents/MacOS/Claude Transplant Resume'),account:client.account,org:client.org})
      const result=await(io.stage??stageProjectTransfer)(client,paths,selected.projectId,output,{report:progress,exportArtifact})
      if(!result.ready)throw new Error('Project preparation did not finish. Keep the source account open and retry.')
      selected.stagePath=result.path;await save(selectionFile,selected)
      return emit({done:true,ok:true,title:selected.title,threads:result.threads,preparedAt:result.transfer.readyAt,sourcePaused:true})
    }
    if(args.cmd==='project-stage-all'){
      if(localPending)throw new Error('Finish the saved local conversation move before you prepare another account')
      const client=await captureClient()
      if(batch?.target)throw new Error('Finish the prepared move on its recorded destination before preparing another copy')
      const previous=batch
      if(!batch||batch.phase!=='capturing'){
        const root=path.join(parent,randomUUID());await mkdir(root,{recursive:true,mode:0o700})
        batch={version:2,phase:'capturing',root,source,target:null,projects:[],localPath:null,localCount:null,localAnchor:anchor,readyAt:null,noResume:null,preserveTarget:null}
        state.pending=root;await saveBatch();await save(stateFile,state)
      }
      let rows=eligible(await listProjects(client))
      for(let pass=0;pass<5;pass++){
        const ids=new Set(rows.map(row=>row.id))
        batch.projects=batch.projects.filter(row=>ids.has(row.id))
        for(const row of rows)if(!batch.projects.some(item=>item.id===row.id)){
          let candidate=!row.archived_at&&!row.disabled_at
          const old=previous?.projects.find(item=>item.id===row.id)
          if(old?.stagePath&&!row.archived_at){const transfer=await read(path.join(old.stagePath,'transfer.json'));if(row.disabled_at===transfer?.sourceDisabledAt)candidate=old.resumeCandidate}
          batch.projects.push({id:row.id,title:row.name,stagePath:null,targetProjectId:null,resumeCandidate:candidate,complete:false,accepted:false})
        }
        await saveBatch()
        for(const row of batch.projects){
          await sameDesktop(source)
          if(row.stagePath){
            let unchanged=false
            try{const transfer=await savedTransfer(row);const channel=(await client.projectRequest(`/v1/code/channels/${row.id}`))?.channel;unchanged=channel?.id===row.id&&channel.disabled_at===transfer.sourceDisabledAt&&await(io.stamp??projectTransferStamp)(client,row.id)===transfer.sourceStamp;if(unchanged)await verifyStage(path.join(row.stagePath,'prepared'))}catch{}
            if(unchanged)continue
          }
          row.stagePath=null;await saveBatch();progress(`Saving project ${row.title}`)
          const output=path.join(batch.root,`${row.id}-${randomUUID()}`)
          const result=await(io.stage??stageProjectTransfer)(client,paths,row.id,output,{report:progress,exportArtifact:io.exportArtifact??client.projectArtifactText??null})
          if(!result.ready||result.path!==output)throw new Error('A project capture did not finish. Keep the source account open and click Transplant again.')
          row.stagePath=output;if(result.hasConversationWork===false)row.resumeCandidate=false;await saveBatch()
        }
        rows=eligible(await listProjects(client))
        if(rows.some(row=>!batch.projects.some(item=>item.id===row.id)))continue
        if(rows.length!==batch.projects.length)throw new Error('The source project list changed. Click Transplant again before switching accounts.')
        for(const row of batch.projects){const transfer=await savedTransfer(row),channel=(await client.projectRequest(`/v1/code/channels/${row.id}`))?.channel;if(channel?.id!==row.id||channel.disabled_at!==transfer.sourceDisabledAt||await(io.stamp??projectTransferStamp)(client,row.id)!==transfer.sourceStamp)throw new Error('A source project changed during preparation. Click Transplant again before switching accounts.')}
        batch.localPath=path.join(batch.root,`local-${randomUUID()}`);await saveBatch()
        progress('Saving local conversations')
        const saved=await captureLocal(paths,batch.localPath,{source})
        if(saved.path!==batch.localPath||!same(saved.source,source)||!Number.isSafeInteger(saved.count)||saved.count<0)throw new Error('The local conversation capture did not finish. Keep the source open and click Transplant again.')
        batch.localCount=saved.count;await saveBatch();break
      }
      if(rows.some(row=>!batch.projects.some(item=>item.id===row.id))||!batch.localPath)throw new Error('The source keeps changing. Keep it open and click Transplant again after that work stops.')
      const checked=await verifySaved()
      const finalRows=eligible(await listProjects(client)),finalIds=new Set(finalRows.map(row=>row.id))
      if(finalRows.length!==batch.projects.length||batch.projects.some(row=>!finalIds.has(row.id)))throw new Error('The source project list changed during local copying. Click Transplant again before switching accounts.')
      for(const row of batch.projects){const transfer=await savedTransfer(row),channel=(await client.projectRequest(`/v1/code/channels/${row.id}`))?.channel;if(channel?.id!==row.id||channel.disabled_at!==transfer.sourceDisabledAt||await(io.stamp??projectTransferStamp)(client,row.id)!==transfer.sourceStamp)throw new Error('A source project changed during local copying. Click Transplant again before switching accounts.')}
      await sameDesktop(source)
      batch.localCount=checked.count;batch.localAnchor=anchor;batch.phase='ready';batch.readyAt=new Date().toISOString();await saveBatch()
      return emit({done:true,ok:true,ready:true,phase:'ready',count:batch.projects.length,localCount:batch.localCount,localPath:batch.localPath,preparedAt:batch.readyAt,source,sourcePaused:true,allProjects:true})
    }
    if(args.cmd!=='project-move')throw new Error('Unknown project workflow command')
    if(localPending){await verifyLocal(paths,completed.localPath,{source:completed.source});return emit({done:true,ok:true,count:0,alreadyCurrent:true,ready:true,phase:'restored',target:active,localCount:completed.localCount,localPath:completed.localPath,allProjects:true,accepted:false,paused:false})}
    if(!batch||!['ready','restoring'].includes(batch.phase))throw new Error('No ready local account copy is available. While signed into the source, click Transplant and wait for Ready to switch accounts.')
    if(same(active,batch.source))throw new Error('Ready to switch accounts. Sign into the destination Personal plan, then click Move and resume.')
    if(batch.target&&!same(batch.target,active))throw new Error('Finish the prepared move on its recorded destination. No duplicate project was created.')
    if(batch.noResume!==null&&batch.noResume!==!!args.noResume)throw new Error('Retry the prepared move with the same resume choice')
    await verifySaved()
    const all=await(io.accounts??accounts)(paths,null,{verifyIdentity:true}),to=all.find(row=>row.active)
    if(!to?.identityKnown||!to.personal||!same(to,active))throw new Error('Select a verified Personal Max or Pro destination in Claude Desktop')
    const destination=await factory(paths,active)
    if(!same(destination,active))throw new Error('The verified destination account changed. No destination project was created.')
    if(!batch.target){batch.preserveTarget=(await listProjects(destination)).map(row=>row.id);batch.target=ref(to);batch.noResume=!!args.noResume;batch.phase='restoring';await saveBatch()}
    for(const row of batch.projects){
      await sameDesktop(active)
      if(row.complete){
        const receipt=await read(path.join(row.stagePath,'restore.json'))
        if(receipt?.status!=='complete'||receipt.verified!==true||receipt.destination?.accountId!==active.account||receipt.destination?.organizationId!==active.org||receipt.destination?.projectId!==row.targetProjectId||receipt.profile?.id!==row.targetProjectId||!receipt.profile.created_by_account_id||!receipt.profile.created_at)throw new Error('A completed destination has no verified restore receipt. No duplicate project was created.')
        let channel;try{channel=(await destination.projectRequest(`/v1/code/channels/${row.targetProjectId}`))?.channel}catch{}
        if(channel?.id!==row.targetProjectId||channel.created_by_account_id!==receipt.profile.created_by_account_id||channel.created_at!==receipt.profile.created_at)throw new Error('A completed destination project is missing or its owner changed. No duplicate project was created.')
        continue
      }
      const restore=await read(path.join(row.stagePath,'restore.json'))
      if(restore&&(restore.destination?.accountId!==active.account||restore.destination?.organizationId!==active.org))throw new Error('A partial project restore belongs to another destination')
      const resumeReceipt=restore?.status==='complete'?await read(path.join(row.stagePath,'resume.json')):null
      const result=resumeReceipt?{restored:true,paused:true,projectId:restore.destination.projectId}:await(io.restore??restoreProjectTransfer)(destination,path.join(row.stagePath,'prepared'),{report:progress})
      if(!result.restored||!result.paused||!PROJECT.test(result.projectId??''))throw new Error('The destination project has not been verified')
      row.targetProjectId=result.projectId;await saveBatch()
      const resumed=!args.noResume&&row.resumeCandidate?await(io.resume??resumeProjectTransfer)(destination,row.stagePath,{report:progress}):null
      if(resumed&&resumed.accepted!==true)throw new Error('The project continuation request has not been verified. Retry Move and resume.')
      row.accepted=resumed?.accepted===true;row.complete=true;await saveBatch()
    }
    await sameDesktop(active)
    batch.phase='complete';batch.completedAt=new Date().toISOString();await saveBatch()
    state={version:1,current:ref(to),ids:batch.projects.map(row=>row.targetProjectId),preserve:{...state.preserve,[key(to)]:batch.preserveTarget},localAnchor:batch.localAnchor,pending:null,lastBatch:batch.root}
    await save(stateFile,state)
    return emit({done:true,ok:true,ready:true,phase:'restored',count:batch.projects.length,projectCount:batch.projects.length,localCount:batch.localCount,localPath:batch.localPath,target:active,source:batch.source,allProjects:true,accepted:batch.projects.some(row=>row.accepted),paused:batch.projects.every(row=>!row.accepted),nativeHistoryImport:false,autoResume:batch.projects.some(row=>row.accepted),coordinatorStarted:null})
  }
  if(args.cmd==='project-status')return work()
  return(io.locked??locked)(paths,work)
}
