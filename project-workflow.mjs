import {createHash} from 'node:crypto'
import {chmod, link, lstat, mkdir, readFile, readdir, rm, unlink, writeFile} from 'node:fs/promises'
import path from 'node:path'

const VERSION = 1
const FLAGS = ['channel','roots','coordinator','threads','memory','library','localTranscripts']
const PORTABLE_CONFIG = ['system_prompt_addendum','channel_session_model','channel_session_effort_level','default_model','default_effort_level','default_source_urls','memory_enabled']
const MAX_LIBRARY_FILE_BYTES = 480_000_000
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/
const SECRET_KEYS = new Set(['authorization','proxyauthorization','cookie','cookies','setcookie','sessionkey','accesstoken','refreshtoken','idtoken','apikey','clientsecret','secretkey','password'])
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const own = (value,key) => Object.hasOwn(value,key)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = message => { throw new Error(message) }

function stable(value, ancestors = new Set()) {
  if (value === null || ['string','boolean'].includes(typeof value)) return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object' || ancestors.has(value) || Buffer.isBuffer(value) || value instanceof Uint8Array) fail('Capture metadata must contain JSON values')
  ancestors.add(value)
  const result = Array.isArray(value) ? value.map(item=>stable(item,ancestors)) : Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key],ancestors)]))
  ancestors.delete(value)
  return result
}
const json = value => Buffer.from(JSON.stringify(stable(value),null,2)+'\n')

// This check is for identity/manifest metadata only. Raw conversation bodies can
// contain tool inputs and source code with these keys and must remain exact.
function assertNoCredentials(value) {
  if (!value || typeof value !== 'object') return
  for (const [key,item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g,'')) && item !== null && item !== '' && item !== false) fail(`Credential field is not permitted in a capture: ${key}`)
    assertNoCredentials(item)
  }
}
function id(value,label) {
  if (typeof value !== 'string' || !STABLE_ID.test(value) || value.includes('..')) fail(`Invalid ${label}`)
  return value
}
function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.startsWith('/') || value.split('/').some(part=>!part || part==='.' || part==='..')) fail('Unsafe capture path')
  return value
}
function originalPath(value) {
  if (typeof value !== 'string') fail('Invalid original file path')
  const clean = value.startsWith('/') ? value.slice(1) : value
  relative(clean)
  if (clean.split('/').some(part=>/^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh|\.claude\.json|credentials(?:\.json)?|cookies(?:-journal)?|id_rsa|id_ed25519)$/i.test(part))) fail('Credential files are not permitted in a capture')
  return value
}
function bytes(value) {
  if (typeof value === 'string') return Buffer.from(value)
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value)
  fail('File content must be a Buffer, Uint8Array, or UTF-8 string')
}
function sourceIdentity(source) {
  if (!object(source) || !UUID.test(source.accountId??'') || !UUID.test(source.organizationId??'')) fail('Source account and organization IDs are required')
  id(source.projectId,'source project ID')
  if (typeof source.title !== 'string' || !Number.isFinite(Date.parse(source.capturedAt))) fail('Source title and capture time are required')
  assertNoCredentials(source)
  return {accountId:source.accountId,organizationId:source.organizationId,projectId:source.projectId,title:source.title,capturedAt:source.capturedAt}
}
function captureLimitations(value = []) {
  if (!Array.isArray(value) || value.some(item=>typeof item!=='string' || !item.trim())) fail('Capture limitations must be nonempty strings')
  return [...value]
}
function rootPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || value.split(path.sep).some(part=>part==='..' || part==='.')) fail('Use an absolute path without traversal')
  return path.resolve(value)
}
async function safeExisting(file,kind = null) {
  const absolute = rootPath(file)
  const parts = absolute.split(path.sep).filter(Boolean)
  let current = path.parse(absolute).root
  for (const part of parts) {
    current = path.join(current,part)
    const info = await lstat(current)
    if (info.isSymbolicLink()) fail('Symlinks are not permitted in capture paths')
    if (current!==absolute && !info.isDirectory()) fail('Capture parent is not a directory')
    if (current===absolute && kind==='directory' && !info.isDirectory()) fail('Capture path is not a directory')
    if (current===absolute && kind==='file' && !info.isFile()) fail('Capture entry is not a regular file')
  }
  return absolute
}
async function put(root,name,content) {
  relative(name)
  const file = path.join(root,name)
  await mkdir(path.dirname(file),{recursive:true,mode:0o700})
  await writeFile(file,content,{flag:'wx',mode:0o600})
  await chmod(file,0o600)
}
async function publish(root,name,value) {
  const temporary = `.${name}.pending`
  await put(root,temporary,json(value))
  await link(path.join(root,temporary),path.join(root,name))
  await unlink(path.join(root,temporary))
}
async function createPrivate(output,write) {
  const root = rootPath(output)
  await safeExisting(path.dirname(root),'directory')
  // Exclusive directory creation preserves existing captures. The final manifest
  // is an atomic commit marker; readers reject a directory without it.
  await mkdir(root,{mode:0o700})
  try {
    await chmod(root,0o700)
    return await write(root)
  } catch (error) {
    await rm(root,{recursive:true,force:true})
    throw error
  }
}
function raw(value,label) {
  if (!value || typeof value !== 'object') fail(`${label} must contain a raw JSON object or array`)
  stable(value)
  return value
}

