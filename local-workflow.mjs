import {createHash, randomUUID} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {readdir, readFile, realpath, rename, mkdir, link, unlink, stat, open} from 'node:fs/promises'
import path from 'node:path'
import {accounts, checkDesktopProfile, layout, signedIn, locked} from './transplant.js'

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const RECORD = /^local_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/i
const digest = value => createHash('sha256').update(value).digest('hex')
const registryDigest = value => digest(JSON.stringify(value, (_key,item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item))
const read = async (file, fallback) => {
  try { return JSON.parse(await readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error }
}
const exists = file => stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
const names = async dir => (await readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error })).filter(name => RECORD.test(name)).sort()
const same = (a,b) => a?.account === b?.account && a?.org === b?.org
const ref = row => ({account:row.account,org:row.org,label:row.label})
const namespace = (paths, account) => {
  if (!ID.test(account?.account ?? '') || !ID.test(account?.org ?? '')) throw new Error('Invalid account or plan identity')
  return path.join(paths.records,account.account,account.org)
}
const atomic = async (file,value) => {
  await mkdir(path.dirname(file),{recursive:true})
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await open(temporary,'wx',0o600)
  try { await handle.writeFile(JSON.stringify(value,null,2)+'\n'); await handle.sync() }
  finally { await handle.close() }
  try { await rename(temporary,file) } finally { await unlink(temporary).catch(()=>{}) }
}

const profileFile = paths => path.join(paths.baseState??(paths.profile?layout(paths.home).state:paths.state),'local-profile.json')
const profileRoot = paths => paths.profile??path.dirname(paths.desktop??layout(paths.home).desktop)
async function checkedProfile(directory) {
  if(typeof directory!=='string' || !path.isAbsolute(directory))throw new Error('The saved Claude Desktop profile is invalid. Select the source again.')
  try {
    const canonical=await realpath(directory)
    const config=path.join(canonical,'config.json')
    if(!(await stat(config)).isFile() || !(await readFile(config)).length)throw new Error('Missing profile configuration')
    return canonical
  } catch {
    throw new Error('The Claude Desktop profile is missing or cannot be read. Select an available source profile again.')
  }
}

export async function readLocalProfile(paths) {
  let saved
  try {saved=JSON.parse(await readFile(profileFile(paths),'utf8'))}
  catch(error) {
    if(error.code==='ENOENT')return null
    throw new Error('The saved Claude Desktop profile cannot be read. Select the source again.')
  }
  if(!saved || saved.version!==1)throw new Error('The saved Claude Desktop profile is invalid. Select the source again.')
  return {version:1,profile:await checkedProfile(saved.profile)}
}

export async function rememberLocalProfile(paths) {
  const saved={version:1,profile:await checkedProfile(profileRoot(paths))}
  await atomic(profileFile(paths),saved)
  return saved
}

export async function localProfileMismatch(paths) {
  const saved=await readLocalProfile(paths)
  if(!saved)return null
  const currentProfile=await checkedProfile(profileRoot(paths))
  return saved.profile===currentProfile?null:{profileMismatch:true,savedProfile:saved.profile,currentProfile}
}

async function requireLocalProfile(paths) {
  if(await localProfileMismatch(paths))throw new Error('Claude opened a different profile. Open the saved Claude profile before you move or resume conversations.')
}

export async function collection(paths) {
  return read(path.join(paths.state,'local-workflow.json'),null)
}

