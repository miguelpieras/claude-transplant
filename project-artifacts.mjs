import {execFile} from 'node:child_process'
import path from 'node:path'
import {promisify} from 'node:util'

const execute = promisify(execFile)
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const PROJECT = /^chan_[A-Za-z0-9]+$/
const safeError = value => typeof value === 'string' && value.length <= 600 && !/[\r\n\0]/.test(value) ? value : null
const helperErrors = new Set([
  'Unlock the Mac and run the project capture again. No saved report was used.',
  'Enable Claude Transplant Resume in System Settings > Privacy & Security > Accessibility, then run the project capture again.',
  'Open Claude in the source account, then run the project capture again.',
  'Claude could not open the selected report. No saved report was used.',
  'The current report could not be read and checked by its document ID. Keep Claude open and unlocked, then run the project capture again.',
  'The report contains multiple document frames. Its current text could not be selected by document ID. No report was exported.',
  'Verified project and report identities are required.',
  'The report export failed. No saved report was used.'
])
const reportError = (message,code='PROJECT_REPORT_UNAVAILABLE') => Object.assign(new Error(message),{code})
const errorCode = message => message.startsWith('Unlock the Mac') ? 'PROJECT_REPORT_LOCKED' : message.startsWith('Enable Claude Transplant Resume') ? 'PROJECT_REPORT_ACCESSIBILITY' : 'PROJECT_REPORT_UNAVAILABLE'

function outputOf(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16 * 1024 * 1024) throw reportError('The current report export response is invalid')
  try { return JSON.parse(text) } catch { throw reportError('The current report export response is invalid') }
}

export async function exportCurrentProjectArtifact({binary,account,org,projectId,id,metadata,indexEntry,run=execute}) {
  if (!path.isAbsolute(binary ?? '') || !UUID.test(account ?? '') || !UUID.test(org ?? '') || !PROJECT.test(projectId ?? '') || !UUID.test(id ?? '')) throw new Error('Verified source project and report identities are required')
  const stamp = Date.parse(metadata?.updatedAt)
  if (metadata?.id !== id || (indexEntry?.id ?? indexEntry?.slug) !== id || !Number.isFinite(stamp) || stamp !== Date.parse(indexEntry?.updated_at) || typeof metadata?.title !== 'string' || Buffer.byteLength(metadata.title) > 8192 || metadata.title.includes('\0')) throw new Error('The current report metadata does not match the project index')
  const args = ['--project-artifact-export',id,'--organization',org,'--account',account,'--project',projectId,'--title',metadata.title]
  let stdout
  try {
    const result = await run(binary,args,{encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024,windowsHide:true})
    stdout = result.stdout
  } catch (error) {
    // Only the helper's fixed errors can cross this boundary. Native stderr and
    // arbitrary process output can contain source data or temporary URLs.
    let result
    try { result = outputOf(error.stdout) } catch {}
    const message = safeError(result?.error)
    if (message && helperErrors.has(message)) throw reportError(message,errorCode(message))
    throw reportError('The current report could not be exported. Open and unlock Claude in the source account, then run the project capture again.')
  }
  const result = outputOf(stdout)
  if (result?.ok !== true || result.documentIdVerified !== true || result.id !== id || result.organizationId !== org || result.accountId !== account || result.projectId !== projectId || typeof result.text !== 'string' || !result.text.trim() || !Array.isArray(result.links)) throw reportError('The current report export did not prove the selected document identity')
  const links = []
  for (const row of result.links) {
    if (!row || typeof row.text !== 'string' || typeof row.url !== 'string') throw reportError('The current report contains an invalid exported link')
    let url
    try { url = new URL(row.url) } catch { throw reportError('The current report contains an invalid exported link') }
    if (!['http:','https:','mailto:'].includes(url.protocol) || ['__frame_t','__frame_v','sk'].some(key=>url.searchParams.has(key))) throw reportError('The current report contains a viewer transport URL')
    links.push(`${row.text || row.url}: ${row.url}`)
  }
  const text = `${result.text.trimEnd()}\n${links.length ? `\nLinks\n${links.join('\n')}\n` : ''}\nRepresentation: current document text and links. Native layout and widget state are not included.\n`
  return {bytes:Buffer.from(text),updatedAt:metadata.updatedAt,captureFormat:'text-and-links',nativeStateCaptured:false}
}

export function createProjectArtifactTextExporter(options) {
  return input => exportCurrentProjectArtifact({...options,...input})
}
