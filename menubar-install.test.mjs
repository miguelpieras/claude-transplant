import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { layout, menubar } from './transplant.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const sha = value => createHash('sha256').update(value).digest('hex')
const label = 'io.github.miguelpieras.claude-transplant-resume'
const identity = 'A'.repeat(40), otherIdentity = 'B'.repeat(40)
const developerName = 'Developer ID Application: Fixture Owner (TESTTEAM42)'
const requirement = `identifier "${label}" and anchor apple generic and certificate leaf[subject.OU] = "TESTTEAM42"`
const signatureFile = app => path.join(app, 'Contents/_CodeSignature/CodeResources')
const ok = { status: 0, stdout: '', stderr: '' }

function tree(directory) {
  if (!existsSync(directory)) return null
  const files = {}
  const visit = (dir, relative = '') => {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name), key = path.join(relative, name)
      if (statSync(file).isDirectory()) visit(file, key)
      else files[key] = readFileSync(file).toString('base64')
    }
  }
  visit(directory)
  return files
}

async function installedApp(t, { savedVersion = '0.0.0-fixture', hashVersion = savedVersion, binaryExists = true } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ct-menubar-install-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const paths = layout(home)
  const app = path.join(paths.state, 'Claude Transplant Resume.app')
  const binary = path.join(app, 'Contents/MacOS/Claude Transplant Resume')
  const resources = path.join(app, 'Contents/Resources'), info = path.join(app, 'Contents/Info.plist')
  const config = path.join(paths.state, 'menubar.json')
  const agent = path.join(home, 'Library/LaunchAgents', `${label}.plist`)
  const pin = path.join(paths.state, 'signing-identity.json')
  const sources = (await Promise.all(['menubar.swift', 'workflow.swift', 'project-artifact-export.swift'].map(name => readFile(path.join(here, name), 'utf8')))).join('')
  await mkdir(path.dirname(binary), { recursive: true })
  await mkdir(resources, { recursive: true })
  await mkdir(path.dirname(agent), { recursive: true })
  if (binaryExists) await writeFile(binary, 'native identity fixture')
  await writeFile(info, `<plist><dict><key>CFBundleShortVersionString</key><string>${savedVersion}</string></dict></plist>`)
  await writeFile(path.join(resources, 'build.sha256'), sha(sources + hashVersion))
  await writeFile(path.join(resources, 'transplant.js'), 'old installed JavaScript')
  await writeFile(config, 'old external config\n')
  await writeFile(agent, 'old launch agent\n')
  const state = { identities: [[identity, developerName]], failSign: false, failVerify: false, failBootstrap: false, failRunning: false, loaded: false, refuseRunning: false, unloading: 0, builds: 0, signedTree: null }
  const calls = [], warnings = []
  const readSignature = target => existsSync(signatureFile(target)) ? JSON.parse(readFileSync(signatureFile(target), 'utf8')) : null
  t.mock.method(process.stderr, 'write', value => { warnings.push(String(value)); return true })
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    const name = path.basename(command), target = args.at(-1)
    calls.push({ name, args: [...args], installed: tree(app), external: readFileSync(config, 'utf8') })
    if (name === 'swiftc') {
      state.builds++
      writeFileSync(args[args.indexOf('-o') + 1], 'rebuilt native fixture')
      return ok
    }
    if (name === 'security') {
      assert.deepEqual(args, ['find-identity', '-v', '-p', 'codesigning'])
      return { ...ok, stdout: state.identities.map(([hash, title], i) => `  ${i + 1}) ${hash} "${title}"`).join('\n') + `\n     ${state.identities.length} valid identities found\n` }
    }
    if (name === 'codesign') {
      if (args.includes('--sign')) {
        assert.notEqual(target, app, 'the installed bundle must never be signed in place')
        assert.equal(args[args.indexOf('--sign') + 1], identity)
        assert.equal(args[args.indexOf('--identifier') + 1], label)
        const stageResources = path.join(target, 'Contents/Resources')
        for (const file of ['transplant.js', 'local-workflow.mjs', 'package.json', 'menubar.json', 'build.sha256']) {
          assert.ok(existsSync(path.join(stageResources, file)), `the staged bundle must contain ${file} before signing`)
        }
        assert.equal(readFileSync(path.join(stageResources, 'transplant.js'), 'utf8'), readFileSync(path.join(here, 'transplant.js'), 'utf8'))
        assert.equal(JSON.parse(readFileSync(path.join(stageResources, 'menubar.json'), 'utf8')).script, path.join(resources, 'transplant.js'))
        if (state.failSign) return { ...ok, status: 1, stderr: 'fixture signing failed' }
        mkdirSync(path.dirname(signatureFile(target)), { recursive: true })
        writeFileSync(signatureFile(target), JSON.stringify({ identity, requirement }))
        state.signedTree = tree(target)
        return ok
      }
      if (args.includes('--verify')) {
        assert.ok(args.includes('--strict'), 'every staged signature check must be strict')
        assert.notEqual(target, app, 'verify the staged bundle before replacement')
        if (state.failVerify) return { ...ok, status: 1, stderr: 'fixture verification failed' }
        assert.ok(readSignature(target), 'the staged bundle must be signed before verification')
        if (args.includes('--test-requirement')) assert.equal(args[args.indexOf('--test-requirement') + 1], `=${requirement}`)
        return ok
      }
      if (args.includes('--display')) {
        const signed = readSignature(target)
        if (args.includes('--requirements')) {
          const text = `designated => ${signed?.requirement ?? requirement}\n`
          return { ...ok, stdout: text, stderr: text }
        }
        return { ...ok, stderr: signed ? `Identifier=${label}\nAuthority=${developerName}\nTeamIdentifier=TESTTEAM42\n` : 'Identifier=Claude Transplant Resume\nSignature=adhoc\nTeamIdentifier=not set\n' }
      }
      assert.fail(`Unexpected codesign command: ${args.join(' ')}`)
    }
    if (name === 'launchctl') {
      if (args[0] === 'bootout') { state.loaded = false; state.refuseRunning = false }
      if (args[0] === 'print') {
        if (state.loaded) return { ...ok, stdout: state.refuseRunning ? 'state = waiting\n' : 'state = running\npid = 12345\n' }
        return { ...ok, status: state.unloading-- > 0 ? 0 : 113 }
      }
      if (args[0] === 'bootstrap' && state.failBootstrap) {
        state.failBootstrap = false
        return { ...ok, status: 5, stderr: 'fixture bootstrap failed' }
      }
      if (args[0] === 'bootstrap') {
        state.loaded = true
        state.refuseRunning = state.failRunning
        state.failRunning = false
      }
      return ok
    }
    if (name === 'pkill') return ok
    assert.fail(`Unexpected native command: ${command} ${args.join(' ')}`)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const snapshot = () => ({ app: tree(app), config: readFileSync(config, 'utf8'), agent: readFileSync(agent, 'utf8'), pin: existsSync(pin) ? readFileSync(pin, 'utf8') : null })
  return { paths, app, binary, resources, info, config, agent, pin, sources, state, calls, warnings, snapshot }
}