export async function selectSource(paths,selector,{allAccounts=null}={}) {
  if(await exists(path.join(paths.state,'local-workflow-pending.json'))) throw new Error('Recover the interrupted move before changing the source')
  const all=allAccounts??await accounts(paths,null,{verifyIdentity:true})
  const source=all.find(row=>`${row.account}/${row.org}`===selector)
  if(!source)throw new Error('Select a source account and plan from the account list')
  if(source.unreadable?.length || source.taskError)throw new Error('The source contains unreadable records or tasks; repair them before selecting it')
  const records=await names(namespace(paths,source))
  if(!records.length)throw new Error('The selected source has no local conversations')
  checkDesktopProfile(paths)
  const initial={version:1,current:ref(source),records,preserve:{}}
  const previous=await collection(paths)
  await atomic(path.join(paths.state,'local-workflow.json'),initial)
  try {await rememberLocalProfile(paths)}
  catch(error) {
    if(previous)await atomic(path.join(paths.state,'local-workflow.json'),previous)
    else await unlink(path.join(paths.state,'local-workflow.json'))
    throw error
  }
  return {selected:true,count:records.length,source:ref(source)}
}

export async function transcriptIndex(pool) {
  const result = new Map()
  for (const folder of await readdir(pool,{withFileTypes:true}).catch(()=>[])) {
    if (!folder.isDirectory()) continue
    for (const name of await readdir(path.join(pool,folder.name))) {
      if (!name.endsWith('.jsonl') || !ID.test(name.slice(0,-6))) continue
      const file=path.join(pool,folder.name,name), info=await stat(file)
      const current=result.get(name.slice(0,-6))
      if (!current || current.mtime<info.mtimeMs) result.set(name.slice(0,-6),{file,mtime:info.mtimeMs,size:info.size})
    }
  }
  return result
}

export async function tailRows(info) {
  if (!info) return []
  const handle=await open(info.file,'r')
  try {
    const length=Math.min(info.size,1_000_000),buffer=Buffer.alloc(length)
    await handle.read(buffer,0,length,info.size-length)
    return buffer.toString('utf8').split('\n').flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}})
  } finally {await handle.close()}
}

// A Desktop quit kills background tasks and queues their task notifications, but nothing delivers them.
function queuedTaskResult(rows) {
  const queue=[]
  for (const row of rows) {
    if (row.type!=='queue-operation') continue
    if (row.operation==='enqueue') queue.push(row.content)
    if (row.operation==='dequeue') queue.shift()
    if (row.operation==='remove' && queue.includes(row.content)) queue.splice(queue.indexOf(row.content),1)
  }
  return queue.some(content=>/<task-notification>/.test(content??''))
}

