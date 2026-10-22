import {createHash,randomUUID} from 'node:crypto'
import {lstat,readFile,rename,writeFile} from 'node:fs/promises'
import path from 'node:path'

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const CHANNEL=/^chan_[A-Za-z0-9]+$/
const MESSAGE=/^cmsg_[A-Za-z0-9]+$/
const HASH=/^[a-f0-9]{64}$/
const fail=message=>{throw new Error(message)}
const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)
const same=(a,b)=>canonical(a)===canonical(b)
const sha=value=>createHash('sha256').update(canonical(value)).digest('hex')
const paused=channel=>typeof channel.disabled_at==='string'&&Number.isFinite(Date.parse(channel.disabled_at))
const profile=channel=>Object.fromEntries(['id','name','topic','icon','color','visibility','created_by_account_id','created_at'].map(key=>[key,channel[key]??null]))
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
async function safe(file,kind,mode) {
  if(typeof file!=='string'||!path.isAbsolute(file)||file.split(path.sep).some(part=>part==='.'||part==='..'))fail('Use an absolute project transfer path')
  const absolute=path.resolve(file);let current=path.parse(absolute).root
  for(const part of absolute.split(path.sep).filter(Boolean)){
    current=path.join(current,part);const info=await lstat(current)
    if(info.isSymbolicLink()||current!==absolute&&!info.isDirectory())fail('Project transfer paths must not contain symlinks')
    if(current===absolute&&((kind==='file'?!info.isFile():!info.isDirectory())||(info.mode&0o777)!==mode))fail('Project transfer receipts must be private files in a private directory')
  }
  return absolute
}
const readJSON=async file=>JSON.parse(await readFile(await safe(file,'file',0o600),'utf8'))
async function save(root,value) {
  await safe(root,'directory',0o700)
  const pending=path.join(root,'.resume.json.pending')
  const old=await lstat(pending).catch(error=>{if(error.code==='ENOENT')return null;throw error})
  if(old&&(!old.isFile()||old.isSymbolicLink()||(old.mode&0o777)!==0o600))fail('Unsafe pending project resume receipt')
  await writeFile(pending,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'w'})
  await rename(pending,path.join(root,'resume.json'))
}
function continuation(source) {
  return `Continue this transferred project from its latest saved state. First read /MEMORY.md and the project library file migration/${source.projectId}/main-transcript.md. Use the thread handoff files listed in /MEMORY.md to recover each unfinished task and its last state. These files are saved history references; the original native threads were not imported. Continue the unfinished work within the original user scope and permission limits. Use the existing approvals. Do not repeat completed or resolved tasks. Ask only if an action needs new authority. Start with a short account of the recovered state and the next unfinished action.`
}
async function messages(client,id) {
  const rows=[],seen=new Set();let cursor
  for(let page=0;page<100;page++){
    const query=new URLSearchParams({limit:'200',include_replies:'true',include_bound_session_rows:'true',...cursor?{cursor}:{}})
    const result=await client.projectRequest(`/v1/code/channels/${id}/timeline?${query}`)
    if(!Array.isArray(result?.data))fail('The destination timeline could not be checked')
    rows.push(...result.data)
    const next=result.next_cursor??result.cursor??result.resume_cursor
    if(!next){if(result.has_more===true||result.truncated===true)fail('The destination timeline is incomplete');return rows}
    if(typeof next!=='string'||seen.has(next))fail('The destination timeline cursor did not advance')
    seen.add(next);cursor=next
  }
  fail('The destination timeline exceeded its page limit')
}
function accepted(rows,receipt,account) {
  const found=rows.filter(row=>row.client_message_id===receipt.client_message_id)
  if(found.length>1)fail('The resume message is ambiguous; no second start was sent')
  if(!found.length)return null
  const row=found[0]
  if(!MESSAGE.test(row.id??'')||row.channel_id!==receipt.destination.projectId||row.body!==receipt.body||ownerAccount(row.author_account_id)!==account||!MESSAGE.test(row.thread_root_id??'')||receipt.messageId&&receipt.messageId!==row.id)fail('The saved resume message does not match this transfer')
  return row
}
const write=(client,endpoint,method,body)=>client.projectWrite(endpoint,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)})

