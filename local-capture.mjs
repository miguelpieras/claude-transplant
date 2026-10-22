import {createHash} from 'node:crypto'
import {constants} from 'node:fs'
import {lstat,mkdir,open,readFile,readdir,writeFile} from 'node:fs/promises'
import path from 'node:path'

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const RECORD=/^local_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/i
const HASH=/^[a-f0-9]{64}$/
const sha=value=>createHash('sha256').update(value).digest('hex')
const same=(a,b)=>a?.account===b?.account&&a?.org===b?.org
const fail=message=>{throw new Error(message)}
const validSource=value=>UUID.test(value?.account??'')&&UUID.test(value?.org??'')
function relative(value){if(typeof value!=='string'||!value||value.startsWith('/')||value.includes('\\')||value.includes('\0')||value.split('/').some(part=>!part||part==='.'||part==='..'))fail('Invalid local capture path');return value}
async function safe(file,kind,{privateMode=false}={}){
  if(typeof file!=='string'||!path.isAbsolute(file)||file.split(path.sep).some(part=>part==='.'||part==='..'))fail('Use an absolute local capture path')
  const resolved=path.resolve(file);let current=path.parse(resolved).root
  for(const part of resolved.split(path.sep).filter(Boolean)){
    current=path.join(current,part);const info=await lstat(current)
    if(info.isSymbolicLink()||current!==resolved&&!info.isDirectory())fail('Local capture paths must not contain symlinks')
    if(current===resolved&&((kind==='file'?!info.isFile():!info.isDirectory())||privateMode&&(info.mode&0o777)!==(kind==='file'?0o600:0o700)))fail('Local capture files and directories must be private and regular')
  }
  return resolved
}
const optional=async file=>{try{return await lstat(file)}catch(error){if(error.code==='ENOENT')return null;throw error}}
async function fileDigest(file,copyTo=null){
  await safe(file,'file')
  const input=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW)
  let output
  try{
    const before=await input.stat({bigint:true})
    if(!before.isFile()||before.size>BigInt(Number.MAX_SAFE_INTEGER))fail('Invalid local source file')
    if(copyTo)output=await open(copyTo,'wx',0o600)
    const digest=createHash('sha256'),buffer=Buffer.allocUnsafe(128*1024),size=Number(before.size)
    let position=0
    while(position<size){
      const {bytesRead}=await input.read(buffer,0,Math.min(buffer.length,size-position),position)
      if(!bytesRead)fail('A local file changed during capture')
      const chunk=buffer.subarray(0,bytesRead);digest.update(chunk)
      if(output){let offset=0;while(offset<bytesRead){const result=await output.write(chunk,offset,bytesRead-offset,position+offset);if(!result.bytesWritten)fail('The local capture write did not finish');offset+=result.bytesWritten}}
      position+=bytesRead
    }
    const after=await input.stat({bigint:true})
    if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs)fail('A local file changed during capture')
    if(output)await output.sync()
    return{bytes:size,sha256:digest.digest('hex')}
  }finally{await output?.close();await input.close()}
}
async function sourceFiles(paths,source){
  if(!validSource(source)||!path.isAbsolute(paths.records??'')||!path.isAbsolute(paths.pool??'')||!path.isAbsolute(paths.state??''))fail('A verified local source account and paths are required')
  const collectionPath=path.join(paths.state,'local-workflow.json')
  await safe(collectionPath,'file')
  const group=JSON.parse(await readFile(collectionPath,'utf8'))
  if(group.version!==1||!same(group.current,source))fail('The local conversation source changed before capture')
  const namespace=path.join(paths.records,source.account,source.org);await safe(namespace,'directory')
  const preserve=group.preserve?.[`${source.account}/${source.org}`]??[]
  if(!Array.isArray(preserve))fail('Invalid local conversation collection')
  const names=(await readdir(namespace)).filter(name=>RECORD.test(name)&&!preserve.includes(name)).sort()
  const files=[{path:'data/collection.json',sourcePath:collectionPath,role:'collection'}],records=[],sessions=new Set()
  for(const name of names){
    const sourcePath=path.join(namespace,name);await safe(sourcePath,'file')
    const record=JSON.parse(await readFile(sourcePath,'utf8'))
    if(record.sessionId!==name.slice(0,-5)||record.cliSessionId!==null&&record.cliSessionId!==undefined&&!UUID.test(record.cliSessionId))fail('Invalid local conversation identity')
    const entry={name,path:`data/records/${name}`,sessionId:record.sessionId,cliSessionId:record.cliSessionId??null}
    records.push(entry);files.push({path:entry.path,sourcePath,role:'record'})
    if(entry.cliSessionId)sessions.add(entry.cliSessionId)
  }
  const registry=path.join(namespace,'scheduled-tasks.json')
  if(await optional(registry)){await safe(registry,'file');files.push({path:'data/scheduled-tasks.json',sourcePath:registry,role:'scheduled-tasks'})}
  const walk=async(directory,prefix)=>{
    await safe(directory,'directory')
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const sourcePath=path.join(directory,entry.name),target=`${prefix}/${entry.name}`;relative(target)
      if(entry.isSymbolicLink())fail('Local session history must not contain symlinks')
      if(entry.isDirectory())await walk(sourcePath,target)
      else if(entry.isFile())files.push({path:target,sourcePath,role:'sidecar'})
      else fail('Local session history must contain only regular files')
    }
  }
  if(await optional(paths.pool)){
    await safe(paths.pool,'directory')
    for(const folder of await readdir(paths.pool,{withFileTypes:true})){
      if(!folder.isDirectory())continue
      const directory=path.join(paths.pool,folder.name)
      for(const entry of await readdir(directory,{withFileTypes:true})){
        const id=entry.name.endsWith('.jsonl')?entry.name.slice(0,-6):entry.name
        if(!sessions.has(id))continue
        const sourcePath=path.join(directory,entry.name),target=`data/history/${folder.name}/${entry.name}`;relative(target)
        if(entry.isSymbolicLink())fail('Local session history must not contain symlinks')
        if(entry.name===`${id}.jsonl`){await safe(sourcePath,'file');files.push({path:target,sourcePath,role:'transcript'})}
        else if(entry.name===id)await walk(sourcePath,target)
      }
    }
  }
  files.sort((a,b)=>a.path.localeCompare(b.path))
  return{group,collectionAnchor:sha(JSON.stringify(group)),records,files}
}
const shape=value=>JSON.stringify({records:value.records,files:value.files})

