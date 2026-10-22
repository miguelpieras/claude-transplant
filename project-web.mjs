import {execFile} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {lstat,mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {promisify} from 'node:util'

const execute=promisify(execFile)
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const fail=message=>{throw Object.assign(new Error(message),{code:'PROJECT_SOURCE_LOGIN'})}
const same=(a,b)=>a?.account===b?.account&&a?.org===b?.org
function location(paths,expected){
  if(!path.isAbsolute(paths.state??'')||!UUID.test(expected?.account??'')||!UUID.test(expected?.org??''))fail('A verified source account and organization are required')
  return path.join(paths.state,'project-connections',`${expected.account}-${expected.org}.json`)
}
const binary=paths=>path.join(paths.state,'Claude Transplant Resume.app/Contents/MacOS/Claude Transplant Resume')
async function helper(paths,expected,connect,run=execute){
  let result
  try {
    const value=await run(binary(paths),[connect?'--project-source-connect':'--project-source-credentials','--account',expected.account,'--org',expected.org],{encoding:'utf8',timeout:connect?15*60*1000:60000,maxBuffer:1024*1024,windowsHide:true})
    result=JSON.parse(value.stdout)
  }catch {fail(connect?'The source connection did not finish. Use Connect source and sign into that account.':'The source login could not be checked. Use Connect source in Transplant. Claude Desktop can stay on the destination account.')}
  if(!same(result,expected))fail('The source login belongs to another account or organization. No project was read.')
  return result
}
export async function projectWebSource(paths,expected){
  const file=location(paths,expected)
  try {
    const info=await lstat(file)
    if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o777)!==0o600)return{available:false}
    const value=JSON.parse(await readFile(file,'utf8'))
    if(value.version!==1||!same(value,expected))return{available:false}
    return{available:true,account:value.account,org:value.org,email:value.email??null}
  }catch {return{available:false}}
}
export async function connectProjectWeb(paths,expected,{run}={}){
  const file=location(paths,expected),result=await helper(paths,expected,true,run)
  if(result.done!==true||result.ok!==true)fail('The source connection was not verified')
  const metadata={version:1,account:expected.account,org:expected.org,email:typeof result.email==='string'?result.email:null,connectedAt:new Date().toISOString()}
  await mkdir(path.dirname(file),{recursive:true,mode:0o700})
  const parent=await lstat(path.dirname(file))
  if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o777)!==0o700)fail('Source connection settings must be in a private directory')
  const temporary=`${file}.${randomUUID()}.tmp`
  await writeFile(temporary,JSON.stringify(metadata,null,2)+'\n',{mode:0o600,flag:'wx'})
  try {await rename(temporary,file)}finally{await unlink(temporary).catch(()=>{})}
  return{done:true,ok:true,account:expected.account,org:expected.org,email:metadata.email}
}
export async function loadProjectWeb(paths,expected,{run}={}){
  if(!(await projectWebSource(paths,expected)).available)fail('Use Connect source in Transplant once. Claude Desktop can stay on its current account.')
  const result=await helper(paths,expected,false,run)
  if(!Array.isArray(result.cookies)||result.cookies.length>1000)fail('The source web login is invalid')
  const cookies=new Map()
  for(const cookie of result.cookies){
    if(!cookie||!['claude.ai','.claude.ai'].includes(cookie.domain)||typeof cookie.name!=='string'||!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name)||typeof cookie.value!=='string'||/[;\r\n\0]/.test(cookie.value)||cookie.path!=='/')continue
    cookies.set(cookie.name,cookie.value)
  }
  if(!cookies.get('sessionKey'))fail('The source web login expired. Use Connect source in Transplant again.')
  return{account:expected.account,org:expected.org,email:typeof result.email==='string'?result.email:null,cookies:[...cookies],...(typeof result.userAgent==='string'&&result.userAgent.length<1000&&!/[\r\n]/.test(result.userAgent)?{userAgent:result.userAgent}:{})}
}
