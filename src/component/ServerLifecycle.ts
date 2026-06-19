import { execFile, spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { argv, execPath, pid } from 'node:process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { codexioRootPath } from '../AppMetadata.js'
import { CodexioConfig, ConfigService, validateCodexioConfig } from '../ConfigService.js'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const tsxPackagePath = require.resolve('tsx/package.json')
const tsxCliPath = join(dirname(tsxPackagePath), 'dist', 'cli.mjs')

const RuntimeServerStateSchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  port: z.number().int().positive(),
  startedAt: z.string()
})

const SupervisorStateSchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  port: z.number().int().positive(),
  token: z.string().min(1),
  startedAt: z.string()
})

export type RuntimeServerState = z.infer<typeof RuntimeServerStateSchema>
export type SupervisorState = z.infer<typeof SupervisorStateSchema>

export type RestartTarget = {
  host: string
  port: number
  source: 'runtime' | 'config'
}

export type ServeProcessSpec = {
  command: string
  args: string[]
  cwd: string
}

export type ServeProcessSpecOptions = {
  autoPort?: boolean
}

export async function startServer(configPath?: string): Promise<SupervisorState> {
  const service = new ConfigService(configPath)
  const supervisor = await readRunningSupervisorState(service.path)
  if (supervisor) {
    return supervisor
  }
  throw new Error('codexio supervisor is not running. Start codexio with pnpm run dev or pnpm run start.')
}

export async function stopServer(configPath?: string): Promise<boolean> {
  const service = new ConfigService(configPath)
  const supervisor = await readRunningSupervisorState(service.path)
  if (!supervisor) {
    await removeSupervisorState(service.path)
    await removeRuntimeServerState(service.path)
    return false
  }
  await requestSupervisor(supervisor, 'stop')
  return true
}

export async function restartServer(configPath?: string): Promise<SupervisorState> {
  const service = new ConfigService(configPath)
  const supervisor = await readRunningSupervisorState(service.path)
  if (!supervisor) {
    throw new Error('codexio supervisor is not running. Start codexio with pnpm run dev or pnpm run start.')
  }
  await requestSupervisor(supervisor, 'restart')
  return supervisor
}

export async function resolveRestartTargets(configPath: string, config: CodexioConfig): Promise<RestartTarget[]> {
  const targets: RestartTarget[] = []
  const runtime = await readRuntimeServerState(configPath)
  if (runtime && isProcessAlive(runtime.pid)) {
    targets.push({
      host: runtime.host,
      port: runtime.port,
      source: 'runtime'
    })
  }
  const configTarget: RestartTarget = {
    host: config.server.host,
    port: config.server.port,
    source: 'config'
  }
  const alreadyIncluded = targets.some((target) => target.host === configTarget.host && target.port === configTarget.port)
  if (!alreadyIncluded) {
    targets.push(configTarget)
  }
  return targets
}

export async function resolveAvailableServerPort(host: string, preferredPort: number): Promise<number> {
  let port = preferredPort
  while (port < 65536) {
    const available = await isServerPortAvailable(host, port)
    if (available) {
      return port
    }
    port += 1
  }
  throw new Error(`no available server port found from ${preferredPort}`)
}

export async function writeRuntimeServerState(configPath: string, state: RuntimeServerState): Promise<void> {
  const path = runtimeServerStatePath(configPath)
  await mkdir(dirname(path), {
    recursive: true
  })
  await writeFile(path, JSON.stringify(RuntimeServerStateSchema.parse(state), null, 2), 'utf8')
}

export async function readRuntimeServerState(configPath: string): Promise<RuntimeServerState | undefined> {
  try {
    const text = await readFile(runtimeServerStatePath(configPath), 'utf8')
    return RuntimeServerStateSchema.parse(JSON.parse(text))
  } catch {
    return undefined
  }
}

