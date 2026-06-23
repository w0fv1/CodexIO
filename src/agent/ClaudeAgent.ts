import { execa } from 'execa'
import { createRequire } from 'node:module'
import { inject, injectable } from 'inversify'
import { Agent } from './Agent.js'
import { createProcessEnv } from '../util/ProcessEnvironment.js'
import { Logger } from '../component/Logger.js'
import { Message } from '../value/Message.js'
import { AgentManagerCallbacksId } from '../ComponentIdentifier.js'
import type { AgentManagerCallbacks } from './AgentManager.js'
import { Configer } from '../component/Configer.js'

const require = createRequire(import.meta.url)
const claudeEntryPath = require.resolve('@anthropic-ai/claude-code/cli-wrapper.cjs')

type ClaudeThread = {
  ioThreadId: string
  child: ReturnType<typeof execa>
}

@injectable()
export class ClaudeAgent implements Agent {
  readonly type = 'claude'
  private started = false
  private readonly threads = new Map<string, ClaudeThread>()

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(AgentManagerCallbacksId) private readonly callbacks: AgentManagerCallbacks
  ) {}

  async login(): Promise<void> {
    throw new Error('Claude login does not expose a console-only login flow')
  }

  async start(): Promise<void> {
    this.started = true
  }

  private async startThread(ioThreadId: string): Promise<ClaudeThread> {
    const cwd = await this.configer.get('workspace.path')
    const proxyEnabled = await this.configer.get('proxy.enabled')
    const proxyHost = await this.configer.get('proxy.host')
    const proxyPort = await this.configer.get('proxy.port')
    const serverHost = await this.configer.get('server.host')
    Logger.info('claude agent starting', {
      ioThreadId,
      cwd
    })
    const child = execa(process.execPath, [
      claudeEntryPath,
      '--dangerously-skip-permissions',
      '--permission-mode',
      'bypassPermissions'
    ], {
      cwd,
      env: createProcessEnv(
        undefined,
        undefined,
        proxyEnabled ? `http://${proxyHost}:${proxyPort}` : undefined,
        proxyEnabled ? [
          'localhost',
          '127.0.0.1',
          '::1',
          serverHost
        ] : []
      ),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      reject: false
    })
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString('utf8').trim()
      if (text.length > 0) {
        Logger.info('claude stdout received', {
          ioThreadId,
          length: text.length
        })
        void this.send({
          ioThreadId,
          role: 'agent',
          text,
          createdAt: Date.now()
        })
      }
    })
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf8').trim()
      if (text.length > 0) {
        Logger.warn('claude stderr received', {
          ioThreadId,
          text
        })
        void this.send({
          ioThreadId,
          role: 'agent',
          text,
          createdAt: Date.now()
        })
      }
    })
    void child.then((result) => {
      Logger.info('claude agent exited', {
        ioThreadId,
        exitCode: result.exitCode
      })
      if (this.threads.get(ioThreadId)?.child === child) {
        this.threads.delete(ioThreadId)
      }
    }, (error) => {
      Logger.error('claude agent failed', error)
      if (this.threads.get(ioThreadId)?.child === child) {
        this.threads.delete(ioThreadId)
      }
    })
    const thread = {
      ioThreadId,
      child
    }
    this.threads.set(ioThreadId, thread)
    Logger.info('claude agent ready', {
      ioThreadId
    })
    return thread
  }

  async receive(input: Message): Promise<void> {
    if (!this.started) {
      throw new Error('agent not started')
    }
    const thread = this.threads.get(input.ioThreadId) ?? await this.startThread(input.ioThreadId)
    Logger.info('claude receive started', {
      ioThreadId: input.ioThreadId,
      length: input.text.length,
      files: input.files?.length ?? 0
    })
    const fileText = (input.files ?? []).map((file) => file.path).join('\n')
    const text = fileText.length > 0 ? `${input.text}\n\nFiles:\n${fileText}` : input.text
    thread.child.stdin?.write(`${text}\n`)
  }

  async clear(ioThreadId: string): Promise<void> {
    Logger.info('claude agent clearing', {
      ioThreadId
    })
    const thread = this.threads.get(ioThreadId)
    if (thread) {
      thread.child.kill()
      this.threads.delete(ioThreadId)
    }
  }

  async stop(): Promise<void> {
    if (this.threads.size > 0) {
      Logger.info('claude agent stopping', {
        threads: this.threads.size
      })
      for (const thread of this.threads.values()) {
        thread.child.kill()
      }
      this.threads.clear()
    }
    this.started = false
  }

  private async send(message: Message): Promise<void> {
    const result = await this.callbacks.send(message)
    if (result.isFailed) {
      throw new Error(result.message)
    }
  }

}
