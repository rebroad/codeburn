import { execFileSync } from 'node:child_process'
import { existsSync, cpSync, chmodSync, readFileSync, realpathSync, readdirSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const commit = process.env['CODEBURN_COMMIT']
if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) {
  throw new Error('Set CODEBURN_COMMIT to the full source commit before updating installed CodeBurn CLIs.')
}

const buildRoot = realpathSync(process.cwd())
const sourceDist = join(buildRoot, 'dist')
const sourceCli = join(sourceDist, 'cli.js')
const expectedVersion = commit.slice(0, 10)
if (!existsSync(sourceCli) || !readFileSync(join(sourceDist, 'main.js'), 'utf8').includes(expectedVersion)) {
  throw new Error(`Built CLI does not contain commit ${expectedVersion}; rebuild before installing.`)
}

const candidates = new Map()
const pathCommands = new Set()
let pathCommandFound = false

function addPackage(packagePath, nodePath, source) {
  const manifest = join(packagePath, 'package.json')
  if (!existsSync(manifest)) return
  try {
    if (JSON.parse(readFileSync(manifest, 'utf8')).name !== 'codeburn') return
  } catch {
    return
  }
  const key = `${resolve(packagePath)}\0${resolve(nodePath)}`
  const existing = candidates.get(key)
  if (existing) existing.sources.add(source)
  else candidates.set(key, { packagePath: resolve(packagePath), nodePath: resolve(nodePath), sources: new Set([source]) })
}

function addNode(nodePath, source) {
  if (!existsSync(nodePath)) return
  const realNode = realpathSync(nodePath)
  const prefix = dirname(dirname(realNode))
  addPackage(join(prefix, 'lib', 'node_modules', 'codeburn'), realNode, source)
  addPackage(join(prefix, 'node_modules', 'codeburn'), realNode, source)
}

function packageFromCommand(commandPath) {
  if (!existsSync(commandPath)) return undefined
  let resolvedPath
  try {
    resolvedPath = realpathSync(commandPath)
  } catch {
    return undefined
  }
  let current = dirname(resolvedPath)
  while (current !== dirname(current)) {
    if (basename(current) === 'codeburn' && existsSync(join(current, 'package.json'))) return current
    current = dirname(current)
  }
  return undefined
}

const home = homedir()
const nvmRoot = process.env['NVM_DIR'] ?? join(home, '.nvm')
const nvmVersions = join(nvmRoot, 'versions', 'node')
if (existsSync(nvmVersions)) {
  for (const entry of readdirSync(nvmVersions, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('v')) continue
    const prefix = join(nvmVersions, entry.name)
    const nodePath = join(prefix, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
    addPackage(join(prefix, 'lib', 'node_modules', 'codeburn'), nodePath, `NVM ${entry.name}`)
    addPackage(join(prefix, 'node_modules', 'codeburn'), nodePath, `NVM ${entry.name}`)
  }
}

addNode(process.execPath, `build Node ${process.version}`)

for (const directory of (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
  addNode(join(directory, nodeName), `PATH Node ${directory}`)
  for (const commandName of process.platform === 'win32' ? ['codeburn.exe', 'codeburn.cmd', 'codeburn'] : ['codeburn']) {
    const commandPath = join(directory, commandName)
    if (!existsSync(commandPath)) continue
    if (!pathCommandFound) {
      pathCommands.add(commandPath)
      pathCommandFound = true
    }
    const packagePath = packageFromCommand(commandPath)
    if (!packagePath) continue
    const realPackage = realpathSync(packagePath)
    const nodePath = join(dirname(dirname(dirname(realPackage))), 'bin', nodeName)
    addPackage(packagePath, existsSync(nodePath) ? nodePath : process.execPath, `PATH command ${commandPath}`)
    pathCommands.add(commandPath)
  }
}

const configuredPrefix = process.env['npm_config_prefix'] ?? process.env['NPM_CONFIG_PREFIX']
if (configuredPrefix) {
  addPackage(join(configuredPrefix, 'lib', 'node_modules', 'codeburn'), process.execPath, 'npm global prefix')
  addPackage(join(configuredPrefix, 'node_modules', 'codeburn'), process.execPath, 'npm global prefix')
}

if (candidates.size === 0) throw new Error('No installed CodeBurn package was found to update.')

function assertCommit(output, label) {
  if (!output.includes(expectedVersion)) {
    throw new Error(`${label} reports ${output.trim()}, expected commit ${expectedVersion}.`)
  }
}

for (const { packagePath, nodePath, sources } of candidates.values()) {
  const installedRoot = realpathSync(packagePath)
  if (installedRoot !== buildRoot) {
    cpSync(sourceDist, join(packagePath, 'dist'), { recursive: true, force: true })
    chmodSync(join(packagePath, 'dist', 'cli.js'), 0o755)
  }
  const cliPath = join(packagePath, 'dist', 'cli.js')
  const output = execFileSync(nodePath, [cliPath, '--version'], { encoding: 'utf8' }).trim()
  assertCommit(output, packagePath)
  console.log(`${output} verified via ${[...sources].join(', ')}`)
}

for (const commandPath of pathCommands) {
  const output = execFileSync(commandPath, ['--version'], { encoding: 'utf8' }).trim()
  assertCommit(output, `PATH command ${commandPath}`)
  console.log(`${output} verified via PATH command ${commandPath}`)
}

if (pathCommands.size === 0) {
  console.log('No codeburn executable is currently resolved from PATH; verified all discovered Node global installs.')
}
