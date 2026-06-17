import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { delimiter, join, resolve } from 'node:path'
import { AgentConfig } from '../config/ConfigSchema.js'
import { AgentRuntime, RuntimeHandle, RuntimeStartInput } from './RuntimeManager.js'

export type ProcessRuntimeOptions = {
  type: string
  agent: AgentConfig
  onMessage: (runtimeId: string, text: string) => Promise<void>
}

export class ProcessRuntime implements AgentRuntime {
  readonly type: string
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>()

  constructor(private readonly options: ProcessRuntimeOptions) {
    this.type = options.type
  }

  async start(input: RuntimeStartInput): Promise<RuntimeHandle> {
    const env = {
      ...input.env,
      ...this.options.agent.env
    }
    const binPaths = [
      join(process.cwd(), 'node_modules', '.bin'),
      resolve(process.cwd(), 'node_modules', '.bin')
    ]
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
    env[pathKey] = `${binPaths.join(delimiter)}${delimiter}${env[pathKey] ?? ''}`
    const child = spawn(this.options.agent.command, this.options.agent.args, {
      cwd: input.workspacePath,
      env,
      shell: process.platform === 'win32'
    })
    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString('utf8').trim()
      if (text.length > 0) {
        void this.options.onMessage(input.runtimeId, text)
      }
    })
    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString('utf8').trim()
      if (text.length > 0) {
        void this.options.onMessage(input.runtimeId, text)
      }
    })
    child.on('exit', () => {
      this.processes.delete(input.runtimeId)
    })
    this.processes.set(input.runtimeId, child)
    return {
      runtimeId: input.runtimeId,
      pid: child.pid
    }
  }

  async send(input: { runtimeId: string; text: string }): Promise<void> {
    const child = this.processes.get(input.runtimeId)
    if (!child) {
      throw new Error(`runtime not started: ${input.runtimeId}`)
    }
    child.stdin.write(`${input.text}\n`)
  }

  async stop(runtimeId: string): Promise<void> {
    const child = this.processes.get(runtimeId)
    if (child) {
      child.kill()
      this.processes.delete(runtimeId)
    }
  }
}