export function resumeReason(record, rows, now=Date.now()) {
  if (record.isArchived || record.scheduledTaskId || !record.cliSessionId || now-(record.lastActivityAt??0)>24*3600_000) return null
  if (record.postTurnSummary?.needs_action?.trim()) return null
  if (/\b(?:session|weekly|usage|rate)[ _-]limit\b|\brate_limit_error\b/i.test(record.error??'')) return 'Usage limit reached'
  if (record.error && /limit|overload|interrupt|connection|timeout|authentication/i.test(record.error)) return 'Interrupted'
  if (/in progress|pending|waiting|will .*after/i.test(record.postTurnSummary?.status_detail??'')) return 'Pending check'
  const conversation=rows.filter(row=>['user','assistant'].includes(row.type))
  const last=conversation.at(-1)
  if (!last) return null
  if (last.type==='assistant' && last.message?.stop_reason==='tool_use') return 'Interrupted tool call'
  if (last.type==='assistant') return queuedTaskResult(rows.slice(rows.lastIndexOf(last)+1)) ? 'Pending task result' : null
  const content=last.message?.content
  const text=typeof content==='string'?content:JSON.stringify(content??'')
  if (/\[Request interrupted by user/.test(text)) return 'Interrupted turn'
  if (/<task-notification>/.test(text)) return 'Pending task result'
  if (!/<cross-session-message/.test(text)) return 'Unanswered request'
  return 'Pending session message'
}

export async function resumeCandidates(paths,dir,selected) {
  const index=await transcriptIndex(paths.pool), result=[]
  for (const name of selected) {
    const record=await read(path.join(dir,name),null)
    if (!record) continue
    if (record.isArchived || record.scheduledTaskId || !record.cliSessionId || Date.now()-(record.lastActivityAt??0)>24*3600_000) continue
    const reason=resumeReason(record,await tailRows(index.get(record.cliSessionId)))
    if (reason) result.push({recordId:record.sessionId,cliSessionId:record.cliSessionId,title:record.title??record.sessionId,reason})
  }
  return result.sort((a,b)=>a.title.localeCompare(b.title) || a.recordId.localeCompare(b.recordId))
}

export async function planLocal(paths,{allAccounts=null,includeResume=true,limitsOnly=false}={}) {
  const mismatch=await localProfileMismatch(paths)
  if(mismatch)return mismatch
  const group=await collection(paths)
  const all=allAccounts??await accounts(paths,null,{verifyIdentity:true})
  if(!group && !paths.profile)return {setup:true}
  const to=all.find(row=>row.active)
  if (!to) throw new Error('Open Claude Desktop and sign into the destination plan')
  if (!to.identityKnown) throw new Error('Could not verify your Claude account. Keep Claude open and try again shortly.')
  if(!group)return {setup:true}
  if (!to.personal) throw new Error('This plan is not Personal Max or Pro. Select a Personal Max or Pro plan in Claude.')
  if(allAccounts===null && !same(to,await signedIn(paths)))throw new Error('Claude is still changing accounts. Try again in a moment.')
  const pending=await read(path.join(paths.state,'local-workflow-pending.json'),null)
  if(limitsOnly && (pending || !same(group.current,to))) throw new Error('Resume limit-stopped requires the collection to be on the current plan. No records were moved.')
  if(pending){
    if(!same(pending.to,to))throw new Error(`Sign into ${pending.to.label} to recover the interrupted move`)
    return {from:pending.from,to:pending.to,count:pending.records.length,moving:true,recovery:true,token:pending.token,records:pending.records.map(row=>row.name),resume:includeResume?pending.resume??[]:[]}
  }
  const from=all.find(row=>same(row,group.current))
  if (!from) throw new Error('The previous source account is missing')
  if(from.unreadable?.length || from.taskError || to.unreadable?.length || to.taskError)throw new Error('The source or destination contains unreadable records or tasks')
  const dir=namespace(paths,from), keep=new Set(group.preserve?.[`${from.account}/${from.org}`]??[])
  const selected=(await names(dir)).filter(name=>!keep.has(name))
  if (!selected.length) throw new Error('No conversations remain in the recorded source account')
  const token=digest(JSON.stringify({profileId:paths.profileId,from:ref(from),to:ref(to),selected}))
  const candidates=includeResume?await resumeCandidates(paths,dir,selected):[]
  const limited=candidates.filter(item=>item.reason==='Usage limit reached')
  return {from:ref(from),to:ref(to),count:selected.length,moving:!same(from,to),token,records:selected,
    resume:limitsOnly?limited:candidates,limitResumeCount:limited.length}
}

export async function assertDesktopStopped(paths,records) {
  const output=spawnSync('/bin/ps',['-axo','pid=,comm='],{encoding:'utf8'}).stdout??''
  if (output.includes('/Claude.app/Contents/MacOS/Claude') || output.includes('/Library/Application Support/Claude/claude-code/')) throw new Error('Claude or one of its Desktop workers is still running')
  const ids=new Set(records.map(row=>row.data.cliSessionId).filter(Boolean))
  for (const file of await readdir(path.join(paths.home,'.claude/sessions')).catch(()=>[])) {
    const registration=await read(path.join(paths.home,'.claude/sessions',file),null).catch(()=>null)
    if (!registration || !ids.has(registration.sessionId)) continue
    // EPERM: another user's process reused the PID of a worker that stopped without cleanup.
    try {process.kill(registration.pid,0)} catch(error){if(['ESRCH','EPERM'].includes(error.code))continue;throw error}
    const matches=records.filter(row=>row.data.cliSessionId===registration.sessionId)
    if (matches.every(row=>row.data.isArchived===true && row.data.cwd!==registration.cwd)) {
      const opened=spawnSync('/usr/sbin/lsof',['-p',String(registration.pid),'-Fn'],{encoding:'utf8'}).stdout??''
      if (!opened.includes(paths.records)) continue
    }
    throw new Error(`An external Claude worker still uses ${matches[0]?.data.title??registration.sessionId}`)
  }
}

function transferTasks(source,target,ids) {
  const moved=(source.scheduledTasks??[]).filter(task=>ids.has(task.id))
  for (const task of moved) if ((target.scheduledTasks??[]).some(other=>other.id===task.id || (task.notifySessionId && other.notifySessionId===task.notifySessionId))) throw new Error('Destination scheduled-task collision')
  source.scheduledTasks=(source.scheduledTasks??[]).filter(task=>!ids.has(task.id))
  target.scheduledTasks=[...(target.scheduledTasks??[]),...moved]
  for (const key of ['recordedSkips','runRetries']) for (const id of ids) {
    if (!Object.hasOwn(source[key]??{},id)) continue
    if (Object.hasOwn(target[key]??{},id)) throw new Error('Destination scheduled-task state collision')
    target[key]??={};target[key][id]=source[key][id];delete source[key][id]
  }
}

export async function moveRecords(paths,plan,{checkStopped=assertDesktopStopped,afterRecord=null}={}) {
  const src=namespace(paths,plan.from),dst=namespace(paths,plan.to)
  if (same(plan.from,plan.to)) return {moved:0}
  if (plan.records.some(name=>!RECORD.test(name))) throw new Error('Invalid local record filename')
  const rows=[]
  for (const name of plan.records) {
    const raw=await readFile(path.join(src,name)),data=JSON.parse(raw)
    if (data.sessionId!==name.slice(0,-5)) throw new Error('Source record identity mismatch')
    if (await exists(path.join(dst,name)) || await exists(path.join(dst,`deleted_${data.sessionId.slice(6)}`))) throw new Error(`Destination collision: ${data.title??name}`)
    rows.push({name,raw,data,sha:digest(raw)})
  }
  const ids=new Set(rows.map(row=>row.data.cliSessionId).filter(Boolean))
  const existing=await names(dst)
  for(const name of existing) if(ids.has((await read(path.join(dst,name))).cliSessionId)) throw new Error('Destination already has a record for this conversation')
  await checkStopped(paths,rows)
  await mkdir(dst,{recursive:true})
  const sourceFile=path.join(src,'scheduled-tasks.json'),targetFile=path.join(dst,'scheduled-tasks.json')
  const source=await read(sourceFile,{scheduledTasks:[]}),target=await read(targetFile,{scheduledTasks:[]})
  const sessionIds=new Set(rows.map(row=>row.data.sessionId))
  const taskIds=new Set((source.scheduledTasks??[]).filter(task=>sessionIds.has(task.notifySessionId)).map(task=>task.id))
  for(const task of source.scheduledTasks??[]) if(taskIds.has(task.id) && !sessionIds.has(task.notifySessionId)) throw new Error('Incomplete scheduled-task family')
  for(const name of (await names(src)).filter(name=>!plan.records.includes(name))) {
    const data=await read(path.join(src,name))
    if(taskIds.has(data.scheduledTaskId)) throw new Error('A scheduled-task run would be left behind')
  }
  const nextSource=structuredClone(source),nextTarget=structuredClone(target)
  transferTasks(nextSource,nextTarget,taskIds)
  const originalGroup=await collection(paths)
  const pendingFile=path.join(paths.state,'local-workflow-pending.json')
  if(await exists(pendingFile)) throw new Error('A previous local move needs recovery; no new move was started')
  const journal={from:plan.from,to:plan.to,token:plan.token,resume:plan.resume,records:rows.map(({name,sha})=>({name,sha})),taskIds:[...taskIds],phase:'records',
    sourceTaskOrder:(source.scheduledTasks??[]).map(row=>row.id),sourceTaskKeys:Object.keys(source),targetTaskKeys:Object.keys(target),sourceBefore:registryDigest(source),sourceAfter:registryDigest(nextSource),targetBefore:registryDigest(target),targetAfter:registryDigest(nextTarget)}
  await atomic(pendingFile,journal)
  const completed=[]
  try {
    for (const row of rows) {
      if(digest(await readFile(path.join(src,row.name)))!==row.sha) throw new Error('Source record changed during move')
      await link(path.join(src,row.name),path.join(dst,row.name))
      await unlink(path.join(src,row.name));completed.push(row)
      if(afterRecord) await afterRecord(completed.length)
    }
    journal.phase='tasks';await atomic(pendingFile,journal)
    if(taskIds.size){await atomic(targetFile,nextTarget);await atomic(sourceFile,nextSource)}
    for(const row of rows) if(await exists(path.join(src,row.name)) || digest(await readFile(path.join(dst,row.name)))!==row.sha) throw new Error('Record verification failed')
    const group=await collection(paths)
    group.preserve??={}
    group.preserve[`${plan.to.account}/${plan.to.org}`]??=existing
    group.current=plan.to;group.records=plan.records;group.lastMoveAt=new Date().toISOString()
    group.resume=plan.resume
    await atomic(path.join(paths.state,'local-workflow.json'),group)
    await unlink(pendingFile)
    return {moved:rows.length}
  } catch(error) {
    if(taskIds.size){await atomic(sourceFile,source);await atomic(targetFile,target)}
    for(const row of completed.reverse()) {
      if(!(await exists(path.join(src,row.name))) && digest(await readFile(path.join(dst,row.name)))===row.sha){await link(path.join(dst,row.name),path.join(src,row.name));await unlink(path.join(dst,row.name))}
    }
    if(await Promise.all(rows.map(async row=>await exists(path.join(src,row.name)) && !(await exists(path.join(dst,row.name))))).then(checks=>checks.every(Boolean))) {
      await atomic(path.join(paths.state,'local-workflow.json'),originalGroup)
      await unlink(pendingFile)
    }
    throw error
  }
}

export async function recoverLocal(paths,{checkStopped=assertDesktopStopped}={}) {
  const file=path.join(paths.state,'local-workflow-pending.json'),journal=await read(file,null)
  if(!journal)return
  const src=namespace(paths,journal.from),dst=namespace(paths,journal.to),rows=[]
  for(const row of journal.records){
    if(!RECORD.test(row.name))throw new Error('Invalid recovery record')
    const location=await exists(path.join(src,row.name))?src:dst
    const raw=await readFile(path.join(location,row.name))
    if(digest(raw)!==row.sha)throw new Error('A record changed after the interrupted move; recovery stopped')
    rows.push({...row,data:JSON.parse(raw)})
  }
  await checkStopped(paths,rows)
  const sourceFile=path.join(src,'scheduled-tasks.json'),targetFile=path.join(dst,'scheduled-tasks.json')
  const source=await read(sourceFile,{scheduledTasks:[]}),target=await read(targetFile,{scheduledTasks:[]})
  const sourceHash=registryDigest(source),targetHash=registryDigest(target),ids=new Set(journal.taskIds)
  if(![journal.sourceBefore,journal.sourceAfter].includes(sourceHash)||![journal.targetBefore,journal.targetAfter].includes(targetHash))throw new Error('Scheduled tasks changed after the interrupted move')
  if(targetHash!==journal.targetBefore){
    if(sourceHash===journal.sourceBefore){
      target.scheduledTasks=(target.scheduledTasks??[]).filter(row=>!ids.has(row.id))
      for(const key of ['recordedSkips','runRetries'])for(const id of ids)if(target[key])delete target[key][id]
    } else {
      transferTasks(target,source,ids)
      source.scheduledTasks.sort((a,b)=>journal.sourceTaskOrder.indexOf(a.id)-journal.sourceTaskOrder.indexOf(b.id))
    }
    // Remove empty fields that the transfer introduced.
    for(const [value,keys] of [[source,journal.sourceTaskKeys],[target,journal.targetTaskKeys]])for(const key of ['scheduledTasks','recordedSkips','runRetries']) {
      if(!keys.includes(key) && value[key] && Object.keys(value[key]).length===0)delete value[key]
    }
    if(registryDigest(source)!==journal.sourceBefore||registryDigest(target)!==journal.targetBefore)throw new Error('Scheduled-task recovery could not be verified')
    await atomic(sourceFile,source);await atomic(targetFile,target)
  } else if(sourceHash!==journal.sourceBefore)throw new Error('Scheduled-task source needs inspection')
  for(const row of rows){
    const sourcePath=path.join(src,row.name),targetPath=path.join(dst,row.name)
    if(!(await exists(targetPath)))continue
    if(digest(await readFile(targetPath))!==row.sha)throw new Error('Destination changed after the interrupted move')
    if(!(await exists(sourcePath)))await link(targetPath,sourcePath)
    const [a,b]=await Promise.all([stat(sourcePath),stat(targetPath)])
    if(a.dev!==b.dev||a.ino!==b.ino)throw new Error('Recovery found two independent copies; neither was removed')
    await unlink(targetPath)
  }
  const group=await collection(paths)
  group.current=journal.from;group.records=journal.records.map(row=>row.name);group.resume=journal.resume
  await atomic(path.join(paths.state,'local-workflow.json'),group)
  await unlink(file)
}

async function quitDesktop(paths) {
  const result=spawnSync('/usr/bin/osascript',['-e','tell application id "com.anthropic.claudefordesktop" to quit'],{encoding:'utf8',timeout:15000})
  if(result.status!==0) throw new Error('Claude refused to close; finish its open dialog and try again')
  for(let count=0;count<100;count++) {
    const list=spawnSync('/bin/ps',['-axo','comm='],{encoding:'utf8'}).stdout??''
    if(!list.includes('/Claude.app/Contents/MacOS/Claude') && !list.includes('/Library/Application Support/Claude/claude-code/'))return
    await new Promise(resolve=>setTimeout(resolve,250))
  }
  throw new Error('Claude did not stop within 25 seconds; no force quit was used')
}

function openDesktop(paths) {
  const args=['-a',paths.claudeApp]
  if(paths.profile)args.push('--args',`--user-data-dir=${paths.profile}`)
  const result=spawnSync('/usr/bin/open',args,{encoding:'utf8',timeout:10000})
  if(result.status!==0)throw new Error('Could not reopen the selected Claude Desktop profile')
}

async function profileRecords(directory) {
  const rows=[]
  for(const account of await readdir(directory).catch(error=>{if(error.code==='ENOENT')return [];throw error})) {
    if(!ID.test(account))continue
    for(const org of await readdir(path.join(directory,account))) {
      if(!ID.test(org))continue
      const dir=path.join(directory,account,org)
      for(const name of await names(dir))rows.push({name,data:await read(path.join(dir,name))})
    }
  }
  return rows
}

async function openLocalProfile(paths,io) {
  const mismatch=await localProfileMismatch(paths)
  if(!mismatch)throw new Error('No different saved Claude profile is available to open.')
  const savedRecords=path.join(mismatch.savedProfile,'claude-code-sessions')
  const rows=[...await profileRecords(paths.records),...await profileRecords(savedRecords)]
  checkDesktopProfile(paths)
  try {
    await(io.quitDesktop??quitDesktop)(paths)
    await(io.checkStopped??assertDesktopStopped)(paths,rows)
    const saved=await readLocalProfile(paths)
    if(saved?.profile!==mismatch.savedProfile)throw new Error('The saved Claude profile changed. Refresh and try again.')
    const defaultDirectory=path.dirname(layout(paths.home).desktop)
    const defaultProfile=await realpath(defaultDirectory).catch(error=>{if(error.code==='ENOENT')return defaultDirectory;throw error})
    const isDefault=saved.profile===defaultProfile,baseState=path.dirname(profileFile(paths))
    const target={...paths,baseState,state:isDefault?baseState:path.join(baseState,'profiles',digest(saved.profile)),
      profile:isDefault?undefined:saved.profile,profileId:isDefault?undefined:digest(saved.profile),desktopInstance:undefined,
      desktop:path.join(saved.profile,'config.json'),records:savedRecords,cookies:path.join(saved.profile,'Cookies'),
      agentSessions:path.join(saved.profile,'local-agent-mode-sessions')}
    await(io.openDesktop??openDesktop)(target)
    return {opened:true,profile:saved.profile}
  } catch(error) {
    try {await(io.openDesktop??openDesktop)(paths)}
    catch {throw new Error(`${error.message} Could not reopen the previous Claude profile.`)}
    throw error
  }
}

export async function runLocal(paths,command,token,emit,{source=null,includeResume=true,limitsOnly=false,io={}}={}) {
  if(command==='local-identity')return emit({...await signedIn(paths),profileId:paths.profileId})
  if(command==='local-plan') return emit(await planLocal(paths,{includeResume,limitsOnly}))
  if(command==='local-source')return locked(paths,async()=>emit(await selectSource(paths,source)))
  if(command==='local-open-profile')return locked(paths,async()=>emit(await openLocalProfile(paths,io)))
  await requireLocalProfile(paths)
  if(command==='local-status') {
    const group=await collection(paths),index=await transcriptIndex(paths.pool),rows=[]
    if(!group)return emit({rows})
    for(const item of group.resume??[]) {
      const data=await read(path.join(namespace(paths,group.current),`${item.recordId}.json`),null)
      const recent=(await tailRows(index.get(item.cliSessionId))).filter(row=>row.timestamp>(group.lastResumeAt??group.lastMoveAt??''))
      const activity=recent.some(row=>row.type==='assistant' && row.message?.content?.some?.(part=>part.type==='tool_use' || part.type==='text'))
      rows.push({...item,activity,error:!data?'The moved record is missing':data.cliSessionId!==item.cliSessionId?'The conversation identity changed':data.error??null,waiting:data?.postTurnSummary?.needs_action??null})
    }
    return emit({rows})
  }
  return locked(paths,async()=>{
    const plan=await(io.plan??planLocal)(paths,{includeResume,limitsOnly})
    if(plan.profileMismatch)throw new Error('Claude opened a different profile. Open the saved Claude profile before you move or resume conversations.')
    if(plan.setup)throw new Error('Select the source account first')
    if(plan.token!==token)throw new Error('The account or session list changed. Refresh and try again.')
    checkDesktopProfile(paths)
    if(plan.moving){
      emit({stage:'close',text:'Closing Claude briefly'})
      await(io.quitDesktop??quitDesktop)(paths)
      const moveOptions={checkStopped:io.checkStopped??assertDesktopStopped}
      try{if(plan.recovery)await recoverLocal(paths,moveOptions);emit({stage:'move',text:`Moving ${plan.count} records`});await moveRecords(paths,plan,moveOptions)}
      finally{await(io.openDesktop??openDesktop)(paths)}
    } else {
      const group=await collection(paths);group.resume=plan.resume;await atomic(path.join(paths.state,'local-workflow.json'),group)
    }
    const group=await collection(paths);group.lastResumeAt=new Date().toISOString();group.resume=plan.resume
    await atomic(path.join(paths.state,'local-workflow.json'),group)
    await rememberLocalProfile(paths)
    emit({done:true,ok:true,moved:plan.moving?plan.count:0,resume:plan.resume,target:paths.profileId?{...plan.to,profileId:paths.profileId}:plan.to})
  })
}