test('JS-only updates stage and sign the complete app while reusing the native binary', async t => {
  const f = await installedApp(t)
  const version = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8')).version
  assert.equal(await menubar(f.paths, false, null, { launch: false }), f.app)
  assert.equal(f.state.builds, 0)
  assert.equal(await readFile(f.binary, 'utf8'), 'native identity fixture')
  assert.equal(await readFile(path.join(f.resources, 'build.sha256'), 'utf8'), sha(f.sources))
  assert.match(await readFile(f.info, 'utf8'), new RegExp(`<key>CFBundleShortVersionString</key><string>${version.replaceAll('.', '\\.')}<\\/string>`))
  assert.equal(JSON.parse(await readFile(path.join(f.resources, 'package.json'), 'utf8')).version, version)
  assert.deepEqual(tree(f.app), f.state.signedTree, 'no bundle file can change after signing')
  assert.ok(f.calls.every(call => !['launchctl', 'pkill'].includes(call.name)))
  const pin = JSON.parse(await readFile(f.pin, 'utf8'))
  assert.deepEqual(pin, { version: 1, identity, requirement })
  assert.equal(path.dirname(f.pin), f.paths.state)
  f.calls.length = 0
  f.state.identities.push([otherIdentity, 'Developer ID Application: Other Owner (OTHERTEAM1)'])
  await menubar(f.paths, false, null, { launch: false })
  assert.equal(f.state.builds, 0)
  assert.equal(f.calls.filter(call => call.name === 'codesign' && call.args.includes('--sign')).length, 1)
  assert.ok(f.calls.some(call => call.name === 'codesign' && call.args.includes('--test-requirement')))
  assert.deepEqual(JSON.parse(await readFile(f.pin, 'utf8')), pin)
  assert.deepEqual(tree(f.app), f.state.signedTree)
})

test('native source changes rebuild the staged executable before signing', async t => {
  const f = await installedApp(t, { hashVersion: '0.0.0-other' })
  await menubar(f.paths, false, null, { launch: false })
  assert.equal(f.state.builds, 1)
  assert.equal(await readFile(f.binary, 'utf8'), 'rebuilt native fixture')
  assert.ok(f.calls.findIndex(call => call.name === 'swiftc') < f.calls.findIndex(call => call.args.includes('--sign')))
})

