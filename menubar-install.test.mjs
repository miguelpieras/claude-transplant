import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { layout, menubar } from './transplant.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const sha = value => createHash('sha256').update(value).digest('hex')

async function installedApp(t, { savedVersion = '0.0.0-fixture', hashVersion = savedVersion, binaryExists = true } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ct-menubar-install-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const paths = layout(home)
  const app = path.join(paths.state, 'Claude Transplant Resume.app')
  const binary = path.join(app, 'Contents/MacOS/Claude Transplant Resume')
  const resources = path.join(app, 'Contents/Resources')
  const info = path.join(app, 'Contents/Info.plist')
  const sources = (await Promise.all(['menubar.swift', 'workflow.swift', 'project-artifact-export.swift'].map(name => readFile(path.join(here, name), 'utf8')))).join('')
  await mkdir(path.dirname(binary), { recursive: true })
  await mkdir(resources, { recursive: true })
  if (binaryExists) await writeFile(binary, 'native identity fixture')
  await writeFile(info, `<plist><dict><key>CFBundleShortVersionString</key><string>${savedVersion}</string></dict></plist>`)
  await writeFile(path.join(resources, 'build.sha256'), sha(sources + hashVersion))
  let builds = 0
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    assert.equal(command, 'swiftc', 'launch:false must not run native app or launch commands')
    builds++
    writeFileSync(args[args.indexOf('-o') + 1], 'rebuilt native fixture')
    return { status: 0, stderr: '' }
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  return { paths, app, binary, resources, info, sources, builds: () => builds }
}

test('JS-only install keeps the native binary and adopts the legacy source hash', async t => {
  const f = await installedApp(t)
  const version = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8')).version
  assert.equal(await menubar(f.paths, false, null, { launch: false }), f.app)
  assert.equal(f.builds(), 0)
  assert.equal(await readFile(f.binary, 'utf8'), 'native identity fixture')
  assert.equal(await readFile(path.join(f.resources, 'build.sha256'), 'utf8'), sha(f.sources))
  assert.match(await readFile(f.info, 'utf8'), new RegExp(`<key>CFBundleShortVersionString</key><string>${version.replaceAll('.', '\\.')}<\\/string>`))
  assert.equal(JSON.parse(await readFile(path.join(f.resources, 'package.json'), 'utf8')).version, version)
  assert.equal(await readFile(path.join(f.resources, 'transplant.js'), 'utf8'), await readFile(path.join(here, 'transplant.js'), 'utf8'))
  await menubar(f.paths, false, null, { launch: false })
  assert.equal(f.builds(), 0, 'the native source hash must remain valid after the metadata update')
  assert.equal(await readFile(f.binary, 'utf8'), 'native identity fixture')
})

test('legacy source hash is rejected when it does not match the installed version', async t => {
  const f = await installedApp(t, { hashVersion: '0.0.0-other' })
  await menubar(f.paths, false, null, { launch: false })
  assert.equal(f.builds(), 1)
  assert.equal(await readFile(f.binary, 'utf8'), 'rebuilt native fixture')
  assert.equal(await readFile(path.join(f.resources, 'build.sha256'), 'utf8'), sha(f.sources))
})

test('a matching legacy source hash cannot replace a missing native binary', async t => {
  const f = await installedApp(t, { binaryExists: false })
  await menubar(f.paths, false, null, { launch: false })
  assert.equal(f.builds(), 1)
  assert.equal(await readFile(f.binary, 'utf8'), 'rebuilt native fixture')
})
