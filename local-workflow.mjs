import {createHash, randomUUID} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {readdir, readFile, rename, mkdir, link, unlink, stat, open} from 'node:fs/promises'
import path from 'node:path'
import {accounts, signedIn, locked} from './transplant.js'

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
  const initial={version:1,current:ref(source),records,preserve:{}}
  await atomic(path.join(paths.state,'local-workflow.json'),initial)
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

export function resumeReason(record, rows, now=Date.now()) {
  if (record.isArchived || record.scheduledTaskId || !record.cliSessionId || now-(record.lastActivityAt??0)>24*3600_000) return null
  if (record.postTurnSummary?.needs_action?.trim()) return null
  if (record.error && /limit|overload|interrupt|connection|timeout|authentication/i.test(record.error)) return 'Interrupted'
  if (/in progress|pending|waiting|will .*after/i.test(record.postTurnSummary?.status_detail??'')) return 'Pending check'
  const conversation=rows.filter(row=>['user','assistant'].includes(row.type))
  const last=conversation.at(-1)
  if (!last) return null
  if (last.type==='assistant') return last.message?.stop_reason==='tool_use' ? 'Interrupted tool call' : null
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

export async function planLocal(paths,{allAccounts=null,includeResume=true}={}) {
  const group=await collection(paths)
  const all=allAccounts??await accounts(paths,null,{verifyIdentity:true})
  if(!group)return {setup:true}
  const to=all.find(row=>row.active)
  if (!to) throw new Error('Open Claude Desktop and sign into the destination plan')
  if (!to.identityKnown || !to.personal) throw new Error('Select your Personal Max or Pro plan in Claude; its identity must be verified')
  if(allAccounts===null && !same(to,await signedIn(paths)))throw new Error('Claude is still changing accounts. Try again in a moment.')
  const pending=await read(path.join(paths.state,'local-workflow-pending.json'),null)
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
  const token=digest(JSON.stringify({from:ref(from),to:ref(to),selected}))
  return {from:ref(from),to:ref(to),count:selected.length,moving:!same(from,to),token,records:selected,
    resume:includeResume?await resumeCandidates(paths,dir,selected):[]}
}

export async function assertDesktopStopped(paths,records) {
  const output=spawnSync('/bin/ps',['-axo','pid=,comm='],{encoding:'utf8'}).stdout??''
  if (output.includes('/Applications/Claude.app/Contents/MacOS/Claude') || output.includes('/Library/Application Support/Claude/claude-code/')) throw new Error('Claude or one of its Desktop workers is still running')
  const ids=new Set(records.map(row=>row.data.cliSessionId).filter(Boolean))
  for (const file of await readdir(path.join(paths.home,'.claude/sessions')).catch(()=>[])) {
    const registration=await read(path.join(paths.home,'.claude/sessions',file),null).catch(()=>null)
    if (!registration || !ids.has(registration.sessionId)) continue
    try {process.kill(registration.pid,0)} catch(error){if(error.code==='ESRCH')continue;throw error}
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
    if(!list.includes('/Applications/Claude.app/Contents/MacOS/Claude') && !list.includes('/Library/Application Support/Claude/claude-code/'))return
    await new Promise(resolve=>setTimeout(resolve,250))
  }
  throw new Error('Claude did not stop within 25 seconds; no force quit was used')
}

export async function runLocal(paths,command,token,emit,{source=null,includeResume=true}={}) {
  if(command==='local-identity')return emit(await signedIn(paths))
  if(command==='local-plan') return emit(await planLocal(paths,{includeResume}))
  if(command==='local-source')return locked(paths,async()=>emit(await selectSource(paths,source)))
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
    const plan=await planLocal(paths,{includeResume})
    if(plan.setup)throw new Error('Select the source account first')
    if(plan.token!==token)throw new Error('The account or session list changed. Refresh and try again.')
    if(plan.moving){
      emit({stage:'close',text:'Closing Claude briefly'})
      await quitDesktop(paths)
      try{if(plan.recovery)await recoverLocal(paths);emit({stage:'move',text:`Moving ${plan.count} records`});await moveRecords(paths,plan)}
      finally{spawnSync('/usr/bin/open',['-a',paths.claudeApp],{encoding:'utf8'})}
    } else {
      const group=await collection(paths);group.resume=plan.resume;await atomic(path.join(paths.state,'local-workflow.json'),group)
    }
    const group=await collection(paths);group.lastResumeAt=new Date().toISOString();group.resume=plan.resume
    await atomic(path.join(paths.state,'local-workflow.json'),group)
    emit({done:true,ok:true,moved:plan.moving?plan.count:0,resume:plan.resume,target:plan.to})
  })
}
