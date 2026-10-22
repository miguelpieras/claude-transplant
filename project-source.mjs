import {createHash} from 'node:crypto'
import {lstat, readFile, readdir} from 'node:fs/promises'
import path from 'node:path'

const CHANNEL = /^chan_[A-Za-z0-9]+$/
const THREAD = /^cmsg_[A-Za-z0-9]+$/
const SESSION = /^(?:cse|session)_[A-Za-z0-9]+$/
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const FLAGS = ['channel','roots','coordinator','threads','memory','library','localTranscripts']
const SESSION_FIELDS = ['id','title','status','status_bucket','created_at','updated_at','last_event_at','last_event_id','environment_id','environment_kind','tags','parent_session_id','thread_root_id','channel_id','model','effort','task_summary']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item==='object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item)
const digest = value => hash(canonical(value??null))
const wire = id => id?.replace(/^cse_/, 'session_')
const token = value => typeof value==='string' && value!=='' ? value : undefined
const object = value => value!==null && typeof value==='object' && !Array.isArray(value)
const safePath = value => typeof value==='string' && value!=='' && !value.includes('\\') && !value.includes('\0') && !value.split('/').some(part=>part==='..'||part==='.')
const safeError = error => { const status=String(error?.message??'').match(/(?:returned|HTTP|status)\s+(\d{3})/i)?.[1]; return status?`HTTP ${status}`:error?.code && /^[A-Z_]+$/.test(error.code)?error.code:'read failed' }
const decodeBytes = value => {
  if(Buffer.isBuffer(value?.bytes)||value?.bytes instanceof Uint8Array)return Buffer.from(value.bytes)
  if(value?.type==='text'&&typeof value.content==='string')return Buffer.from(value.content)
  if(['content','download'].includes(value?.type)&&typeof value.data==='string'&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data))return Buffer.from(value.data,'base64')
  throw new Error('Output bytes are absent')
}
const safeMetadata = value => Object.fromEntries(SESSION_FIELDS.filter(key=>value?.[key]!==undefined && key!=='session_context').map(key=>[key,value[key]]))