export async function writeSupervisorState(configPath: string, state: SupervisorState): Promise<void> {
  const path = supervisorStatePath(configPath)
  await mkdir(dirname(path), {
    recursive: true
  })
  await writeFile(path, JSON.stringify(SupervisorStateSchema.parse(state), null, 2), 'utf8')
}

export async function readSupervisorState(configPath: string): Promise<SupervisorState | undefined> {
  try {
    const text = await readFile(supervisorStatePath(configPath), 'utf8')
    return SupervisorStateSchema.parse(JSON.parse(text))
  } catch {
    return undefined
  }
}

export async function readRunningSupervisorState(configPath: string): Promise<SupervisorState | undefined> {
  const state = await readSupervisorState(configPath)
  if (!state || !isProcessAlive(state.pid)) {
    return undefined
  }
  const ready = await isSupervisorReady(state)
  if (!ready) {
    return undefined
  }
  return state
}

export async function removeRuntimeServerState(configPath: string): Promise<void> {
  await rm(runtimeServerStatePath(configPath), {
    force: true
  })
}

export async function removeSupervisorState(configPath: string): Promise<void> {
  await rm(supervisorStatePath(configPath), {
    force: true
  })
}

export function createServeProcessSpec(configPath: string, entryPath = argv[1], options: ServeProcessSpecOptions = {}): ServeProcessSpec {
  const serveArgs = [
    'serve',
    '--config',
    configPath
  ]
  if (options.autoPort) {
    serveArgs.push('--auto-port')
  }
  if (entryPath?.endsWith('.ts')) {
    return {
      command: execPath,
      args: [
        tsxCliPath,
        relative(codexioRootPath, entryPath),
        ...serveArgs
      ],
      cwd: codexioRootPath
    }
  }
  if (!entryPath) {
    throw new Error('codexio entry path not found')
  }
  return {
    command: execPath,
    args: [
      entryPath,
      ...serveArgs
    ],
    cwd: codexioRootPath
  }
}

export function spawnServeProcess(configPath: string, options: ServeProcessSpecOptions = {}) {
  const spec = createServeProcessSpec(configPath, argv[1], options)
  return spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    stdio: 'inherit',
    windowsHide: false
  })
}

export async function waitForRuntimeServerStarted(configPath: string): Promise<RuntimeServerState> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10000) {
    const state = await readRuntimeServerState(configPath)
    if (state && isProcessAlive(state.pid) && await isServerReady(state)) {
      return state
    }
    await new Promise((resolveWait) => {
      setTimeout(resolveWait, 200)
    })
  }
  throw new Error('codexio server did not become ready')
}

export async function waitForRuntimeServerStopped(configPath: string): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 5000) {
    const state = await readRuntimeServerState(configPath)
    if (!state || !isProcessAlive(state.pid)) {
      return
    }
    const available = await isServerPortAvailable(state.host, state.port)
    if (available) {
      return
    }
    await new Promise((resolveWait) => {
      setTimeout(resolveWait, 100)
    })
  }
}

async function ensureRunningServerStopped(target: RestartTarget, token: string): Promise<boolean> {
  try {
    await requestServerStop(target, token)
    try {
      await waitForServerStopped(target)
      return true
    } catch {
      const terminated = await terminateCodexioPortOwner(target)
      if (!terminated) {
        throw new Error(`server did not stop: ${target.host}:${target.port}`)
      }
      await waitForServerStopped(target)
      return true
    }
  } catch {
    const terminated = await terminateCodexioPortOwner(target)
    if (terminated) {
      await waitForServerStopped(target)
      return true
    }
    return false
  }
}

