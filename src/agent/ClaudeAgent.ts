import { execa } from 'execa'
import { createRequire } from 'node:module'
import { CodexioConfig } from '../ConfigService.js'
import { Agent } from './Agent.js'
import { createAgentEnv } from './AgentEnvironment.js'

const require = createRequire(import.meta.url)
const claudeEntryPath = require.resolve('@anthropic-ai/claude-code/cli-wrapper.cjs')

export type ClaudeAgentOptions = {
  workspacePath: string
  config: CodexioConfig
  send: (text: string) => Promise<void>
}

export class ClaudeAgent implements Agent {
  readonly type = 'claude'
  private child?: ReturnType<typeof execa>

  constructor(private readonly options: ClaudeAgentOptions) {}

  async login(): Promise<void> {
    throw new Error('Claude login does not expose a console-only login flow')
  }

  async start(_config: CodexioConfig): Promise<void> {
    const child = execa(process.execPath, [
      claudeEntryPath
    ], {
      cwd: this.options.workspacePath,
      env: createAgentEnv(this.options.config),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      reject: false
    })
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString('utf8').trim()
      if (text.length > 0) {
        void this.options.send(text)
      }
    })
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf8').trim()
      if (text.length > 0) {
        void this.options.send(text)
      }
    })
    void child.then(() => {
      this.child = undefined
    }, () => {
      this.child = undefined
    })
    this.child = child
  }

  async receive(text: string): Promise<void> {
    if (!this.child) {
      throw new Error('agent not started')
    }
    this.child.stdin?.write(`${text}\n`)
  }

  async clear(): Promise<void> {
    await this.stop()
    await this.start(this.options.config)
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.kill()
      this.child = undefined
    }
  }
}
