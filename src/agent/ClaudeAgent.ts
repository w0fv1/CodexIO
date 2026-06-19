import { execa } from 'execa'
import { createRequire } from 'node:module'
import { CodexioConfig } from '../ConfigService.js'
import { Agent } from './Agent.js'
import { createAgentEnv } from './AgentEnvironment.js'
import { Logger } from '../component/Logger.js'

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
    Logger.info('claude agent starting', {
      cwd: this.options.workspacePath
    })
    const child = execa(process.execPath, [
      claudeEntryPath,
      '--dangerously-skip-permissions',
      '--permission-mode',
      'bypassPermissions'
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
        Logger.info('claude stdout received', {
          length: text.length
        })
        void this.options.send(text)
      }
    })
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf8').trim()
      if (text.length > 0) {
        Logger.warn('claude stderr received', {
          text
        })
        void this.options.send(text)
      }
    })
    void child.then((result) => {
      Logger.info('claude agent exited', {
        exitCode: result.exitCode
      })
      this.child = undefined
    }, (error) => {
      Logger.error('claude agent failed', error)
      this.child = undefined
    })
    this.child = child
    Logger.info('claude agent ready')
  }

  async receive(text: string): Promise<void> {
    if (!this.child) {
      throw new Error('agent not started')
    }
    Logger.info('claude receive started', {
      length: text.length
    })
    this.child.stdin?.write(`${text}\n`)
  }

  async restart(): Promise<void> {
    Logger.info('claude agent restart requested')
    await this.clear()
  }

  async clear(): Promise<void> {
    Logger.info('claude agent clearing')
    await this.stop()
    await this.start(this.options.config)
  }

  async stop(): Promise<void> {
    if (this.child) {
      Logger.info('claude agent stopping')
      this.child.kill()
      this.child = undefined
    }
  }
}