export async function captureLocal(paths,output,{source,report=()=>{},io={}}={}){
  if(!validSource(source))fail('A verified local source account is required')
  if(typeof output!=='string'||!path.isAbsolute(output))fail('Use an absolute local capture path')
  await safe(path.dirname(output),'directory')
  const initial=await sourceFiles(paths,source)
  await mkdir(output,{mode:0o700})
  const root=await safe(output,'directory',{privateMode:true}),files=[]
  for(const file of initial.files){
    const target=path.join(root,file.path)
    await mkdir(path.dirname(target),{recursive:true,mode:0o700})
    const digest=await fileDigest(file.sourcePath,target)
    files.push({...file,...digest})
    if(io.afterCopy)await io.afterCopy({file:{...file,...digest},index:files.length})
    if(files.length===1||files.length%100===0)report(`Saving local conversations: ${files.length} files`)
  }
  const final=await sourceFiles(paths,source)
  if(shape(final)!==shape(initial)||final.collectionAnchor!==initial.collectionAnchor)fail('The local conversation list or history changed during capture. Click Transplant again before you switch accounts.')
  for(const file of files){const current=await fileDigest(file.sourcePath);if(current.bytes!==file.bytes||current.sha256!==file.sha256)fail('Local conversation data changed during capture. Click Transplant again before you switch accounts.')}
  const manifest={version:1,kind:'claude-local-conversation-capture',source:{account:source.account,org:source.org,label:source.label??source.account},capturedAt:new Date().toISOString(),collectionAnchor:initial.collectionAnchor,records:initial.records,files}
  await writeFile(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600})
  return verifyLocalCapture(paths,root,{source})
}

