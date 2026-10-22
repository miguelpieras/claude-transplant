import {createHash} from 'node:crypto'

const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const canonical=value=>JSON.stringify(value,(_,item)=>object(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)
const hash=value=>createHash('sha256').update(value).digest('hex')
const failure=message=>Object.assign(new Error(message),{code:'PROJECT_REPORT_UNAVAILABLE'})
const failed=()=>failure('The current report state could not be read and checked. No saved report was used.')

// Claude Docs stores an ordered block map. Follow its references from the root,
// rather than sorting block IDs or copying the cached XML view. Code and widget
// implementation fields are not prose and are left in native-state.json.
function nativeBlockText(doc) {
  const roots=Object.entries(doc).filter(([,value])=>object(value)&&value.type==='root')
  if(roots.length!==1)return ''
  const active=new Set()
  let visits=0
  const walk=id=>{
    const block=doc[id]
    if(!object(block)||active.has(id)||++visits>100000)throw new Error('Invalid native document tree')
    active.add(id)
    const parts=[]
    for(const part of block.content??[]) {
      if(!object(part))continue
      if(part.kind==='text'&&typeof part.text==='string')parts.push(part.text)
      else if(part.kind==='block'&&typeof part.id==='string')parts.push(walk(part.id))
      // Marks change text formatting. Atoms and embedded widgets retain their
      // exact native data in the JSON representation.
      else if(part.kind==='atom')parts.push('[inline item]')
    }
    active.delete(id)
    const text=parts.join('')
    if(block.type==='embed')return typeof block.attrs?.caption==='string'?`[Embedded content: ${block.attrs.caption}]\n\n`:'[Embedded content]\n\n'
    if(['tableCell','tableHeader'].includes(block.type))return `${text.trim()}\t`
    if(block.type==='tableRow')return `${text.trimEnd()}\n`
    if(block.type==='listItem')return `- ${text.trim()}\n`
    if(['root','bulletList','orderedList','table'].includes(block.type))return `${text.trimEnd()}\n\n`
    return `${text.trimEnd()}\n\n`
  }
  try {return walk(roots[0][0]).trim()} catch {return ''}
}

// The complete native values remain in native-state.json, including blocks
// which have no plain-text form.
function proseText(value) {
  if(typeof value==='string') {
    try { value=JSON.parse(value) } catch { return '' }
  }
  if(!object(value))return ''
  if(!value.type)return nativeBlockText(value)
  if(!['doc','paragraph','heading','text','blockquote','bullet_list','ordered_list','list_item','code_block','table','table_row','table_cell','table_header'].includes(value.type))return ''
  const lines=[]
  const walk=node=>{
    if(!object(node))return ''
    if(node.type==='text'&&typeof node.text==='string')return node.text
    if(node.type==='hard_break')return '\n'
    if(!Array.isArray(node.content))return ''
    const text=node.content.map(walk).join('')
    return ['paragraph','heading','list_item','blockquote','code_block','table_row'].includes(node.type)?`${text}\n`:text
  }
  lines.push(walk(value))
  return lines.join('\n').trim()
}

export async function collectNativeProjectArtifact({id,org,boot,request,openSocket,timeoutMs=20000,maxBytes=64*1024*1024,now=()=>new Date().toISOString()}) {
  if(!UUID.test(id??'')||!UUID.test(org??'')||typeof request!=='function'||typeof openSocket!=='function')throw failure('A verified source report connection is required')
  const readToken=typeof boot?.syncToken==='string'&&boot.syncToken?boot.syncToken:null,updatedAt=boot?.updated_at??boot?.updatedAt
  if(boot?.contentStore!=='pages'||!readToken||typeof boot.title!=='string'||!Number.isFinite(Date.parse(updatedAt)))throw failure('The source report type does not support a native state read')
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||!Number.isSafeInteger(maxBytes)||maxBytes<=0)throw failure('Invalid report read limit')
  let mint
  try {
    mint=await request(`/api/frame/lane/bongo/${id}/subscribe?org=${encodeURIComponent(org)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:readToken})})
  } catch { throw failed() }
  if(!object(mint)||typeof mint.grant!=='string'||!mint.grant)throw failed()
  const stream='bongo.1',container=`project/${id}`
  const state=await new Promise((resolve,reject)=>{
    let socket,finished=false,opened=false,joined=false,chunks=0,total=0,head=null,positionHash=null
    const values=new Map(),refs=new Map()
    const end=(error,result)=>{
      if(finished)return
      finished=true;clearTimeout(timer)
      try { socket?.close() } catch {}
      error?reject(error):resolve(result)
    }
    const timer=setTimeout(()=>end(failure('The current report read timed out before a complete state was received. No saved report was used.')),timeoutMs)
    const send=value=>{
      if(finished)return
      try { socket.send(JSON.stringify(value)) } catch { end(failed()) }
    }
    try { socket=openSocket(`wss://claude.ai/api/frame/sync?slug=${id}&org=${encodeURIComponent(org)}`,['frame-sync.v1',readToken]) }
    catch { end(failed());return }
    if(!socket||typeof socket.addEventListener!=='function'||typeof socket.send!=='function'){end(failed());return}
    socket.addEventListener('open',()=>send({kind:'join',slug:id}))
    socket.addEventListener('error',()=>end(failed()))
    socket.addEventListener('close',()=>end(failure('The current report stream closed before a complete state was received. No saved report was used.')))
    socket.addEventListener('message',event=>{
      if(finished)return
      try {
        if(typeof event.data!=='string')throw failed()
        total+=Buffer.byteLength(event.data)
        if(total>maxBytes)throw failure('The current report exceeds the native state read limit. No report was exported.')
        const message=JSON.parse(event.data)
        if(!object(message)||typeof message.kind!=='string')throw failed()
        if(message.slug!==undefined&&message.slug!==id)throw failed()
        if(message.kind==='ctrl:joined') {
          if(joined||!object(message.payload)||message.payload.door!==true||!Array.isArray(message.payload.stores)||!message.payload.stores.includes('bongo'))throw failed()
          joined=true
          send({kind:'ctrl:open',slug:id,payload:{stream,grant:mint.grant,spec:JSON.stringify({container}),since:null}})
          return
        }
        if(['ctrl:stream_denied','ctrl:stream_reset'].includes(message.kind)&&message.payload?.stream===stream)throw failed()
        if(message.kind==='ctrl:opened'&&message.payload?.stream===stream){if(!joined||opened)throw failed();opened=true;return}
        if(message.kind!=='store:bongo'||message.stream!==stream)return
        if(!opened)throw failed()
        const payload=typeof message.payload==='string'?JSON.parse(message.payload):message.payload
        if(!object(payload))throw failed()
        if(payload.phase==='snapshot') {
          if(!object(payload.values)||!Array.isArray(payload.refs))throw failed()
          chunks++
          for(const [key,value] of Object.entries(payload.values)) {
            if(!/^[A-Za-z_][A-Za-z0-9_]*\/.{1,512}$/.test(key)||key.includes('\0'))throw failed()
            if(values.has(key)&&canonical(values.get(key))!==canonical(value))throw failure('The report changed while its native state was read. Run the project capture again.')
            values.set(key,value)
          }
          for(const ref of payload.refs)refs.set(canonical(ref),ref)
          if(payload.head!==undefined){if(!Number.isSafeInteger(payload.head)||payload.head<0)throw failed();head=Math.max(head??0,payload.head)}
          return
        }
        if(payload.phase!=='fence')throw failure('The report changed before its complete native state was received. Run the project capture again.')
        if(!chunks||!values.has(container)||!object(values.get(container)))throw failure('The report state did not prove the selected document identity')
        if(typeof payload.pos==='string')positionHash=hash(payload.pos)
        end(null,{values:Object.fromEntries([...values].sort(([a],[b])=>a.localeCompare(b))),refs:[...refs].sort(([a],[b])=>a.localeCompare(b)).map(([,value])=>value),head,positionHash,chunks})
      } catch(error) { end(error?.code==='PROJECT_REPORT_UNAVAILABLE'?error:failed()) }
    })
  })
  // Never retain the bootstrap, grants, viewer tokens, or wire envelopes.
  const capturedAt=now(),source={artifactId:id,organizationId:org,capturedAt}
  const native={schemaVersion:1,kind:'claude-doc-native-state',source,head:state.head,positionSha256:state.positionHash,values:state.values,refs:state.refs}
  const bytes=Buffer.from(`${JSON.stringify(native,null,2)}\n`),stateSha256=hash(bytes),contentSha256=hash(canonical({values:state.values,refs:state.refs,head:state.head}))
  const files=[{path:'native-state.json',bytes}]
  const text=[]
  for(const [key,value] of Object.entries(state.values))if(key.startsWith('node/')&&object(value)){const prose=proseText(value.doc);if(prose)text.push(prose)}
  if(text.length)files.push({path:'report.txt',bytes:Buffer.from(`${boot.title}\n\n${text.join('\n\n')}\n\nRepresentation: text extracted from the current native document state. Formatting, inline items, and embedded content are preserved in full in native-state.json.\n`)})
  return {metadata:{id,title:boot.title,version:boot.ver??null,updatedAt,kind:boot.kind??null,contentStore:boot.contentStore,typeSlug:boot.typeSlug??null,captureFormat:'native-state-json',nativeStateCaptured:true,capturedAt,nativeHead:state.head,nativePositionSha256:state.positionHash,stateSha256,contentSha256,valueCount:Object.keys(state.values).length,referenceCount:state.refs.length},files}
}
