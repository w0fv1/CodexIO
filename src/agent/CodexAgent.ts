import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { CodexioConfig } from '../ConfigService.js'
import { Agent } from './Agent.js'
import { codexHomePath, codexioRootPath, createAgentEnv } from './AgentEnvironment.js'

const codexEntryPath = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')

export type CodexAgentOptions = {
  workspacePath: string
  config: CodexioConfig
  toolBaseUrl: string
  send: (text: string) => Promise<void>
}

export class CodexAgent implements Agent {
  readonly type = 'codex'
  private hasSession = false
  private started = false
  private child?: ReturnType<typeof execa>
  private generation = 0

  constructor(private readonly options: CodexAgentOptions) {}

  async login(): Promise<void> {
    await execa(process.execPath, [
      codexEntryPath,
      'login',
      '--device-auth'
    ], {
      cwd: this.options.workspacePath,
      env: createAgentEnv(this.options.config),
      stdio: 'inherit'
    })
  }

  async start(_config: CodexioConfig): Promise<void> {
    const source = join(codexioRootPath, 'skills', 'codexio', 'SKILL.md')
    const target = join(codexHomePath, 'skills', 'codexio', 'SKILL.md')
    await mkdir(join(codexHomePath, 'skills', 'codexio'), {
      recursive: true
    })
    await writeFile(target, await readFile(source, 'utf8'), 'utf8')
    this.started = true
    this.hasSession = false
  }

  async receive(text: string): Promise<void> {
    if (!this.started) {
      throw new Error('agent not started')
    }
    const generation = this.generation
    const outputDir = join(tmpdir(), 'codexio')
    await mkdir(outputDir, {
      recursive: true
    })
    const outputPath = join(outputDir, 'codexio.last-message.txt')
    const prompt = [
      'You are running inside Codexio.',
      'An external user is connected through Codexio.',
      'For meaningful progress, blockers, and completion, send concise updates through Codexio HTTP.',
      `Use this PowerShell command shape: $body = @{ text = "progress text" } | ConvertTo-Json -Compress; Invoke-RestMethod -Method Post -Uri "${this.options.toolBaseUrl}/api/message" -ContentType "application/json" -Body $body`,
      'Do not send secrets, tokens, credentials, private keys, or sensitive environment values.',
      'Now handle the user task.',
      '',
      text
    ].join('\n')
    const args = this.hasSession
      ? [
          'exec',
          'resume',
          '--last',
          '--dangerously-bypass-approvals-and-sandbox',
          '--output-last-message',
          outputPath,
          '-'
        ]
      : [
          'exec',
          '--dangerously-bypass-approvals-and-sandbox',
          '--output-last-message',
          outputPath,
          '-'
        ]
    this.hasSession = true
    const child = execa(process.execPath, [
      codexEntryPath,
      ...args
    ], {
      cwd: this.options.workspacePath,
      env: createAgentEnv(this.options.config),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      reject: false
    })
    this.child = child
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString('utf8')
    })
    child.stderr?.on('data', (data: Buffer) => {
      const value = data.toString('utf8')
      const visible = value.trim()
      stderr += value
      if (generation === this.generation && (visible.includes('stdin is not a terminal') || visible.includes('not authenticated'))) {
        void this.options.send(visible)
      }
    })
    child.stdin?.write(prompt)
    child.stdin?.end()
    void child.then(async (result) => {
      try {
        if (generation !== this.generation) {
          return
        }
        if (this.child === child) {
          this.child = undefined
        }
        const lastMessage = await readFile(outputPath, 'utf8')
        const message = lastMessage.trim()
        if (message.length > 0) {
          await this.options.send(message)
        }
        if (result.exitCode !== 0) {
          await this.options.send(`codex exited with code ${result.exitCode}`)
        }
      } catch (error) {
        if (generation !== this.generation) {
          return
        }
        const visibleOutput = stdout.trim() || stderr.trim()
        if (visibleOutput.length > 0) {
          await this.options.send(visibleOutput)
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        await this.options.send(message)
      }
    }).catch(async (error) => {
      if (generation !== this.generation) {
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      await this.options.send(message)
    })
  }

  async clear(): Promise<void> {
    this.generation += 1
    if (this.child) {
      this.child.kill()
      this.child = undefined
    }
    this.hasSession = false
    this.started = true
  }

  async stop(): Promise<void> {
    await this.clear()
    this.started = false
  }
}
