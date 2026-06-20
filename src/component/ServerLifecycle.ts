import { spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { argv, execPath } from 'node:process'
import { z } from 'zod'
import { codexioRootPath } from '../AppMetadata.js'
import { Configer } from '../config/Configer.js'

const require = createRequire(import.meta.url)

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

export type ServeProcessSpec = {
  command: string
  args: string[]
  cwd: string
}

export type ServeProcessSpecOptions = {
  autoPort?: boolean
}

type SupervisorAction = 'restart' | 'stop'

export class SupervisorClient {
  private readonly configer: Configer

  constructor(configPath?: string) {
    this.configer = new Configer(configPath)
  }

  async restart(): Promise<SupervisorState> {
    const supervisor = await this.requireRunning()
    await requestSupervisor(supervisor, 'restart')
    return supervisor
  }

  async stop(): Promise<boolean> {
    const supervisor = await readRunningSupervisorState(this.configer.path)
    if (!supervisor) {
      await this.clearState()
      return false
    }
    await requestSupervisor(supervisor, 'stop')
    return true
  }

  async requireRunning(): Promise<SupervisorState> {
    const supervisor = await readRunningSupervisorState(this.configer.path)
    if (!supervisor) {
      throw new Error('Codexio supervisor 未运行，请用 start.cmd 启动后再重启。')
    }
    return supervisor
  }

  async clearState(): Promise<void> {
    await removeSupervisorState(this.configer.path)
    await removeRuntimeServerState(this.configer.path)
  }
}

export async function stopServer(configPath?: string): Promise<boolean> {
  return new SupervisorClient(configPath).stop()
}

export async function restartServer(configPath?: string): Promise<SupervisorState> {
  return new SupervisorClient(configPath).restart()
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
  await writeState(runtimeServerStatePath(configPath), RuntimeServerStateSchema.parse(state))
}

export async function readRuntimeServerState(configPath: string): Promise<RuntimeServerState | undefined> {
  return readState(runtimeServerStatePath(configPath), RuntimeServerStateSchema)
}

export async function writeSupervisorState(configPath: string, state: SupervisorState): Promise<void> {
  await writeState(supervisorStatePath(configPath), SupervisorStateSchema.parse(state))
}

export async function readSupervisorState(configPath: string): Promise<SupervisorState | undefined> {
  return readState(supervisorStatePath(configPath), SupervisorStateSchema)
}

export async function readRunningSupervisorState(configPath: string): Promise<SupervisorState | undefined> {
  const state = await readSupervisorState(configPath)
  if (!state || !isProcessAlive(state.pid)) {
    return undefined
  }
  if (!await isSupervisorReady(state)) {
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
    const tsxPackagePath = require.resolve('tsx/package.json')
    const tsxCliPath = join(dirname(tsxPackagePath), 'dist', 'cli.mjs')
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
    await delay(200)
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
    if (await isServerPortAvailable(state.host, state.port)) {
      return
    }
    await delay(100)
  }
}

async function writeState(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), {
    recursive: true
  })
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
}

async function readState<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return undefined
  }
}

async function requestSupervisor(state: SupervisorState, action: SupervisorAction): Promise<void> {
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

async function isServerReady(state: RuntimeServerState): Promise<boolean> {
  try {
    const response = await fetch(`http://${state.host}:${state.port}/api/status`)
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

export function runtimeServerStatePath(_configPath: string): string {
  return join(runtimeStateRoot(), 'server.json')
}

export function supervisorStatePath(_configPath: string): string {
  return join(runtimeStateRoot(), 'supervisor.json')
}

function runtimeStateRoot(): string {
  return join(codexioRootPath, '.codexio', 'state')
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds)
  })
}