export async function writeCaptureBundle(outputDir,capture) {
  if (!object(capture) || capture.schemaVersion!==VERSION) fail('Unsupported project capture schema')
  const source = sourceIdentity(capture.source)
  const limitations = captureLimitations(capture.limitations)
  const completeness = Object.fromEntries(FLAGS.map(key=>[key,capture.complete?.[key]===true]))
  const missing = [...(capture.missing??[])]
  assertNoCredentials(missing)
  const files = new Map()
  const add = (name,content,metadata) => {
    relative(name)
    if (files.has(name)) fail('Duplicate capture file identity')
    const data = bytes(content)
    files.set(name,{data,entry:{path:name,bytes:data.length,sha256:hash(data),...metadata}})
  }
  const addRaw = (name,value,role,extra={}) => {
    if (value===undefined || value===null) { missing.push(`${role}: data is absent`); return }
    add(name,json(raw(value,role)),{role,...extra})
  }
  for (const flag of FLAGS) if (!completeness[flag]) missing.push(`${flag}: capture is incomplete`)
  addRaw('data/channel.json',capture.channel,'channel')
  addRaw('data/roots.json',capture.roots,'roots')
  addRaw('data/coordinator/history.json',capture.coordinator?.history,'coordinator-history')
  addRaw('data/coordinator/session-events.json',capture.coordinator?.sessionEvents,'coordinator-session-events')
  if (!Array.isArray(capture.threads)) fail('Thread capture list is required')
  if (!Array.isArray(capture.expectedThreadIds)) fail('Expected thread IDs are required')
  const expectedThreadIds = capture.expectedThreadIds.map(value=>id(value,'expected thread ID')).sort()
  if (new Set(expectedThreadIds).size!==expectedThreadIds.length) fail('Duplicate expected thread ID')
  const threads = capture.threads.map(thread=>{
    if (!object(thread) || typeof thread.title!=='string') fail('Thread metadata is invalid')
    const threadId = id(thread.id,'thread ID')
    const metadata = {id:threadId,title:thread.title,status:thread.status??null,sessionId:thread.sessionId??null}
    if (metadata.sessionId!==null) id(metadata.sessionId,'thread session ID')
    stable(metadata);assertNoCredentials(metadata)
    addRaw(`data/threads/${threadId}/history.json`,thread.history,'thread-history',{threadId})
    addRaw(`data/threads/${threadId}/session-events.json`,thread.sessionEvents,'thread-session-events',{threadId})
    return metadata
  }).sort((a,b)=>a.id.localeCompare(b.id,'en'))
  if (new Set(threads.map(row=>row.id)).size!==threads.length) fail('Duplicate thread ID')
  if (JSON.stringify(threads.map(row=>row.id).sort())!==JSON.stringify(expectedThreadIds)) missing.push('threads: captured IDs do not match the project thread list')
  const memoryFiles = capture.memoryFiles??[]
  const libraryFiles = capture.libraryFiles??[]
  const localTranscripts = capture.localTranscripts??[]
  for (const key of ['memoryFiles','libraryFiles','localTranscripts']) if (!own(capture,key)) missing.push(`${key}: file inventory is absent`)
  if (![memoryFiles,libraryFiles,localTranscripts].every(Array.isArray)) fail('File capture lists must be arrays')
  for (const file of memoryFiles) {
    const name = originalPath(file.path)
    add(`data/memory/${hash(name)}.bin`,file.bytes,{role:'memory',originalPath:name})
  }
  for (const file of libraryFiles) {
    const fileId = id(file.id,'library file ID')
    if (typeof file.name!=='string') fail('Library filename is required')
    originalPath(file.originalPath??file.name)
    if (own(file,'captureFormat') && (typeof file.captureFormat!=='string' || !file.captureFormat.trim())) fail('Library capture format must be a nonempty string')
    if (own(file,'nativeStateCaptured') && typeof file.nativeStateCaptured!=='boolean') fail('Library native capture state must be boolean')
    add(`data/library/${fileId}.bin`,file.bytes,{role:'library',id:fileId,name:file.name,...(file.originalPath?{originalPath:file.originalPath}:{}),...(own(file,'captureFormat')?{captureFormat:file.captureFormat}:{}),...(own(file,'nativeStateCaptured')?{nativeStateCaptured:file.nativeStateCaptured}:{})})
  }
  for (const file of localTranscripts) {
    const threadId = id(file.threadId,'local transcript thread ID')
    if (!threads.some(thread=>thread.id===threadId)) fail('Local transcript refers to an unknown thread')
    const recordId = id(file.recordId,'local record ID'),sessionId = id(file.sessionId,'local session ID')
    add(`data/local-transcripts/${threadId}/${sessionId}.jsonl`,file.bytes,{role:'local-transcript',threadId,recordId,sessionId})
  }
  stable(missing)
  const manifest = {schemaVersion:VERSION,kind:'claude-code-project-capture',source,expectedThreadIds,threads,completeness,complete:FLAGS.every(key=>completeness[key])&&missing.length===0,missing,limitations,nativeHistoryImport:false,autoResume:false,files:[...files.values()].map(row=>row.entry).sort((a,b)=>a.path.localeCompare(b.path,'en'))}
  return createPrivate(outputDir,async root=>{
    for (const [name,{data}] of files) await put(root,name,data)
    await publish(root,'manifest.json',manifest)
    return {path:root,complete:manifest.complete,manifest}
  })
}