async function requestServerStop(target: RestartTarget, token: string): Promise<void> {
  const url = `http://${target.host}:${target.port}/api/server/stop`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`
    }
  })
  const result = await response.json() as {
    isFailed?: boolean
    message?: string
  }
  if (!response.ok || result.isFailed) {
    throw new Error(result.message ?? `server stop failed: HTTP ${response.status}`)
  }
}

async function waitForServerStopped(target: RestartTarget): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 5000) {
    const available = await isServerPortAvailable(target.host, target.port)
    if (available) {
      return
    }
    await new Promise((resolveWait) => {
      setTimeout(resolveWait, 100)
    })
  }
  throw new Error(`server did not stop: ${target.host}:${target.port}`)
}

async function isCodexioServer(target: RestartTarget): Promise<boolean> {
  try {
    const response = await fetch(`http://${target.host}:${target.port}/api/status`)
    if (!response.ok) {
      return false
    }
    const result = await response.json() as {
      isFailed?: boolean
      data?: {
        status?: unknown
      }
    }
    return result.isFailed === false && typeof result.data?.status === 'string'
  } catch {
    return false
  }
}

async function isServerReady(state: RuntimeServerState): Promise<boolean> {
  return isCodexioServer({
    host: state.host,
    port: state.port,
    source: 'runtime'
  })
}

async function terminateCodexioPortOwner(target: RestartTarget): Promise<boolean> {
  const codexioServer = await isCodexioServer(target)
  if (!codexioServer) {
    return false
  }
  return terminateServerPortOwner(target)
}

async function terminateServerPortOwner(target: RestartTarget): Promise<boolean> {
  if (process.platform !== 'win32') {
    return false
  }
  const processId = await findWindowsTcpListenPid(target.host, target.port)
  if (!processId || processId === pid) {
    return false
  }
  await execFileAsync('taskkill', [
    '/PID',
    String(processId),
    '/T',
    '/F'
  ])
  return true
}

async function findWindowsTcpListenPid(host: string, port: number): Promise<number | undefined> {
  const result = await execFileAsync('netstat', [
    '-ano',
    '-p',
    'tcp'
  ])
  const normalizedHost = host === 'localhost' ? '127.0.0.1' : host
  const localAddresses = [
    `${normalizedHost}:${port}`,
    `0.0.0.0:${port}`,
    `[::]:${port}`
  ]
  for (const line of result.stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 5) {
      continue
    }
    if (columns[0] !== 'TCP') {
      continue
    }
    if (columns[3] !== 'LISTENING') {
      continue
    }
    if (!localAddresses.includes(columns[1])) {
      continue
    }
    const processId = Number.parseInt(columns[4], 10)
    if (Number.isFinite(processId)) {
      return processId
    }
  }
  return undefined
}

function runtimeServerStatePath(configPath: string): string {
  return join(dirname(configPath), 'server.json')
}

function supervisorStatePath(configPath: string): string {
  return join(dirname(configPath), 'supervisor.json')
}

async function requestSupervisor(state: SupervisorState, action: 'restart' | 'stop'): Promise<void> {
  const response = await fetch(`http://${state.host}:${state.port}/${action}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${state.token}`
    }
  })
  const result = await response.json() as {
    isFailed?: boolean
    message?: string
  }
  if (!response.ok || result.isFailed) {
    throw new Error(result.message ?? `supervisor ${action} failed: HTTP ${response.status}`)
  }
}

async function isSupervisorReady(state: SupervisorState): Promise<boolean> {
  try {
    const response = await fetch(`http://${state.host}:${state.port}/status`, {
      headers: {
        Authorization: `Bearer ${state.token}`
      }
    })
    if (!response.ok) {
      return false
    }
    const result = await response.json() as {
      isFailed?: boolean
      data?: {
        pid?: unknown
      }
    }
    return result.isFailed === false && result.data?.pid === state.pid
  } catch {
    return false
  }
}

function isServerPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolveAvailable, reject) => {
    const probe = createNetServer()
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolveAvailable(false)
        return
      }
      reject(error)
    })
    probe.once('listening', () => {
      probe.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolveAvailable(true)
      })
    })
    probe.listen(port, host)
  })
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch {
    return false
  }
}