// The caller holds the transfer operation lock and has checked the source pause.
// One saved client message ID binds every retry to one coordinator request.
export async function resumeProjectTransfer(client,stageRoot,{report=()=>{}}={}) {
  if(!UUID.test(client?.account??'')||!UUID.test(client?.org??'')||typeof client.projectRequest!=='function'||typeof client.projectWrite!=='function')fail('A verified destination Claude client is required')
  const root=await safe(stageRoot,'directory',0o700),transfer=await readJSON(path.join(root,'transfer.json')),restore=await readJSON(path.join(root,'restore.json'))
  const source=transfer.source,destination=restore.destination
  if(transfer.schemaVersion!==1||transfer.kind!=='claude-code-project-transfer'||transfer.status!=='ready'||transfer.sourcePaused!==true||transfer.nativeHistoryImport!==false||!UUID.test(source?.accountId??'')||!UUID.test(source?.organizationId??'')||!CHANNEL.test(source?.projectId??'')||!HASH.test(transfer.preparationSha256??''))fail('Resume requires a completed source project transfer')
  if(restore.schemaVersion!==1||restore.kind!=='claude-code-project-restore'||restore.status!=='complete'||restore.verified!==true||restore.nativeHistoryImport!==false||restore.preparationSha256!==transfer.preparationSha256||!same(restore.source,source)||destination?.accountId!==client.account||destination?.organizationId!==client.org||!CHANNEL.test(destination?.projectId??'')||destination.projectId===source.projectId||destination.accountId===source.accountId&&destination.organizationId===source.organizationId||!HASH.test(restore.configSha256??''))fail('Resume requires the verified restore for this source and destination account')
  const id=destination.projectId,endpoint=`/v1/code/channels/${id}`
  if(!restore.profile||restore.profile.id!==id||ownerAccount(restore.profile.created_by_account_id)!==client.account.toLowerCase()||!Number.isFinite(Date.parse(restore.profile.created_at))||!paused(restore.profile))fail('The restored destination project owner or pause state is unverified')
  let receipt
  try{receipt=await readJSON(path.join(root,'resume.json'))}catch(error){if(error.code!=='ENOENT')throw error}
  const body=continuation(source)
  if(receipt&&(receipt.schemaVersion!==1||receipt.kind!=='claude-code-project-resume'||!['pending','complete'].includes(receipt.status)||!same(receipt.source,source)||!same(receipt.destination,destination)||receipt.preparationSha256!==transfer.preparationSha256||receipt.configSha256!==restore.configSha256||!UUID.test(receipt.client_message_id??'')||receipt.body!==body))fail('The project resume receipt does not match this transfer')
  const current=async()=>{
    const result=await client.projectRequest(endpoint),channel=result?.channel
    if(channel?.id!==id||ownerAccount(channel.created_by_account_id)!==client.account.toLowerCase()||channel.created_at!==restore.profile.created_at)fail('The destination project identity or owner changed')
    return channel
  }
  let channel=await current(),rows=await messages(client,id)
  const finish=async row=>{
    Object.assign(receipt,{status:'complete',phase:'accepted',messageId:row.id,threadRootId:row.thread_root_id,acceptedAt:row.created_at??new Date().toISOString(),completedAt:new Date().toISOString(),verified:true,coordinatorStarted:null})
    await save(root,receipt)
    report('The project continuation request was accepted. The coordinator start has not been checked.')
    return{path:root,projectId:id,targetProjectId:id,destination,resumed:true,accepted:true,coordinatorStarted:null,nativeHistoryImport:false,messageId:row.id,clientMessageId:receipt.client_message_id}
  }
  if(receipt){const row=accepted(rows,receipt,client.account.toLowerCase());if(row)return finish(row);if(receipt.status==='complete')fail('The accepted resume message is no longer in the timeline; no second start was sent')}
  if(!same(profile(channel),profile(restore.profile)))fail('The restored destination project changed before resume')
  if(!receipt&&(!paused(channel)||channel.disabled_at!==restore.profile.disabled_at))fail('The restored project is not paused at its verified state')
  if(rows.length)fail('The destination has other conversation work; no project start was sent')
  const config=(await client.projectRequest(`${endpoint}/config`))?.config
  if(!config||sha(config)!==restore.configSha256)fail('The restored destination settings changed before resume')
  if(!/^cagt_[A-Za-z0-9]+$/.test(config.agent_id??''))fail('The destination has no verified project agent. Open it in Claude and check its setup before resume.')
  if(!receipt){
    receipt={schemaVersion:1,kind:'claude-code-project-resume',status:'pending',phase:'prepared',source,destination,preparationSha256:transfer.preparationSha256,configSha256:restore.configSha256,client_message_id:randomUUID(),body,createdAt:new Date().toISOString(),coordinatorStarted:null,nativeHistoryImport:false}
    await save(root,receipt)
  }
  if(paused(channel)){
    if(channel.disabled_at!==restore.profile.disabled_at)fail('The destination pause state changed before resume')
    receipt.phase='unpausing';await save(root,receipt)
    report('Unpausing the restored destination project')
    try{await write(client,endpoint,'PATCH',{disabled:false})}catch(error){channel=await current();if(paused(channel))throw error}
    channel=await current()
  }
  if(channel.disabled_at!==null&&channel.disabled_at!==undefined)fail('The destination project did not unpause')
  receipt.phase='sending';await save(root,receipt)
  report('Sending one continuation request to the project coordinator')
  let response,sendError
  try{response=await write(client,`${endpoint}/messages`,'POST',{body:receipt.body,client_message_id:receipt.client_message_id})}catch(error){sendError=error}
  if(response?.message_id!==undefined){if(!MESSAGE.test(response.message_id))fail('The continuation response has an invalid message ID');receipt.messageId=response.message_id;await save(root,receipt)}
  rows=await messages(client,id)
  const row=accepted(rows,receipt,client.account.toLowerCase())
  if(row)return finish(row)
  if(sendError)throw sendError
  fail('The continuation request is not yet verified. Retry uses the same message ID.')
}