export async function verifyLocalCapture(paths,root,{source}={}){
  await safe(root,'directory',{privateMode:true})
  const manifestFile=path.join(root,'manifest.json');await safe(manifestFile,'file',{privateMode:true})
  const manifest=JSON.parse(await readFile(manifestFile,'utf8'))
  if(manifest.version!==1||manifest.kind!=='claude-local-conversation-capture'||!validSource(manifest.source)||source&&!same(manifest.source,source)||!HASH.test(manifest.collectionAnchor??'')||!Number.isFinite(Date.parse(manifest.capturedAt))||!Array.isArray(manifest.records)||!Array.isArray(manifest.files))fail('Invalid saved local conversation capture')
  const known=new Set(['manifest.json']),entries=new Map()
  for(const file of manifest.files){
    relative(file.path)
    if(known.has(file.path)||!['collection','record','scheduled-tasks','transcript','sidecar'].includes(file.role)||!Number.isSafeInteger(file.bytes)||file.bytes<0||!HASH.test(file.sha256??'')||!path.isAbsolute(file.sourcePath??''))fail('Invalid saved local capture file')
    const captured=path.join(root,file.path);await safe(captured,'file',{privateMode:true})
    const digest=await fileDigest(captured)
    if(digest.bytes!==file.bytes||digest.sha256!==file.sha256)fail('Saved local conversation data changed')
    known.add(file.path);entries.set(file.path,file)
  }
  const records=[],ids=new Set()
  for(const row of manifest.records){
    if(!RECORD.test(row?.name??'')||ids.has(row.name)||row.path!==`data/records/${row.name}`||row.sessionId!==row.name.slice(0,-5)||row.cliSessionId!==null&&!UUID.test(row.cliSessionId??''))fail('Invalid saved local conversation record')
    const file=entries.get(row.path)
    if(file?.role!=='record')fail('A saved local conversation record is missing')
    const record=JSON.parse(await readFile(path.join(root,row.path),'utf8'))
    if(record.sessionId!==row.sessionId||(record.cliSessionId??null)!==row.cliSessionId)fail('Saved local conversation identity changed')
    ids.add(row.name);records.push({...row,bytes:file.bytes,sha256:file.sha256})
  }
  if(manifest.files.filter(file=>file.role==='record').length!==records.length||manifest.files.filter(file=>file.role==='collection').length!==1)fail('The saved local conversation inventory is incomplete')
  const namespace=path.join(paths.records,manifest.source.account,manifest.source.org),sessions=new Set(records.map(row=>row.cliSessionId).filter(Boolean))
  for(const file of manifest.files){
    let expected
    if(file.role==='collection'&&file.path==='data/collection.json')expected=path.join(paths.state,'local-workflow.json')
    else if(file.role==='scheduled-tasks'&&file.path==='data/scheduled-tasks.json')expected=path.join(namespace,'scheduled-tasks.json')
    else if(file.role==='record'&&records.some(row=>row.path===file.path))expected=path.join(namespace,path.posix.basename(file.path))
    else if(['transcript','sidecar'].includes(file.role)&&file.path.startsWith('data/history/')){
      const name=file.path.slice('data/history/'.length),parts=name.split('/'),id=file.role==='transcript'?parts[1]?.slice(0,-6):parts[1]
      if(!sessions.has(id)||file.role==='transcript'&&(parts.length!==2||parts[1]!==`${id}.jsonl`)||file.role==='sidecar'&&parts.length<3)fail('Invalid saved local history identity')
      expected=path.join(paths.pool,name)
    }
    if(!expected||file.sourcePath!==expected)fail('Saved local data points outside its source account or history')
  }
  const collectionEntry=manifest.files.find(file=>file.role==='collection')
  const group=JSON.parse(await readFile(path.join(root,collectionEntry.path),'utf8'))
  if(!same(group.current,manifest.source)||sha(JSON.stringify(group))!==manifest.collectionAnchor)fail('The saved local source collection changed')
  const walk=async(directory,prefix='')=>{await safe(directory,'directory',{privateMode:true});for(const entry of await readdir(directory,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory())await walk(path.join(directory,entry.name),name+'/');else if(!entry.isFile()||!known.has(name))fail('Local capture contains files outside its manifest')}}
  await walk(root)
  return{path:root,source:manifest.source,count:records.length,records,manifest}
}

export async function verifyLocalMoveCapture(paths,plan){
  const stateFile=path.join(paths.state,'account-projects.json')
  if(!await optional(stateFile))return null
  await safe(stateFile,'file',{privateMode:true})
  const state=JSON.parse(await readFile(stateFile,'utf8'))
  if(!state.lastBatch)return null
  const root=state.lastBatch,parent=path.join(paths.state,'project-batches')
  if(typeof root!=='string'||!path.isAbsolute(root)||path.dirname(root)!==parent)fail('Invalid saved account capture path')
  await safe(root,'directory',{privateMode:true})
  const batchFile=path.join(root,'batch.json');await safe(batchFile,'file',{privateMode:true})
  const batch=JSON.parse(await readFile(batchFile,'utf8'))
  if(batch.version!==2||batch.phase!=='complete'||!same(batch.source,plan.from)||!same(batch.target,plan.to))return null
  if(batch.root!==root||typeof batch.localPath!=='string'||!path.isAbsolute(batch.localPath)||path.dirname(batch.localPath)!==root)fail('Invalid saved local conversation capture path')
  const capture=await verifyLocalCapture(paths,batch.localPath,{source:plan.from})
  if(!Array.isArray(plan.records)||new Set(plan.records).size!==plan.records.length||capture.records.some(row=>!plan.records.includes(row.name)))fail('The local conversation list differs from the saved copy. No local records were moved.')
  if(plan.recovery)return capture
  const namespace=path.join(paths.records,plan.from.account,plan.from.org)
  for(const row of capture.records){
    const file=path.join(namespace,row.name);await safe(file,'file')
    const record=JSON.parse(await readFile(file,'utf8'))
    if(record.sessionId!==row.sessionId||(record.cliSessionId??null)!==row.cliSessionId)fail('The local conversation identity changed after capture. No local records were moved.')
  }
  return capture
}
