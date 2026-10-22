import {createHash} from 'node:crypto'
import {chmod,lstat,mkdir,readFile,readdir,rename,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {collectProject} from './project-source.mjs'
import {writeCaptureBundle,verifyCaptureBundle,prepareProjectRestore,preflightRestoreUploads} from './project-workflow.mjs'

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const CHANNEL=/^chan_[A-Za-z0-9]+$/
const SESSION=/^(?:cse|session)_[A-Za-z0-9]+$/
const CONFIG=new Set(['system_prompt_addendum','channel_session_model','channel_session_effort_level','default_model','default_effort_level','default_source_urls','memory_enabled'])
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)
const same=(a,b)=>canonical(a)===canonical(b)
const fail=message=>{throw new Error(message)}
const wire=id=>id.replace(/^cse_/,'session_')
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n')
const normalize=value=>typeof value==='string'?value.replace(/^(?:SESSION_STATUS_|WORKER_STATUS_|CONNECTION_STATUS_)/,'').toLowerCase():null
function ownerAccount(value) {
  if(UUID.test(value??''))return value.toLowerCase()
  if(typeof value!=='string'||!value.startsWith('user_'))return null
  const tail=value.slice(value.lastIndexOf('_')+1),alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  if(tail.length!==24||!tail.startsWith('01'))return null
  let decoded=0n
  for(const character of tail.slice(2)){const index=alphabet.indexOf(character);if(index<0)return null;decoded=decoded*58n+BigInt(index)}
  if(decoded>=(1n<<128n))return null
  const hex=decoded.toString(16).padStart(32,'0')
  return[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20,32)].join('-')
}
const identity=client=>{if(!UUID.test(client?.account??'')||!UUID.test(client?.org??''))fail('A verified Claude account and organization are required');return{accountId:client.account,organizationId:client.org}}
const relative=name=>{if(typeof name!=='string'||!name||name.includes('\\')||name.includes('\0')||name.startsWith('/')||name.split('/').some(part=>!part||part==='.'||part==='..'))fail('Unsafe project transfer path');return name}
async function safe(file,kind) {
  if(typeof file!=='string'||!path.isAbsolute(file)||file.split(path.sep).some(part=>part==='.'||part==='..'))fail('Use an absolute project transfer path')
  const absolute=path.resolve(file);let current=path.parse(absolute).root
  for(const part of absolute.split(path.sep).filter(Boolean)){
    current=path.join(current,part);const info=await lstat(current)
    if(info.isSymbolicLink()||current!==absolute&&!info.isDirectory())fail('Project transfer paths must not contain symlinks')
    if(current===absolute&&(kind==='file'?!info.isFile():!info.isDirectory()))fail('Invalid project transfer path')
  }
  return absolute
}
async function privateRoot(root) {await safe(root,'directory');const info=await lstat(root);if((info.mode&0o777)!==0o700)fail('Project transfer directories must be private (0700)')}
async function readPrivate(file) {await safe(file,'file');if(((await lstat(file)).mode&0o777)!==0o600)fail('Project transfer files must be private (0600)');return readFile(file)}
async function state(root,name,value) {
  await privateRoot(root)
  const temporary=path.join(root,`.${name}.pending`)
  const previous=await lstat(temporary).catch(error=>{if(error.code==='ENOENT')return null;throw error})
  if(previous&&(!previous.isFile()||previous.isSymbolicLink()||(previous.mode&0o777)!==0o600))fail('Unsafe pending project transfer receipt')
  await writeFile(temporary,json(value),{flag:'w',mode:0o600})
  await rename(temporary,path.join(root,name))
}
const readJSON=async file=>JSON.parse((await readPrivate(file)).toString('utf8'))
const write=(client,endpoint,method,body)=>client.projectWrite(endpoint,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)})
const post=(client,endpoint,body)=>client.projectRequest(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
function channelOf(response,id) {const channel=response?.channel;if(!channel||channel.id!==id)fail('Project identity changed');return channel}
function paused(channel) {return typeof channel.disabled_at==='string'&&Number.isFinite(Date.parse(channel.disabled_at))}
async function pausedChannel(client,id,stamp=null) {const channel=channelOf(await client.projectRequest(`/v1/code/channels/${id}`),id);if(!paused(channel)||stamp!==null&&channel.disabled_at!==stamp)fail('The project is not paused at the saved transfer state');return channel}
function rootsOf(index) {
  if(!Array.isArray(index?.sections)||index.truncated===true||index.sections.some(section=>!Array.isArray(section.data)||Number(section.count)!==section.data.length))fail('The project thread list is incomplete')
  const roots=index.sections.flatMap(section=>section.data)
  if(roots.some(root=>typeof root.id!=='string'||!/^cmsg_[A-Za-z0-9]+$/.test(root.id)||!Array.isArray(root.bound_sessions))||new Set(roots.map(root=>root.id)).size!==roots.length)fail('The project thread list changed')
  return roots
}
const graph=roots=>roots.map(root=>({id:root.id,bindings:root.bound_sessions.map(row=>wire(row.id)).sort()})).sort((a,b)=>a.id.localeCompare(b.id))
const stamp=value=>({last_event_at:value.last_event_at??null,last_event_id:value.last_event_id??null})
async function messagePages(client,endpoint,query={}) {
  const rows=[],seen=new Set();let cursor
  for(let page=0;page<500;page++){
    const response=await client.projectRequest(`${endpoint}?${new URLSearchParams({limit:'200',...query,...cursor?{cursor}:{}})}`)
    if(!Array.isArray(response?.data))fail('Project message index changed')
    rows.push(...response.data)
    const next=response.next_cursor??response.cursor??response.resume_cursor
    if(!next){if(response.has_more===true||response.truncated===true)fail('Project messages are incomplete');return rows}
    if(seen.has(next))fail('Project message cursor did not advance');seen.add(next);cursor=next
  }
  fail('Project messages exceeded their page limit')
}
// These current-view worker fields can change on reads without a message edit.
// Actual session bindings remain in the message and project graph.
const stableMessages=rows=>rows.map(({thread_own_session_at,thread_own_session_id,...message})=>message)
export async function projectTransferStamp(client,projectId) {
  identity(client)
  if(!CHANNEL.test(projectId??''))fail('A valid source project ID is required')
  const base=`/v1/code/channels/${projectId}`,channel=channelOf(await client.projectRequest(base),projectId)
  const roots=rootsOf(await client.projectRequest(`${base}/threads?limit=100`))
  const ids=[...new Set([channel.overview_session_id,channel.channel_session_id,...roots.flatMap(root=>root.bound_sessions.map(row=>row.id))].filter(Boolean))].sort()
  const sessions=[]
  for(const id of ids){if(!SESSION.test(id))fail('Invalid source session ID');const response=await client.session(id),session=response?.session??response;if(wire(session?.id??'')!==wire(id))fail('Source session identity changed');sessions.push({id:wire(id),...stamp(session)})}
  const histories=[]
  for(const root of [...roots].sort((a,b)=>a.id.localeCompare(b.id)))histories.push({id:root.id,data:stableMessages(await messagePages(client,`${base}/threads/${root.id}`))})
  const artifacts=await client.projectRequest(`${base}/artifacts?limit=50`),attachments=await client.projectRequest(`${base}/attachments?limit=100`)
  for(const index of [artifacts,attachments])if(!Array.isArray(index?.data)||index.truncated===true||Number(index.total??index.data.length)>index.data.length)fail('Project output index is incomplete')
  const nativeReports=[]
  if(typeof client.projectArtifact==='function')for(const artifact of artifacts.data){
    const id=artifact.id??artifact.slug,value=await client.projectArtifact(id)
    if(value?.metadata?.nativeStateCaptured===true){
      if(!/^[a-f0-9]{64}$/.test(value.metadata.contentSha256??''))fail('The current native report content could not be checked')
      nativeReports.push({id,contentSha256:value.metadata.contentSha256})
    }
  }
  const settings=Object.fromEntries(['id','name','topic','icon','color','visibility','disabled_at','overview_session_id','channel_session_id','default_environment_id','context_sources'].map(key=>[key,channel[key]??null]))
  return sha(canonical({settings,config:(await client.projectRequest(`${base}/config`))?.config,graph:roots.map(root=>({id:root.id,title:root.display_name??root.title??null,status:root.thread_status??null,resolvedAt:root.resolved_at??null,replies:root.reply_count??null,lastReplyAt:root.last_reply_at??null,bindings:(root.bound_sessions??[]).map(row=>wire(row.id)).sort()})).sort((a,b)=>a.id.localeCompare(b.id)),histories,timeline:stableMessages(await messagePages(client,`${base}/timeline`,{include_replies:'true',include_bound_session_rows:'true'})),sessions,memory:await memoryIndex(client,projectId),files:await libraryIndex(client,projectId),artifacts:artifacts.data,attachments:attachments.data,nativeReports:nativeReports.sort((a,b)=>a.id.localeCompare(b.id))}))
}
async function frozenSource(client,id,disabledAt=null) {
  const channel=await pausedChannel(client,id,disabledAt)
  const roots=rootsOf(await client.projectRequest(`/v1/code/channels/${id}/threads?limit=100`))
  const ids=[...new Set([channel.overview_session_id,channel.channel_session_id,...roots.flatMap(root=>root.bound_sessions.map(row=>row.id))].filter(Boolean))]
  const sessions=new Map()
  if(!ids.length&&(roots.length||(await messagePages(client,`/v1/code/channels/${id}/timeline`,{include_replies:'true',include_bound_session_rows:'true'})).length))fail('The project has conversation work but no verified coordinator session')
  for(const sessionId of ids){
    if(!SESSION.test(sessionId))fail('The project has an invalid bound session')
    const response=await client.session(sessionId),session=response?.session??response
    if(!session||wire(session.id??'')!==wire(sessionId))fail('A bound session identity changed')
    const status=normalize(session.status??session.lifecycle_status),worker=normalize(session.worker_status)
    if(worker==='running'||worker==='pending'||!(['paused','archived','failed'].includes(status)||status==='active'&&['idle','requires_action'].includes(worker)))fail('A project worker is running or its state is unknown. Keep the project paused, wait for the worker to stop, then stage again.')
    sessions.set(wire(sessionId),stamp(session))
  }
  return{channel,roots,sessions}
}

// Preparation reads the current Desktop source before sign-out. A successful
// stage keeps the source paused; ordinary capture remains a read-only operation.
export async function stageProjectTransfer(client,paths,projectId,output,{exportArtifact=null,report=()=>{}}={}) {
  const account=identity(client)
  if(!CHANNEL.test(projectId??''))fail('A valid source project ID is required')
  if(typeof client.projectWrite!=='function')fail('The Claude client cannot pause a source project')
  if(typeof output!=='string'||!path.isAbsolute(output))fail('Use an absolute project transfer path')
  const root=path.resolve(output)
  await safe(path.dirname(root),'directory');await mkdir(root,{mode:0o700});await chmod(root,0o700)
  const receipt={schemaVersion:1,kind:'claude-code-project-transfer',status:'staging',source:{...account,projectId,title:projectId,capturedAt:new Date().toISOString()},sourcePaused:false,preparedPath:'prepared',capturePath:'capture',nativeHistoryImport:false,autoResume:false}
  await state(root,'transfer.json',receipt)
  try{
    const source=channelOf(await client.projectRequest(`/v1/code/channels/${projectId}`),projectId)
    receipt.source.title=source.name??projectId
    report('Pausing the source project before the final capture')
    await write(client,`/v1/code/channels/${projectId}`,'PATCH',{disabled:true})
    const stopped=await pausedChannel(client,projectId)
    receipt.sourcePaused=true;receipt.sourceDisabledAt=stopped.disabled_at;await state(root,'transfer.json',receipt)
    await frozenSource(client,projectId,receipt.sourceDisabledAt)
    const sourceStamp=await projectTransferStamp(client,projectId)
    const capture=await collectProject(client,paths,projectId,{report,exportArtifact})
    const saved=await writeCaptureBundle(path.join(root,'capture'),capture)
    const verified=await verifyCaptureBundle(saved.path)
    if(!verified.complete){
      const missing=verified.manifest.missing.join(' ')
      if(missing.includes('PROJECT_REPORT_LOCKED'))fail('The source project is paused. Unlock the Mac, keep Claude open in the source account, and prepare the project again.')
      if(missing.includes('PROJECT_REPORT_ACCESSIBILITY'))fail('The source project is paused. Enable Claude Transplant Resume in System Settings > Privacy & Security > Accessibility, then prepare the project again.')
      if(missing.includes('PROJECT_REPORT_UNAVAILABLE'))fail('The source project is paused. A current report could not be read and checked. Keep the source account signed in and click Transplant again.')
      fail('The final project capture is incomplete. Keep the source paused and stage again.')
    }
    const final=await frozenSource(client,projectId,receipt.sourceDisabledAt)
    if(sourceStamp!==await projectTransferStamp(client,projectId))fail('The source project changed during staging. Keep it paused and stage again.')
    if(!same(graph(final.roots),graph(rootsOf(capture.roots))))fail('The project thread bindings changed. Keep the source paused and stage again.')
    const capturedSessions=[...capture.coordinator.sessionEvents,...capture.threads.flatMap(thread=>thread.sessionEvents)]
    if(final.sessions.size!==new Set(capturedSessions.map(session=>wire(session.id))).size||capturedSessions.some(session=>!same(final.sessions.get(wire(session.id)),stamp(session.metadata))))fail('A project session changed after capture. Keep the source paused and stage again.')
    const prepared=await prepareProjectRestore(saved.path,path.join(root,'prepared'))
    Object.assign(receipt,{status:'ready',source:capture.source,sourceStamp,hasConversationWork:capture.coordinator.history.data.length>0||capture.threads.length>0||capturedSessions.length>0,readyAt:new Date().toISOString(),manifestSha256:sha(await readPrivate(path.join(saved.path,'manifest.json'))),preparationSha256:sha(await readPrivate(path.join(prepared.path,'preparation.json')))})
    await state(root,'transfer.json',receipt)
    return{path:root,preparedPath:prepared.path,ready:true,source:receipt.source,threads:capture.threads.length,hasConversationWork:receipt.hasConversationWork,transfer:receipt}
  }catch(error){receipt.status='blocked';receipt.failure='Stage did not finish. Keep the source paused and stage again.';await state(root,'transfer.json',receipt);throw error}
}

async function preparation(root) {
  await privateRoot(root)
  const stageRoot=path.dirname(root),transfer=await readJSON(path.join(stageRoot,'transfer.json'))
  if(transfer.schemaVersion!==1||transfer.kind!=='claude-code-project-transfer'||transfer.status!=='ready'||transfer.sourcePaused!==true||transfer.preparedPath!==path.basename(root)||transfer.capturePath!=='capture'||transfer.nativeHistoryImport!==false||transfer.autoResume!==false||!Number.isFinite(Date.parse(transfer.sourceDisabledAt)))fail('Restore requires a completed final stage from the paused source project')
  const preparationBytes=await readPrivate(path.join(root,'preparation.json'))
  if(sha(preparationBytes)!==transfer.preparationSha256)fail('The staged project preparation changed')
  const prepared=JSON.parse(preparationBytes.toString('utf8'))
  if(prepared.schemaVersion!==1||prepared.kind!=='claude-code-project-restore-preparation'||prepared.requiresDestinationPaused!==true||prepared.createsThreads!==false||prepared.nativeHistoryImport!==false||prepared.autoResume!==false||prepared.destinationChanged!==false||prepared.restorePlanPath!=='restore-plan.json'||!same(prepared.source,transfer.source)||!Array.isArray(prepared.files))fail('Invalid staged project preparation')
  const originals=await verifyCaptureBundle(path.join(stageRoot,'capture'))
  if(!originals.complete||sha(await readPrivate(path.join(stageRoot,'capture','manifest.json')))!==transfer.manifestSha256||!same(originals.manifest.source,transfer.source))fail('The staged source capture changed')
  const contents=new Map(),known=new Set(['preparation.json'])
  for(const entry of prepared.files){
    relative(entry.path)
    if(known.has(entry.path)||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||!/^[a-f0-9]{64}$/.test(entry.sha256??''))fail('Invalid preparation file manifest')
    known.add(entry.path)
    const data=await readPrivate(path.join(root,entry.path))
    if(data.length!==entry.bytes||sha(data)!==entry.sha256)fail(`Prepared file failed verification: ${entry.path}`)
    contents.set(entry.path,data)
  }
  const walk=async(dir,prefix='')=>{await privateRoot(dir);for(const entry of await readdir(dir,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory())await walk(path.join(dir,entry.name),name+'/');else if(!known.has(name)||entry.isSymbolicLink())fail('Preparation has files outside its manifest')}}
  await walk(root)
  const plan=JSON.parse(contents.get('restore-plan.json')?.toString('utf8')??'null')
  if(plan?.schemaVersion!==1||plan.kind!=='claude-code-project-restore-plan'||!same(plan.source,transfer.source)||plan.requiresDestinationPaused!==true||plan.createsThreads!==false||plan.nativeHistoryImport!==false||plan.autoResume!==false||plan.overwriteExisting!==false||typeof plan.project?.name!=='string'||!plan.project.config||Object.keys(plan.project.config).some(key=>!CONFIG.has(key)))fail('Invalid staged project restore plan')
  preflightRestoreUploads(plan)
  for(const upload of [...plan.memoryUploads,...plan.libraryUploads]){const bytes=contents.get(upload.sourcePath);if(!bytes||bytes.length!==upload.bytes||sha(bytes)!==upload.sha256)fail('A restore upload does not match its verified bytes')}
  return{stageRoot,transfer,plan,contents}
}

export async function verifyPreparedProjectTransfer(preparationDir){
  const root=await safe(preparationDir,'directory')
  const {transfer}=await preparation(root)
  return{complete:true,source:transfer.source,projectId:transfer.source.projectId,hasConversationWork:transfer.hasConversationWork,preparedPath:root}
}
const profile=channel=>Object.fromEntries(['id','name','topic','icon','color','visibility','created_by_account_id','created_at','disabled_at'].map(key=>[key,channel[key]??null]))
const creationProfile=channel=>({...profile(channel),disabled_at:null})
async function unusedDestination(client,id) {if(rootsOf(await client.projectRequest(`/v1/code/channels/${id}/threads?limit=100`)).length||(await messagePages(client,`/v1/code/channels/${id}/timeline`,{include_replies:'true',include_bound_session_rows:'true'})).length)fail('The destination project has new conversation work; restore cannot change it')}
async function libraryIndex(client,id) {
  const out=[],seen=new Set();let cursor
  for(let page=0;page<500;page++){
    const response=await post(client,`/v1/code/channels/${id}/files:list`,{path:'/',recursive:true,limit:500,...cursor?{cursor}:{}})
    if(!Array.isArray(response?.entries))fail('Destination file index changed')
    out.push(...response.entries.filter(entry=>entry.is_directory!==true))
    const next=response.cursor??response.next_cursor
    if(!next){if(response.truncated===true)fail('Destination file index is incomplete');return out}
    if(seen.has(next))fail('Destination file cursor did not advance');seen.add(next);cursor=next
  }
  fail('Destination file index exceeded its page limit')
}
async function memoryIndex(client,id) {
  const rows=[],prefixes=[''],visited=new Set()
  for(let i=0;i<prefixes.length;i++){
    if(i>=500)fail('Destination memory index exceeded its page limit')
    const prefix=prefixes[i];if(visited.has(prefix))continue;visited.add(prefix)
    let page;const seen=new Set()
    for(let n=0;n<500;n++){
      const query=new URLSearchParams({limit:'100',...prefix?{path_prefix:prefix}:{},...page?{page}:{}})
      const value=await client.projectRequest(`/v1/code/memory/channel/${id}/memories?${query}`)
      if(!Array.isArray(value?.data))fail('Destination memory index changed')
      rows.push(...value.data)
      for(const item of value.prefixes??[]){const next=typeof item==='string'?item:item.path??item.prefix;if(typeof next!=='string')fail('Destination memory prefix changed');if(!visited.has(next))prefixes.push(next)}
      if(!value.next_page)break
      if(seen.has(value.next_page)||n===499)fail('Destination memory cursor did not advance');seen.add(value.next_page);page=value.next_page
    }
  }
  return [...new Map(rows.map(row=>[row.id,row])).values()]
}
const targetPath=name=>name.replace(/^\//,'')
function decode(value) {
  if(value?.type==='text'&&typeof value.content==='string')return Buffer.from(value.content)
  if(['download','content'].includes(value?.type)&&typeof value.data==='string'){const bytes=Buffer.from(value.data,'base64');if(bytes.toString('base64')!==value.data)fail('Destination file encoding changed');return bytes}
  fail('Destination file bytes are unavailable')
}
async function checkLibrary(client,id,upload) {const bytes=decode(await post(client,`/v1/code/channels/${id}/files:open`,{path:upload.path}));if(bytes.length!==upload.bytes||sha(bytes)!==upload.sha256)fail(`Destination file changed: ${upload.path}`)}
async function checkMemory(client,id,upload,entry) {const memory=await client.projectRequest(`/v1/code/memory/channel/${id}/memories/${encodeURIComponent(entry.id)}`);if(typeof memory?.content!=='string'||Buffer.byteLength(memory.content)!==upload.bytes||sha(Buffer.from(memory.content))!==upload.sha256||memory.content_sha256!==upload.sha256)fail(`Destination memory changed: ${upload.path}`)}

// The caller holds the normal operation lock. The receipt binds retries to the
// one project created by this operation; it accepts no arbitrary target ID.
export async function restoreProjectTransfer(client,preparationDir,{report=()=>{}}={}) {
  const account=identity(client),root=await safe(preparationDir,'directory')
  if(typeof client.projectWrite!=='function')fail('The Claude client cannot restore a project')
  const {stageRoot,transfer,plan,contents}=await preparation(root)
  if(account.accountId===transfer.source.accountId&&account.organizationId===transfer.source.organizationId)fail('Sign Claude Desktop into the destination account before project restore')
  let receipt
  try{receipt=await readJSON(path.join(stageRoot,'restore.json'))}catch(error){if(error.code!=='ENOENT')throw error}
  const destination=receipt?.destination
  if(receipt&&(receipt.schemaVersion!==1||receipt.kind!=='claude-code-project-restore'||receipt.preparationSha256!==transfer.preparationSha256||!same(receipt.source,transfer.source)||destination?.accountId!==account.accountId||destination?.organizationId!==account.organizationId||receipt.nativeHistoryImport!==false||receipt.autoResume!==false||!Array.isArray(receipt.applied)))fail('The destination restore receipt does not match this transfer and account')
  if(receipt&&!CHANNEL.test(destination.projectId??''))fail('A previous project create did not return a saved ID. Reconcile that destination before retry; a duplicate project will not be created.')
  if(!receipt){
    receipt={schemaVersion:1,kind:'claude-code-project-restore',status:'creating',source:transfer.source,preparationSha256:transfer.preparationSha256,destination:{...account,projectId:null},nativeHistoryImport:false,autoResume:false,applied:[]}
    await state(stageRoot,'restore.json',receipt)
    report('Creating a paused project in the destination account')
    const body={name:plan.project.name,visibility:'private',disabled:true}
    for(const key of ['topic','icon','color'])if(plan.project[key]!==null&&plan.project[key]!==undefined)body[key]=plan.project[key]
    const response=await write(client,'/v1/code/channels','POST',body),created=response?.channel
    if(!CHANNEL.test(created?.id??'')||created.id===transfer.source.projectId)fail('Project create returned no new destination ID; retry will not create a duplicate')
    receipt.destination.projectId=created.id;receipt.creationProfile=profile(created);receipt.status='created';await state(stageRoot,'restore.json',receipt)
  }
  const id=receipt.destination.projectId
  if(!receipt.profile){
    if(!receipt.creationProfile||ownerAccount(receipt.creationProfile.created_by_account_id)!==client.account.toLowerCase()||!Number.isFinite(Date.parse(receipt.creationProfile.created_at)))fail('The new project owner could not be verified')
    let current=channelOf(await client.projectRequest(`/v1/code/channels/${id}`),id)
    if(!same(creationProfile(current),creationProfile(receipt.creationProfile)))fail('The new destination project changed before restore')
    await unusedDestination(client,id)
    if(!paused(current)){
      receipt.pausePending=true;await state(stageRoot,'restore.json',receipt)
      report('Pausing the new destination before restoring its data')
      await write(client,`/v1/code/channels/${id}`,'PATCH',{disabled:true})
      current=await pausedChannel(client,id)
    }
    if(!same(creationProfile(current),creationProfile(receipt.creationProfile)))fail('The new destination project changed before restore')
    receipt.profile=profile(current);receipt.pausePending=false
    receipt.configSha256=sha(canonical((await client.projectRequest(`/v1/code/channels/${id}/config`))?.config??null))
    await state(stageRoot,'restore.json',receipt)
  }
  const assertTarget=async()=>{
    const current=await pausedChannel(client,id,receipt.profile?.disabled_at)
    if(!receipt.profile||!same(profile(current),receipt.profile)||ownerAccount(current.created_by_account_id)!==client.account.toLowerCase())fail('The destination project changed or its owner is unverified')
    const response=await client.projectRequest(`/v1/code/channels/${id}/config`),configHash=sha(canonical(response?.config??null))
    if(configHash!==receipt.configSha256){
      if(receipt.configPending===true&&configHash===receipt.pendingConfigSha256){receipt.configSha256=configHash;receipt.configApplied=true;receipt.configPending=false;delete receipt.pendingConfigSha256;await state(stageRoot,'restore.json',receipt)}
      else fail('Destination project settings changed')
    }
    return current
  }
  await assertTarget()
  await unusedDestination(client,id)
  const files=await libraryIndex(client,id),memories=await memoryIndex(client,id)
  const fileMap=new Map(files.map(entry=>[targetPath(entry.path),entry])),memoryMap=new Map(memories.map(entry=>[entry.path,entry]))
  const plannedFiles=new Set(plan.libraryUploads.map(upload=>targetPath(upload.path))),plannedMemories=new Set(plan.memoryUploads.map(upload=>upload.path))
  if(files.some(entry=>!plannedFiles.has(targetPath(entry.path)))||memories.some(entry=>!plannedMemories.has(entry.path)))fail('The destination contains data outside this project transfer')
  for(const upload of plan.libraryUploads)if(fileMap.has(targetPath(upload.path)))await checkLibrary(client,id,upload)
  for(const upload of plan.memoryUploads)if(memoryMap.has(upload.path))await checkMemory(client,id,upload,memoryMap.get(upload.path))
  if(!receipt.configApplied){
    await assertTarget()
    const previous=(await client.projectRequest(`/v1/code/channels/${id}/config`))?.config
    if(!previous||sha(canonical(previous))!==receipt.configSha256)fail('Destination project settings changed')
    receipt.configPending=true;receipt.pendingConfigSha256=sha(canonical({...previous,...plan.project.config}));await state(stageRoot,'restore.json',receipt)
    if(Object.keys(plan.project.config).length)await write(client,`/v1/code/channels/${id}/config`,'PATCH',plan.project.config)
    const config=(await client.projectRequest(`/v1/code/channels/${id}/config`))?.config
    if(!config||Object.entries(plan.project.config).some(([key,value])=>!same(config[key],value)))fail('Destination project settings failed verification')
    receipt.configSha256=sha(canonical(config));receipt.configApplied=true;receipt.configPending=false;delete receipt.pendingConfigSha256;receipt.status='restoring';await state(stageRoot,'restore.json',receipt)
  }
  for(const upload of plan.memoryUploads){
    if(memoryMap.has(upload.path))continue
    await assertTarget();report(`Restoring memory ${upload.path}`)
    const bytes=contents.get(upload.sourcePath),content=bytes.toString('utf8')
    if(!Buffer.from(content).equals(bytes))fail('Project memory is not valid UTF-8')
    await write(client,`/v1/code/memory/channel/${id}/memories`,'POST',{path:upload.path,content,precondition:{type:'not_exists'}})
    const entry=(await memoryIndex(client,id)).find(item=>item.path===upload.path)
    if(!entry)fail('Restored project memory is absent')
    await checkMemory(client,id,upload,entry);receipt.applied.push({kind:'memory',path:upload.path,sha256:upload.sha256});await state(stageRoot,'restore.json',receipt)
  }
  for(const upload of plan.libraryUploads){
    if(fileMap.has(targetPath(upload.path)))continue
    await assertTarget();report(`Restoring file ${upload.path}`)
    const bytes=contents.get(upload.sourcePath)
    if(bytes.length>16*1024*1024){if(typeof client.projectUpload!=='function')fail('The Claude client cannot upload this large project file');await client.projectUpload(id,upload.path,bytes)}
    else{
      const response=await write(client,`/v1/code/channels/${id}/files:write`,'POST',{files:[{path:upload.path,overwrite:false,content:bytes.toString('base64')}]})
      const result=response?.results?.find(entry=>targetPath(entry.path??'')===targetPath(upload.path))
      if(!result?.entry||result.error_reason)fail(`Destination file write failed: ${upload.path}`)
    }
    await checkLibrary(client,id,upload);receipt.applied.push({kind:'library',path:upload.path,sha256:upload.sha256});await state(stageRoot,'restore.json',receipt)
  }
  await assertTarget()
  await unusedDestination(client,id)
  const finalFiles=await libraryIndex(client,id),finalMemories=await memoryIndex(client,id)
  if(finalFiles.length!==plan.libraryUploads.length||finalMemories.length!==plan.memoryUploads.length)fail('Destination file inventory changed during restore')
  for(const upload of plan.libraryUploads)await checkLibrary(client,id,upload)
  for(const upload of plan.memoryUploads){const entry=finalMemories.find(item=>item.path===upload.path);if(!entry)fail('Destination memory is absent');await checkMemory(client,id,upload,entry)}
  receipt.status='complete';receipt.verified=true;receipt.completedAt=new Date().toISOString();await state(stageRoot,'restore.json',receipt)
  return{path:stageRoot,projectId:id,targetProjectId:id,destination:receipt.destination,restored:true,paused:true,nativeHistoryImport:false,autoResume:false}
}
