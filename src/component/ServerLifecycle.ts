import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { argv, execPath, pid } from 'node:process'
import { inject, injectable, optional } from 'inversify'
import { z } from 'zod'
import { Configer } from './Configer.js'
import { Result } from '../value/Result.js'
import { ChannelManager } from '../channel/ChannelManager.js'
import { isServerPortAvailable } from '../util/Network.js'

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
  env?: NodeJS.ProcessEnv
}

export type ServeProcessSpecOptions = {
  supervisorPid?: number
}

type SupervisorAction = 'restart' | 'stop'

@injectable()
export class SupervisorClient {
  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(ChannelManager) @optional() private readonly channelManager?: ChannelManager
  ) {
    if (!this.channelManager) {
      return
    }
    this.configer.subscribe([
      'server',
      'channels.web'
    ], () => {
      setImmediate(() => {
        void this.restart().then(() => {
        }).catch(async (error) => {
          const failed = Result.fromError(error)
          await this.channelManager?.sendSystem(`Codexio 重启失败：${failed.message}`)
        })
      })
    })
  }

  async restart(): Promise<SupervisorState> {
    const supervisor = await this.requireRunning()
    await requestSupervisor(supervisor, 'restart')
    return supervisor
  }

  async initial(): Promise<void> {
    await writeRuntimeServerState(this.configer.path, {
      pid,
      host: await this.configer.get('server.host'),
      port: await this.configer.get('server.port'),
      startedAt: new Date().toISOString()
    })
  }

  async stop(): Promise<boolean> {
    const supervisor = await readRunningSupervisorState(this.configer.path)
    if (!supervisor) {
      const runtimeStopped = await stopRuntimeServer(this.configer)
      await this.clearState()
      return runtimeStopped
    }
    await requestSupervisor(supervisor, 'stop')
    await waitForSupervisorStopped(this.configer.path)
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

  async clearRuntime(): Promise<void> {
    await removeRuntimeServerState(this.configer.path)
  }
}

async function stopRuntimeServer(configer: Configer): Promise<boolean> {
  const state = await readRuntimeServerState(configer.path)
  const targets = uniqueRuntimeTargets([
    state,
    {
      host: await configer.get('server.host'),
      port: await configer.get('server.port')
    }
  ])
  const token = await configer.get('server.token')
  for (const target of targets) {
    if (await requestRuntimeServerStop(target, token)) {
      return true
    }
  }
  return false
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
  if (!state) {
    return undefined
  }
  if (!isProcessAlive(state.pid)) {
    await removeSupervisorState(configPath)
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

export function createServeProcessSpec(configPath: string, entryPath = argv[1], options: ServeProcessSpecOptions = {}, rootPath = process.cwd()): ServeProcessSpec {
  const serveArgs = [
    'serve',
    '--config',
    configPath
  ]
  if (entryPath?.endsWith('.ts')) {
    const tsxPackagePath = require.resolve('tsx/package.json')
    const tsxCliPath = join(dirname(tsxPackagePath), 'dist', 'cli.mjs')
    return {
      command: execPath,
      args: [
        tsxCliPath,
        relative(rootPath, entryPath),
        ...serveArgs
      ],
      cwd: rootPath,
      ...createServeProcessEnvField(options)
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
    cwd: rootPath,
    ...createServeProcessEnvField(options)
  }
}

export function spawnServeProcess(configPath: string, rootPath: string, options: ServeProcessSpecOptions = {}) {
  const spec = createServeProcessSpec(configPath, argv[1], options, rootPath)
  return spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
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

export async function waitForSupervisorStopped(configPath: string): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 5000) {
    const state = await readSupervisorState(configPath)
    if (!state || !isProcessAlive(state.pid)) {
      await removeSupervisorState(configPath)
      return
    }
    if (await isServerPortAvailable(state.host, state.port)) {
      await removeSupervisorState(configPath)
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

async function requestRuntimeServerStop(target: Pick<RuntimeServerState, 'host' | 'port'>, token: string): Promise<boolean> {
  try {
    const status = await fetch(`http://${target.host}:${target.port}/api/status`)
    if (!status.ok) {
      return false
    }
    const statusResult = await status.json() as {
      isFailed?: boolean
    }
    if (statusResult.isFailed !== false) {
      return false
    }
    await fetch(`http://${target.host}:${target.port}/api/server/stop`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`
      }
    })
    await waitForRuntimeServerStoppedByTarget(target)
    return true
  } catch {
    return false
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
  return join(runtimeStateRoot(_configPath), 'server.json')
}

export function supervisorStatePath(_configPath: string): string {
  return join(runtimeStateRoot(_configPath), 'supervisor.json')
}

function runtimeStateRoot(_configPath: string): string {
  return join(process.cwd(), '.codexio', 'state')
}

async function waitForRuntimeServerStoppedByTarget(target: Pick<RuntimeServerState, 'host' | 'port'>): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 5000) {
    if (await isServerPortAvailable(target.host, target.port)) {
      return
    }
    await delay(100)
  }
}

function uniqueRuntimeTargets(targets: Array<Pick<RuntimeServerState, 'host' | 'port'> | undefined>): Array<Pick<RuntimeServerState, 'host' | 'port'>> {
  const seen = new Set<string>()
  const result: Array<Pick<RuntimeServerState, 'host' | 'port'>> = []
  for (const target of targets) {
    if (!target) {
      continue
    }
    const key = `${target.host}:${target.port}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(target)
  }
  return result
}

export function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch {
    return false
  }
}

function createServeProcessEnv(options: ServeProcessSpecOptions): NodeJS.ProcessEnv | undefined {
  if (!options.supervisorPid) {
    return undefined
  }
  return {
    ...process.env,
    CODEXIO_SUPERVISOR_PID: String(options.supervisorPid)
  }
}

function createServeProcessEnvField(options: ServeProcessSpecOptions): Pick<ServeProcessSpec, 'env'> | Record<string, never> {
  const env = createServeProcessEnv(options)
  return env ? {
    env
  } : {}
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds)
  })
}
