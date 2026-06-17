import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { AgentConfig } from '../config/ConfigSchema.js'
import { AgentRuntime, RuntimeHandle, RuntimeStartInput } from './RuntimeManager.js'

export type CodexExecRuntimeOptions = {
  agent: AgentConfig
  toolBaseUrl: string
  onMessage: (runtimeId: string, text: string) => Promise<void>
}

type CodexRuntimeState = {
  workspacePath: string
  env: Record<string, string>
  hasSession: boolean
  model?: string
}

export class CodexExecRuntime implements AgentRuntime {
  readonly type = 'codex'
  private readonly states = new Map<string, CodexRuntimeState>()

  constructor(private readonly options: CodexExecRuntimeOptions) {}

  async start(input: RuntimeStartInput): Promise<RuntimeHandle> {
    this.states.set(input.runtimeId, {
      workspacePath: input.workspacePath,
      env: input.env,
      hasSession: false,
      model: input.model
    })
    return {
      runtimeId: input.runtimeId
    }
  }

  async send(input: { runtimeId: string; text: string }): Promise<void> {
    const state = this.states.get(input.runtimeId)
    if (!state) {
      throw new Error(`runtime not started: ${input.runtimeId}`)
    }
    const outputDir = join(tmpdir(), 'codexio')
    await mkdir(outputDir, {
      recursive: true
    })
    const outputPath = join(outputDir, `${input.runtimeId}.last-message.txt`)
    const prompt = this.buildPrompt(input.runtimeId, input.text)
    const args = this.buildArgs(state.hasSession, outputPath, state.model)
    state.hasSession = true
    const child = spawn(this.options.agent.command, args, {
      cwd: state.workspacePath,
      env: this.buildEnv(state.env),
      shell: process.platform === 'win32'
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf8')
    })
    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString('utf8').trim()
      stderr += data.toString('utf8')
      if (this.isUserVisibleError(text)) {
        void this.options.onMessage(input.runtimeId, text)
      }
    })
    child.stdin.write(prompt)
    child.stdin.end()
    child.on('exit', async (code) => {
      try {
        const lastMessage = await readFile(outputPath, 'utf8')
        const text = lastMessage.trim()
        if (text.length > 0) {
          await this.options.onMessage(input.runtimeId, text)
        }
        if (code && code !== 0) {
          await this.options.onMessage(input.runtimeId, `codex exited with code ${code}`)
        }
      } catch (error) {
        const visibleOutput = stdout.trim() || stderr.trim()
        if (visibleOutput.length > 0) {
          await this.options.onMessage(input.runtimeId, visibleOutput)
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        await this.options.onMessage(input.runtimeId, message)
      }
    })
  }

  async stop(runtimeId: string): Promise<void> {
    this.states.delete(runtimeId)
  }

  private buildArgs(hasSession: boolean, outputPath: string, model?: string): string[] {
    const modelArgs = model
      ? [
          '-m',
          model
        ]
      : []
    if (hasSession) {
      return [
        'exec',
        'resume',
        '--last',
        ...this.options.agent.args,
        ...modelArgs,
        '--output-last-message',
        outputPath,
        '-'
      ]
    }
    return [
      'exec',
      ...this.options.agent.args,
      ...modelArgs,
      '--output-last-message',
      outputPath,
      '-'
    ]
  }

  private buildEnv(env: Record<string, string>): Record<string, string> {
    const nextEnv = {
      ...env,
      ...this.options.agent.env
    }
    const binPaths = [
      join(process.cwd(), 'node_modules', '.bin'),
      resolve(process.cwd(), 'node_modules', '.bin')
    ]
    const pathKey = Object.keys(nextEnv).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
    nextEnv[pathKey] = `${binPaths.join(delimiter)}${delimiter}${nextEnv[pathKey] ?? ''}`
    return nextEnv
  }

  private buildPrompt(runtimeId: string, text: string): string {
    return [
      'You are running inside Codexio.',
      'An external user is connected through the Codexio web adapter.',
      'For meaningful progress, blockers, and completion, send concise updates through Codexio send_message.',
      `Use this PowerShell command shape: $body = @{ text = "progress text" } | ConvertTo-Json -Compress; Invoke-RestMethod -Method Post -Uri "${this.options.toolBaseUrl}/api/tools/send_message" -Headers @{ "x-codexio-runtime-id" = "${runtimeId}" } -ContentType "application/json" -Body $body`,
      'Do not send secrets, tokens, credentials, private keys, or sensitive environment values.',
      'Now handle the user task.',
      '',
      text
    ].join('\n')
  }

  private isUserVisibleError(text: string): boolean {
    if (text.includes('stdin is not a terminal')) {
      return true
    }
    if (text.includes('not authenticated')) {
      return true
    }
    return false
  }
}