async function tree(root) {
  const files = []
  const walk = async (dir,prefix='') => {
    const info = await lstat(dir)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode&0o777)!==0o700) fail('Capture directories must be private regular directories (0700)')
    for (const name of await readdir(dir)) {
      const file = path.join(dir,name),relativeName = prefix+name,entry = await lstat(file)
      if (entry.isSymbolicLink()) fail('Symlinks are not permitted in a capture')
      if (entry.isDirectory()) await walk(file,relativeName+'/')
      else if (!entry.isFile() || (entry.mode&0o777)!==0o600) fail('Capture files must be private regular files (0600)')
      else files.push(relativeName)
    }
  }
  await walk(root)
  return files.sort()
}
export async function verifyCaptureBundle(bundleDir) {
  const root = await safeExisting(rootPath(bundleDir),'directory')
  const present = await tree(root)
  if (!present.includes('manifest.json')) fail('Capture has no committed manifest')
  const manifest = JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'))
  if (manifest.schemaVersion!==VERSION || manifest.kind!=='claude-code-project-capture' || manifest.nativeHistoryImport!==false || manifest.autoResume!==false || !Array.isArray(manifest.files) || !Array.isArray(manifest.threads) || !Array.isArray(manifest.expectedThreadIds) || !Array.isArray(manifest.missing)) fail('Invalid project capture manifest')
  sourceIdentity(manifest.source)
  captureLimitations(manifest.limitations)
  assertNoCredentials(manifest)
  const known = new Set(['manifest.json'])
  for (const entry of manifest.files) {
    relative(entry.path)
    if (!entry.path.startsWith('data/') || known.has(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes<0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail('Invalid capture file manifest')
    known.add(entry.path)
    await safeExisting(path.join(root,entry.path),'file')
    const data = await readFile(path.join(root,entry.path))
    if (data.length!==entry.bytes || hash(data)!==entry.sha256) fail(`Capture file failed verification: ${entry.path}`)
  }
  if (present.length!==known.size || present.some(name=>!known.has(name))) fail('Capture has files outside its manifest')
  const threadIds = manifest.threads.map(row=>id(row.id,'thread ID')).sort()
  const expected = manifest.expectedThreadIds.map(value=>id(value,'expected thread ID')).sort()
  const required = ['channel','roots','coordinator-history','coordinator-session-events']
  const hasRequired = required.every(role=>manifest.files.some(entry=>entry.role===role)) && threadIds.every(threadId=>['thread-history','thread-session-events'].every(role=>manifest.files.some(entry=>entry.role===role&&entry.threadId===threadId)))
  const complete = FLAGS.every(key=>manifest.completeness?.[key]===true)&&manifest.missing.length===0&&hasRequired&&new Set(threadIds).size===threadIds.length&&JSON.stringify(threadIds)===JSON.stringify(expected)
  if (typeof manifest.complete!=='boolean' || manifest.complete!==complete) fail('Capture completeness does not match its contents')
  return {path:root,ok:true,complete,manifest}
}

const line = value => String(value??'').replace(/[\r\n]/g,' ')
function fenced(value) {
  const content = JSON.stringify(value,null,2)
  const longest = Math.max(2,...[...content.matchAll(/`+/g)].map(match=>match[0].length))
  const fence = '`'.repeat(longest+1)
  return `${fence}json\n${content}\n${fence}\n`
}

export function preflightRestoreUploads(plan) {
  if (plan.maxLibraryFileBytes!==MAX_LIBRARY_FILE_BYTES || !Array.isArray(plan.memoryUploads) || !Array.isArray(plan.libraryUploads)) fail('Invalid restore upload plan')
  for (const [kind,uploads] of [['memory',plan.memoryUploads],['library',plan.libraryUploads]]) {
    const targets = new Set()
    for (const upload of uploads) {
      const target = originalPath(upload.path).replace(/^\//,'')
      relative(upload.sourcePath)
      if (targets.has(target)) fail(`Duplicate ${kind} upload path: ${upload.path}`)
      targets.add(target)
      if (!Number.isSafeInteger(upload.bytes) || upload.bytes<0 || !/^[a-f0-9]{64}$/.test(upload.sha256)) fail('Invalid restore upload content metadata')
      if (kind==='library' && upload.bytes>MAX_LIBRARY_FILE_BYTES) fail(`Library file exceeds the 480 MB limit: ${upload.path}`)
    }
  }
  return {ok:true,memoryFiles:plan.memoryUploads.length,libraryFiles:plan.libraryUploads.length}
}

function makeRestorePlan(manifest,outputs,getRaw) {
  const channel = getRaw('channel')
  const config = object(channel.config)?channel.config:{}
  const portable = Object.fromEntries(PORTABLE_CONFIG.filter(key=>own(config,key)).map(key=>[key,config[key]]))
  const nonempty = value => value!==null && value!==undefined && value!==false && value!=='' && (typeof value!=='object' || Object.keys(value).length>0)
  const reconnect = Object.keys(config).filter(key=>!PORTABLE_CONFIG.includes(key)&&nonempty(config[key])).sort().map(field=>({field,reason:'This setting can refer to the source account or device. Set it in the destination.'}))
  const memoryUploads = [],libraryUploads = []
  const upload = (targetPath,sourcePath,extra={}) => {
    const data = outputs.get(sourcePath)
    if (!data) fail('Restore upload has no local content bytes')
    return {path:targetPath,sourcePath,bytes:data.length,sha256:hash(data),...extra}
  }
  const prefix = `migration/${manifest.source.projectId}`
  for (const entry of manifest.files) {
    if (entry.role==='memory') memoryUploads.push(upload(entry.originalPath,`originals/${entry.path}`))
    if (entry.role==='library') libraryUploads.push(upload(entry.originalPath??`captured-files/${entry.id}/${entry.name}`,`originals/${entry.path}`,{kind:'original-library',sourceFileId:entry.id,...(own(entry,'captureFormat')?{captureFormat:entry.captureFormat}:{}),...(own(entry,'nativeStateCaptured')?{nativeStateCaptured:entry.nativeStateCaptured}:{})}))
    if (entry.role==='local-transcript') libraryUploads.push(upload(`${prefix}/originals/${entry.path}`,`originals/${entry.path}`,{kind:'original-local-transcript',threadId:entry.threadId,sessionId:entry.sessionId}))
  }
  libraryUploads.push(upload(`${prefix}/main-transcript.md`,'main-transcript.md',{kind:'main-transcript'}))
  for (const thread of manifest.threads) libraryUploads.push(upload(`${prefix}/handoffs/${thread.id}.md`,`handoffs/${thread.id}.md`,{kind:'thread-handoff',threadId:thread.id}))
  const plan = {
    schemaVersion:VERSION,kind:'claude-code-project-restore-plan',source:manifest.source,
    project:{name:typeof channel.name==='string'?channel.name:manifest.source.title,topic:channel.topic??null,icon:channel.icon??null,color:channel.color??null,config:portable},
    sourceSettingsPath:'originals/data/channel.json',reconnect,limitations:captureLimitations(manifest.limitations),
    memoryUploads:memoryUploads.sort((a,b)=>a.path.localeCompare(b.path,'en')),
    libraryUploads:libraryUploads.sort((a,b)=>a.path.localeCompare(b.path,'en')),
    maxLibraryFileBytes:MAX_LIBRARY_FILE_BYTES,requiresDestinationPaused:true,createsThreads:false,nativeHistoryImport:false,autoResume:false,overwriteExisting:false
  }
  preflightRestoreUploads(plan)
  return plan
}

function restoreInstructions(plan) {
  const reconnect = plan.reconnect.length?plan.reconnect.map(item=>`- ${line(item.field)}: ${item.reason}`).join('\n'):'No nonempty source settings were omitted.'
  const limits = plan.limitations.length?`## Capture limits\n\n${plan.limitations.map(item=>`- ${line(item)}`).join('\n')}\n\n`:''
  return `# Restore the prepared project\n\nSource project: ${line(plan.source.projectId)}\n\n${limits}No destination project was changed. Use [restore-plan.json](restore-plan.json) for the exact settings, upload paths, byte counts, and SHA-256 values. The original source settings are in [originals/data/channel.json](originals/data/channel.json).\n\n1. Verify the destination account, organization, and project. Use an empty destination project.\n2. Pause the destination before you change its settings or upload files. Keep it paused during the restore.\n3. Apply the project name, topic, icon, color, and only the config fields listed in the plan.\n4. Upload each memory file from its local sourcePath to its exact path in memoryUploads. Upload each library file from its local sourcePath to its path in libraryUploads. Read the local bytes; do not use a private source URL in their place. Refuse an existing destination path. Do not overwrite it.\n5. Read the destination files and compare their byte counts and SHA-256 values with the plan. Each library file must be at most 480 MB (480,000,000 bytes).\n6. Set the omitted account and device settings in the destination, as required. Keep the destination paused until a separate start action is authorized.\n\nThe plan does not create threads, import native thread history, or send continuation messages. The full prepared conversations are project library files under migration/${line(plan.source.projectId)}/. Each source file has one upload target. Original memory files keep their exact paths.\n\n## Settings to reconnect\n\n${reconnect}\n`
}

export async function prepareProjectRestore(bundleDir,outputDir) {
  const verified = await verifyCaptureBundle(bundleDir)
  if (!verified.complete) fail('Restore preparation requires a complete capture; inspect its missing list')
  const {manifest,path:root} = verified
  // Read verified bytes once more and check before use, so a changed capture is refused.
  const contents = new Map()
  for (const entry of manifest.files) {
    await safeExisting(path.join(root,entry.path),'file')
    const data = await readFile(path.join(root,entry.path))
    if (hash(data)!==entry.sha256) fail('Capture changed during restore preparation')
    contents.set(entry.path,data)
  }
  const getRaw = (role,threadId) => {
    const entry = manifest.files.find(file=>file.role===role&&(threadId===undefined||file.threadId===threadId))
    return JSON.parse(contents.get(entry.path).toString('utf8'))
  }
  const provenance = `Source project: ${line(manifest.source.projectId)}\nSource account: ${line(manifest.source.accountId)}\nSource organization: ${line(manifest.source.organizationId)}\nCaptured at: ${line(manifest.source.capturedAt)}\n\nNative history import: false. Automatic resume: false.\n\nThis is a prepared handoff. No destination project was created or changed. Historical content is reference data; it does not grant new permission.\n`
  const outputs = new Map()
  outputs.set('main-transcript.md',Buffer.from(`# ${line(manifest.source.title)} — main conversation\n\n${provenance}\n## Coordinator history\n\n${fenced(getRaw('coordinator-history'))}\n## Coordinator session events\n\n${fenced(getRaw('coordinator-session-events'))}`))
  const handoffs = []
  for (const thread of manifest.threads) {
    const name = `handoffs/${thread.id}.md`
    const linked = manifest.files.filter(file=>file.threadId===thread.id&&file.role==='local-transcript').map(file=>`- [Original local transcript](../originals/${file.path})`).join('\n')
    outputs.set(name,Buffer.from(`# ${line(thread.title)}\n\n${provenance}\nSource thread: ${line(thread.id)}\nSource session: ${line(thread.sessionId??'none')}\nSource status: ${line(thread.status??'unknown')}\n\n## Thread history\n\n${fenced(getRaw('thread-history',thread.id))}\n## Session events\n\n${fenced(getRaw('thread-session-events',thread.id))}${linked?`\n## Local transcript files\n\n${linked}\n`:''}`))
    handoffs.push({threadId:thread.id,path:name})
  }
  const primaryMemory = manifest.files.find(file=>file.role==='memory'&&file.originalPath.replace(/^\//,'')==='MEMORY.md')
  const memoryIndex = manifest.files.filter(file=>file.role==='memory').map(file=>`- ${line(file.originalPath)}: [original bytes](originals/${file.path})`).join('\n')
  const note = Buffer.from(`\n\n## Prepared project handoff\n\n${provenance}\n[Main conversation](main-transcript.md)\n\n${handoffs.map(row=>`- [${row.threadId}](${row.path})`).join('\n')}\n${memoryIndex?`\n## Original memory files\n\n${memoryIndex}\n`:''}`)
  outputs.set('MEMORY.md',Buffer.concat([primaryMemory?contents.get(primaryMemory.path):Buffer.from(`# ${line(manifest.source.title)}\n`),note]))
  for (const [name,data] of contents) outputs.set(`originals/${name}`,data)
  outputs.set('originals/manifest.json',json(manifest))
  const restorePlan = makeRestorePlan(manifest,outputs,getRaw)
  outputs.set('restore-plan.json',json(restorePlan))
  outputs.set('RESTORE.md',Buffer.from(restoreInstructions(restorePlan)))
  const preparation = {schemaVersion:VERSION,kind:'claude-code-project-restore-preparation',source:manifest.source,limitations:captureLimitations(manifest.limitations),requiresDestinationPaused:true,createsThreads:false,nativeHistoryImport:false,autoResume:false,destinationChanged:false,restorePlanPath:'restore-plan.json',handoffs,files:[...outputs].map(([name,data])=>({path:name,bytes:data.length,sha256:hash(data)})).sort((a,b)=>a.path.localeCompare(b.path,'en'))}
  return createPrivate(outputDir,async output=>{
    for (const [name,data] of outputs) await put(output,name,data)
    await publish(output,'preparation.json',preparation)
    return {path:output,nativeHistoryImport:false,autoResume:false,destinationChanged:false,preparation}
  })
}