test('a matching source hash cannot retain a missing native executable', async t => {
  const f = await installedApp(t, { binaryExists: false })
  await menubar(f.paths, false, null, { launch: false })
  assert.equal(f.state.builds, 1)
  assert.equal(await readFile(f.binary, 'utf8'), 'rebuilt native fixture')
})

test('strict signature verification finishes before the installed app stops or changes', async t => {
  const f = await installedApp(t), before = f.snapshot()
  f.state.unloading = 2
  assert.match(await menubar(f.paths, false, null), /^menubar installed/)
  const verified = f.calls.findIndex(call => call.name === 'codesign' && call.args.includes('--verify'))
  const stopped = f.calls.findIndex(call => call.name === 'launchctl' && call.args[0] === 'bootout')
  assert.ok(verified >= 0 && stopped > verified)
  assert.deepEqual(f.calls[verified].installed, before.app)
  assert.equal(f.calls[verified].external, before.config)
  assert.deepEqual(f.calls.filter(call => ['launchctl', 'pkill'].includes(call.name)).map(call => `${call.name} ${call.args[0]}`), ['launchctl bootout', 'pkill -x', 'launchctl print', 'launchctl print', 'launchctl print', 'launchctl bootstrap', 'launchctl print'])
  assert.deepEqual(tree(f.app), f.state.signedTree)
})

for (const failure of ['failSign', 'failVerify']) {
  test(`${failure === 'failSign' ? 'signing' : 'signature verification'} failure leaves the installed app and running process unchanged`, async t => {
    const f = await installedApp(t), before = f.snapshot()
    f.state[failure] = true
    await assert.rejects(menubar(f.paths, false, null), /sign|verif/i)
    assert.deepEqual(f.snapshot(), before)
    assert.ok(f.calls.every(call => !['launchctl', 'pkill'].includes(call.name)))
  })
}

test('a missing pinned identity cannot fall back to another signer or ad-hoc signing', async t => {
  const f = await installedApp(t)
  await menubar(f.paths, false, null, { launch: false })
  const before = f.snapshot()
  f.calls.length = 0
  f.state.identities = [[otherIdentity, 'Developer ID Application: Other Owner (OTHERTEAM1)'], ['C'.repeat(40), 'Apple Development: Fixture Owner (TESTTEAM42)']]
  await assert.rejects(menubar(f.paths, false, null), /identity|sign|certificate/i)
  assert.deepEqual(f.snapshot(), before)
  assert.ok(f.calls.every(call => !call.args.includes('--sign') && !['launchctl', 'pkill'].includes(call.name)))
})

test('ambiguous Developer ID identities do not change the installed app', async t => {
  const f = await installedApp(t), before = f.snapshot()
  f.state.identities.push([otherIdentity, 'Developer ID Application: Other Owner (OTHERTEAM1)'])
  await assert.rejects(menubar(f.paths, false, null), /identity|sign|certificate|multiple|more than one/i)
  assert.deepEqual(f.snapshot(), before)
  assert.ok(f.calls.every(call => !call.args.includes('--sign') && !['launchctl', 'pkill'].includes(call.name)))
})

test('a launch failure restores the prior app, external config, and signing identity', async t => {
  const f = await installedApp(t), before = f.snapshot()
  f.state.failBootstrap = true
  await assert.rejects(menubar(f.paths, false, null), /bootstrap|launch/i)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(f.calls.filter(call => call.name === 'launchctl' && call.args[0] === 'bootstrap').length, 2, 'rollback must start the previous app')
})

test('a loaded job that never starts cannot replace the prior app or its signing identity', async t => {
  const f = await installedApp(t), before = f.snapshot()
  let clock = 0
  t.mock.method(performance, 'now', () => { clock += 6000; return clock })
  f.state.failRunning = true
  await assert.rejects(menubar(f.paths, false, null), /did not start|launch/i)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(f.calls.filter(call => call.name === 'launchctl' && call.args[0] === 'bootstrap').length, 2)
  assert.ok(f.state.loaded && !f.state.refuseRunning, 'rollback must reopen the previous app')
})

test('a legacy install without a Developer ID remains available with a clear permission warning', async t => {
  const f = await installedApp(t)
  f.state.identities = [[otherIdentity, 'Apple Development: Fixture Owner (TESTTEAM42)']]
  assert.equal(await menubar(f.paths, false, null, { launch: false }), f.app)
  assert.equal(existsSync(f.pin), false)
  assert.equal(f.calls.some(call => call.name === 'codesign' && call.args.includes('--sign')), false)
  assert.equal(await readFile(f.binary, 'utf8'), 'native identity fixture')
  assert.match(f.warnings.join(''), /Developer ID|Accessibility|permission/i)
})