function rootsOf(index) {
  if (!Array.isArray(index?.sections)) throw new Error('Thread index response changed')
  const roots = []
  for (const section of index.sections) {
    if (!Array.isArray(section.data)) throw new Error('Thread section response changed')
    for (const root of section.data) {
      if (!THREAD.test(root?.id??'') || (root.thread_root_id && root.thread_root_id!==root.id)) throw new Error('Thread root response changed')
      roots.push({...root, thread_status:root.thread_status??section.status})
    }
  }
  if (new Set(roots.map(row=>row.id)).size!==roots.length) throw new Error('Duplicate thread root')
  return roots
}
function indexComplete(index) {
  return index.truncated!==true && index.sections.every(section=>Number(section.count)===section.data.length)
}
function rootSignature(index) {
  return digest(rootsOf(index).map(root=>({id:root.id,replies:root.reply_count,lastReplyAt:root.last_reply_at,bindings:(root.bound_sessions??[]).map(row=>row.id).sort()})).sort((a,b)=>a.id.localeCompare(b.id)))
}
function titleOf(root) {
  if (typeof root.display_name==='string' && root.display_name.trim()) return root.display_name
  if (typeof root.title==='string' && root.title.trim()) return root.title
  const title = root.bound_sessions?.find(row=>typeof row.title==='string' && row.title.trim())?.title
  return title ?? root.id
}
async function regular(file) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Not a regular file')
  return readFile(file)
}
async function localRecords(paths, account, org) {
  if (!paths.records) return []
  const dir = path.join(paths.records,account,org)
  const entries = await readdir(dir,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT') return []; throw error})
  const out=[]
  for (const entry of entries) {
    if (!entry.isFile() || !/^local_[a-f0-9-]+\.json$/i.test(entry.name)) continue
    try { const value = JSON.parse((await regular(path.join(dir,entry.name))).toString('utf8')); if(object(value))out.push(value) } catch { /* Unrelated unreadable ownership rows do not establish a project binding. */ }
  }
  return out
}
async function localTranscript(paths,record) {
  const id = record.cliSessionId
  if (!UUID.test(id??'')) throw new Error('Local transcript ID is missing')
  const folders = new Set([record.cwd,record.originCwd].filter(value=>typeof value==='string'&&value))
  for (const cwd of folders) {
    const dir = cwd.replace(/[^A-Za-z0-9-]/g,'-')
    try { return {id,bytes:await regular(path.join(paths.pool,dir,`${id}.jsonl`))} }
    catch (error) { if(error.code!=='ENOENT') throw error }
  }
  throw new Error('Local transcript is missing')
}

export async function loadArtifactExports(directory,projectId) {
  const info=await lstat(directory)
  if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw new Error('Artifact export directory must be private')
  const manifest=JSON.parse((await regular(path.join(directory,'artifacts.json'))).toString('utf8'))
  if(manifest.schemaVersion!==1||manifest.projectId!==projectId||!Array.isArray(manifest.artifacts))throw new Error('Artifact exports do not match the selected project')
  const exports=new Map()
  for(const entry of manifest.artifacts){
    if(!UUID.test(entry.id??'')||entry.file!==`${entry.id}.txt`||entry.format!=='text'||!Number.isFinite(Date.parse(entry.updatedAt))||!/^[a-f0-9]{64}$/.test(entry.sha256??'')||exports.has(entry.id))throw new Error('Invalid artifact text export')
    const file=path.join(directory,entry.file),info=await lstat(file)
    if((info.mode&0o077)!==0)throw new Error('Artifact export files must be private')
    const bytes=await regular(file)
    if(!bytes.length||hash(bytes)!==entry.sha256)throw new Error('Artifact text export failed verification')
    exports.set(entry.id,{...entry,bytes})
  }
  return exports
}

export async function collectProject(client,paths,projectId,{report=()=>{},artifactExports=new Map()}={}) {
  if (!CHANNEL.test(projectId??'') || !UUID.test(client.account??'') || !UUID.test(client.org??'')) throw new Error('Verified source project, account, and organization are required')
  const base=`/v1/code/channels/${projectId}`
  const memoryBase=`/v1/code/memory/channel/${projectId}/memories`
  const capture={schemaVersion:1,source:{accountId:client.account,organizationId:client.org,projectId,title:'',capturedAt:new Date().toISOString()},channel:{},roots:{sections:[]},coordinator:{history:{data:[]},sessionEvents:[]},expectedThreadIds:[],threads:[],memoryFiles:[],libraryFiles:[],localTranscripts:[],complete:Object.fromEntries(FLAGS.map(flag=>[flag,true])),missing:[],limitations:[]}
  const miss=(flag,label,error)=>{capture.complete[flag]=false;capture.missing.push(`${flag}: ${label}${error?` (${safeError(error)})`:''}`)}
  const attempt=async(flag,label,fn,fallback)=>{try{return await fn()}catch(error){miss(flag,label,error);return fallback}}
  const request=(endpoint,options)=>client.projectRequest(endpoint,options)
  const post=(endpoint,body)=>request(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  const pages=async(endpoint,flag,label,{query={},field='data',cursorKey='cursor',nextKeys=['next_cursor','cursor','resume_cursor']}={})=>{
    const rows=[],seen=new Set();let cursor,first
    for(let i=0;i<500;i++) {
      const params=new URLSearchParams({...query,...cursor===undefined?{}:{[cursorKey]:cursor}})
      const response=await request(`${endpoint}?${params}`)
      if(!first) first=response
      if(!Array.isArray(response?.[field])) throw new Error('Page response changed')
      rows.push(...response[field])
      const next=nextKeys.map(key=>token(response[key])).find(Boolean)
      if(response.truncated===true && !next) miss(flag,`${label} is truncated`)
      if(!next) {
        if(response.has_more===true) miss(flag,`${label} has more rows without a cursor`)
        const result={...first,[field]:rows};for(const key of nextKeys)delete result[key];return result
      }
      if(seen.has(next)) throw new Error('Page cursor did not advance')
      seen.add(next);cursor=next
    }
    throw new Error('Page limit reached')
  }
  report('Reading project and thread list')
  const channelResponse=await attempt('channel','project metadata',()=>request(base),null)
  const channel=channelResponse?.channel
  if(channel&&channel.id!==projectId)throw new Error('Source project identity changed')
  if(!object(channel)||channel.id!==projectId||typeof channel.name!=='string') miss('channel','project identity is missing')
  capture.source.title=channel?.name??projectId
  const configResponse=await attempt('channel','project configuration',()=>request(`${base}/config`),null)
  if(!object(configResponse?.config)) miss('channel','project configuration is missing')
  capture.channel={...(channel??{}),config:configResponse?.config??{}}
  const initialIndex=await attempt('roots','thread index',()=>request(`${base}/threads?limit=100`),null)
  let roots=await attempt('roots','thread roots',async()=>rootsOf(initialIndex),[])
  if(initialIndex && !indexComplete(initialIndex)) miss('roots','thread index is truncated')
  capture.roots=initialIndex??{sections:[]}
  capture.expectedThreadIds=roots.map(row=>row.id)
  capture.coordinator.history=await attempt('coordinator','main conversation',()=>pages(`${base}/timeline`,'coordinator','main conversation',{query:{limit:'200',include_replies:'true',include_bound_session_rows:'true'}}),{data:[]})
  const sessionCache=new Map()
  const captureSession=async(id,flag)=>{
    if(!SESSION.test(id??'')){miss(flag,'bound session ID is invalid');return null}
    const key=wire(id)
    if(!sessionCache.has(key)) sessionCache.set(key,(async()=>{
      const response=await attempt(flag,`session ${id} metadata`,()=>client.session(id),null)
      const metadata=response?.session??response
      const events=await attempt(flag,`session ${id} events`,()=>client.eventRows(id),null)
      if(events!==null&&!Array.isArray(events)) miss(flag,`session ${id} events response changed`)
      return {id,metadata:safeMetadata(metadata),events:Array.isArray(events)?events:[],complete:metadata!==null&&Array.isArray(events)}
    })())
    const value=await sessionCache.get(key)
    if(!value.complete) miss(flag,`session ${id} is incomplete`)
    return value
  }
  const coordinatorIds=[...new Set([channel?.overview_session_id,channel?.channel_session_id].filter(Boolean))]
  if(!coordinatorIds.length) miss('coordinator','coordinator session ID is missing')
  for(const id of coordinatorIds){const value=await captureSession(id,'coordinator');if(value)capture.coordinator.sessionEvents.push(value)}
  const records=await attempt('localTranscripts','local session metadata',()=>localRecords(paths,client.account,client.org),[])
  for(const root of roots) {
    report(`Reading thread ${capture.threads.length+1} of ${roots.length}`)
    const bound=Array.isArray(root.bound_sessions)?root.bound_sessions:[]
    const thread={id:root.id,title:titleOf(root),status:root.thread_status??null,sessionId:bound[0]?.id??null,history:await attempt('threads',`thread ${root.id} history`,()=>pages(`${base}/threads/${root.id}`,'threads',`thread ${root.id}`,{query:{limit:'200'}}),{data:[]}),sessionEvents:[]}
    for(const binding of bound){const value=await captureSession(binding.id,'threads');if(value)thread.sessionEvents.push(value)}
    capture.threads.push(thread)
    for(const binding of bound) {
      const matched=records.filter(record=>[record.bridgeSessionId,...(Array.isArray(record.bridgeSessionIds)?record.bridgeSessionIds:[])].some(id=>wire(id)===wire(binding.id)))
      if(matched.length>1){miss('localTranscripts',`session ${binding.id} has multiple local records`);continue}
      if(matched.length===0)continue
      const record=matched[0]
      const transcript=await attempt('localTranscripts',`thread ${root.id} local transcript`,()=>localTranscript(paths,record),null)
      if(transcript)capture.localTranscripts.push({threadId:root.id,recordId:record.sessionId,sessionId:transcript.id,bytes:transcript.bytes})
    }
  }
  report('Reading project memory and library')
  const listMemories=async()=>{
    const all=[],prefixes=[''],visited=new Set()
    for(let n=0;n<prefixes.length;n++){
      if(n>=500)throw new Error('Memory prefix limit reached')
      const prefix=prefixes[n];if(visited.has(prefix))continue;visited.add(prefix)
      let page;const seen=new Set()
      for(let i=0;i<500;i++){
        const query=new URLSearchParams({limit:'100',...prefix?{path_prefix:prefix}:{},...page?{page}:{}})
        const value=await request(`${memoryBase}?${query}`)
        if(!Array.isArray(value?.data))throw new Error('Memory index response changed')
        all.push(...value.data)
        for(const item of value.prefixes??[]){const p=typeof item==='string'?item:item.path??item.prefix;if(typeof p!=='string')throw new Error('Memory prefix response changed');if(!visited.has(p))prefixes.push(p)}
        const next=token(value.next_page)
        if(!next)break
        if(seen.has(next)||i===499)throw new Error('Memory cursor did not advance')
        seen.add(next);page=next
      }
    }
    const unique=new Map()
    for(const row of all){if(typeof row.id!=='string'||typeof row.path!=='string')throw new Error('Memory entry response changed');const prior=unique.get(row.id);if(prior&&digest(prior)!==digest(row))throw new Error('Memory index changed');unique.set(row.id,row)}
    return [...unique.values()].sort((a,b)=>a.id.localeCompare(b.id))
  }
  const memoryIndex=await attempt('memory','memory index',listMemories,null)
  for(const entry of memoryIndex??[]) {
    if(!safePath(entry.path)){miss('memory','memory path is invalid');continue}
    const memory=await attempt('memory',`memory ${entry.id}`,()=>request(`${memoryBase}/${encodeURIComponent(entry.id)}`),null)
    if(typeof memory?.content!=='string'){miss('memory',`memory ${entry.id} content is absent`);continue}
    const bytes=Buffer.from(memory.content)
    if(typeof memory.content_sha256!=='string'||hash(bytes)!==memory.content_sha256||entry.content_sha256&&memory.content_sha256!==entry.content_sha256){miss('memory',`memory ${entry.id} hash changed`);continue}
    capture.memoryFiles.push({path:entry.path,bytes})
  }
  const listFiles=async()=>{
    const entries=[],seen=new Set();let cursor
    for(let i=0;i<500;i++){
      const value=await post(`${base}/files:list`,{path:'/',recursive:true,limit:500,...cursor?{cursor}:{}})
      if(!Array.isArray(value?.entries))throw new Error('Library file index response changed')
      entries.push(...value.entries)
      const next=token(value.cursor??value.next_cursor)
      if(!next){if(value.truncated===true)throw new Error('Library file index is truncated');return entries}
      if(seen.has(next))throw new Error('Library file cursor did not advance')
      seen.add(next);cursor=next
    }
    throw new Error('Library file page limit reached')
  }
  const readFileBytes=async(file)=>{
    let value=await post(`${base}/files:open`,{path:file})
    if(value?.type==='text'&&typeof value.content==='string'){const bytes=Buffer.from(value.content);if(value.size_bytes!==undefined&&Number(value.size_bytes)!==bytes.length)throw new Error('Library byte length changed');return {bytes,revision:value.content_revision}}
    if(value?.type==='download'&&typeof value.data==='string'){const bytes=Buffer.from(value.data,'base64');if(value.size_bytes!==undefined&&Number(value.size_bytes)!==bytes.length)throw new Error('Library byte length changed');return {bytes,revision:value.content_revision}}
    throw new Error('Library file cannot be read')
  }
  const libraryIndex=await attempt('library','project files index',listFiles,null)
  const fileRevisions=new Map()
  for(const entry of libraryIndex??[]){if(entry.is_directory===true)continue;const name=entry.path;if(!safePath(name)){miss('library','library path is invalid');continue}const value=await attempt('library',`file ${name}`,()=>readFileBytes(name),null);if(value){if(entry.size_bytes!==undefined&&Number(entry.size_bytes)!==value.bytes.length){miss('library',`file ${name} size changed`);continue}fileRevisions.set(name,value.revision);capture.libraryFiles.push({id:`file-${hash(name)}`,name:path.posix.basename(name),originalPath:name,bytes:value.bytes})}}
  const artifacts=await attempt('library','artifact index',()=>request(`${base}/artifacts?limit=50`),null)
  const attachments=await attempt('library','attachment index',()=>request(`${base}/attachments?limit=100`),null)
  capture.channel.libraryIndex={files:libraryIndex??[],artifacts,attachments}
  for(const [kind,index] of [['artifact',artifacts],['attachment',attachments]]) {
    if(!Array.isArray(index?.data)){miss('library',`${kind} index response changed`);continue}
    if(index.truncated===true||Number(index.total??index.data.length)>index.data.length)miss('library',`${kind} index is truncated`)
    for(const item of index.data){
      const id=kind==='attachment'?item.file_id:item.id??item.slug
      if(typeof id!=='string'||!/^[A-Za-z0-9_-]+$/.test(id)){miss('library',`${kind} ID is invalid`);continue}
      if(kind==='artifact'&&!item.id&&typeof client.projectArtifact!=='function'){miss('library',`artifact ${id} content route is not supported`);continue}
      const endpoint=kind==='attachment'?`${base}/attachments/${id}/content`:`${base}/attached_outputs/${id}`
      const value=await attempt('library',`${kind} ${id} bytes`,()=>kind==='artifact'&&typeof client.projectArtifact==='function'?client.projectArtifact(id):request(endpoint),null)
      if(kind==='artifact'&&value?.requiresContentExport){
        const exported=artifactExports.get(id)
        if(!exported||Date.parse(exported.updatedAt)!==Date.parse(value.metadata.updatedAt)||Date.parse(item.updated_at)!==Date.parse(value.metadata.updatedAt)){miss('library',`artifact ${id} needs a current text export (--artifact-exports)`);continue}
        capture.libraryFiles.push({id:`artifact-${id}-text`,name:`${id}.txt`,originalPath:`artifacts/${id}/report.txt`,bytes:exported.bytes,captureFormat:'text-and-links',nativeStateCaptured:false})
        ;(capture.channel.libraryIndex.artifactCaptures??=[]).push({id,metadata:{...value.metadata,captureFormat:'text-and-links',nativeStateCaptured:false,normalizedTextSha256:exported.normalizedTextSha256??null}})
        capture.limitations.push(`Artifact ${id} is captured as text and links. Native layout and widget state are not included.`)
        continue
      }
      if (kind==='artifact' && Array.isArray(value?.files) && value.files.length) {
        if(value.metadata)(capture.channel.libraryIndex.artifactCaptures??=[]).push({id,metadata:value.metadata})
        for(const file of value.files){if(!safePath(file.path)||!Buffer.isBuffer(file.bytes)){miss('library',`artifact ${id} file is invalid`);continue}capture.libraryFiles.push({id:`artifact-${id}-${hash(file.path)}`,name:path.posix.basename(file.path),originalPath:`artifacts/${id}/${file.path}`,bytes:file.bytes})}
        continue
      }
      const bytes=await attempt('library',`${kind} ${id} content`,async()=>decodeBytes(value),null)
      if(!bytes)continue
      if(item.size_bytes!==undefined&&Number(item.size_bytes)!==bytes.length){miss('library',`${kind} ${id} size changed`);continue}
      if(value?.metadata){(capture.channel.libraryIndex.artifactCaptures??=[]).push({id,metadata:value.metadata})}
      capture.libraryFiles.push({id:`${kind}-${id}`,name:item.filename??item.title??id,bytes})
    }
  }
  const outputs=new Map()
  const findOutputs=value=>{if(!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value)){if(key==='attached_outputs'&&Array.isArray(item)){for(const output of item){if(output?.kind==='link')continue;const id=typeof output==='string'?output:output?.id??output?.attached_output_id??output?.artifact_id;if(typeof id==='string'&&/^[A-Za-z0-9_.-]+$/.test(id)&&!id.includes('..'))outputs.set(id,output);else miss('library','attached output ID is missing')}}else findOutputs(item)}}
  findOutputs(capture.roots);findOutputs(capture.coordinator);for(const thread of capture.threads)findOutputs(thread)
  capture.channel.libraryIndex.attachedOutputs=[...outputs.values()]
  for(const [id,metadata] of outputs){if(capture.libraryFiles.some(file=>file.id===`artifact-${id}`||metadata?.kind==='frame'&&file.id.startsWith(`artifact-${metadata.frame_slug}-`)))continue;const value=await attempt('library',`attached output ${id}`,()=>request(`${base}/attached_outputs/${id}`),null);const bytes=await attempt('library',`attached output ${id} bytes`,async()=>decodeBytes(value),null);if(bytes)capture.libraryFiles.push({id:`output-${id}`,name:typeof metadata==='object'?(metadata.filename??metadata.title??id):id,bytes})}
  report('Checking source consistency')
  const finalIndex=await attempt('roots','final thread index',()=>request(`${base}/threads?limit=100`),null)
  if(finalIndex&&initialIndex){const stable=await attempt('roots','thread index consistency',async()=>rootSignature(initialIndex)===rootSignature(finalIndex),false);if(!stable){miss('roots','thread list changed during capture');miss('threads','thread history changed during capture');miss('coordinator','project messages can have changed during capture')}}
  const timelineRead=()=>pages(`${base}/timeline`,'coordinator','main conversation',{query:{limit:'200',include_replies:'true',include_bound_session_rows:'true'}})
  const finalTimeline=await attempt('coordinator','final main conversation',timelineRead,null)
  const timelineSignature=value=>digest(value.data.map(row=>({id:row.id,seq:row.seq,body:row.body,attachments:row.attachments,attached_outputs:row.attached_outputs,thread_root_id:row.thread_root_id})))
  if(finalTimeline&&timelineSignature(finalTimeline)!==timelineSignature(capture.coordinator.history)){capture.coordinator.history=finalTimeline;const checked=await attempt('coordinator','main conversation retry',timelineRead,null);if(!checked||timelineSignature(checked)!==timelineSignature(finalTimeline))miss('coordinator','main conversation changed during capture')}
  for(const [key,promise] of sessionCache){const saved=await promise;const flag=coordinatorIds.some(id=>wire(id)===key)?'coordinator':'threads';const readMetadata=async()=>{const value=await client.session(saved.id);return safeMetadata(value?.session??value)};const final=await attempt(flag,`session ${saved.id} final metadata`,readMetadata,null);const stamp=value=>({last_event_at:value?.last_event_at,last_event_id:value?.last_event_id});if(final&&digest(stamp(final))!==digest(stamp(saved.metadata))){const events=await attempt(flag,`session ${saved.id} event retry`,()=>client.eventRows(saved.id),null);const checked=await attempt(flag,`session ${saved.id} metadata retry`,readMetadata,null);if(Array.isArray(events)&&checked&&digest(stamp(checked))===digest(stamp(final))){saved.metadata=checked;saved.events=events}else miss(flag,`session ${saved.id} changed during capture`)}}
  const finalConfig=await attempt('channel','final project configuration',()=>request(`${base}/config`),null)
  if(finalConfig&&digest(finalConfig.config)!==digest(configResponse?.config))miss('channel','project configuration changed during capture')
  const finalMemory=await attempt('memory','final memory index',listMemories,null)
  if(memoryIndex&&finalMemory&&digest(memoryIndex)!==digest(finalMemory))miss('memory','memory changed during capture')
  const finalLibrary=await attempt('library','final project files index',listFiles,null)
  if(libraryIndex&&finalLibrary&&digest(libraryIndex)!==digest(finalLibrary))miss('library','project files changed during capture')
  for(const [file,revision] of fileRevisions){if(revision===undefined)continue;const value=await attempt('library',`file ${file} final revision`,()=>post(`${base}/files:open`,{path:file,range_offset:0,range_length:1}),null);if(value&&value.content_revision!==revision)miss('library',`file ${file} revision changed during capture`)}
  capture.source.capturedAt=new Date().toISOString()
  return capture
}
