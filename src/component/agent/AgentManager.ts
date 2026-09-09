import { inject, injectable } from 'inversify'
import { Result } from '../../value/Result.js'
import { Message } from '../../value/Message.js'
import { Configer, ConfigSubscription } from '../Configer.js'
import { Logger } from '../Logger.js'
import { ThreadWorkspaceResolver } from '../ThreadWorkspaceResolver.js'
import { ChannelOutputManager } from '../channelo/ChannelOutputManager.js'
import { MessageFileResolver } from '../MessageFileResolver.js'
import { Agent, AgentOutputReceiver } from './Agent.js'
import { CodexAgent } from './CodexAgent.js'
import { EchoAgent } from './EchoAgent.js'

export type AgentManagerStatus = 'idle' | 'online'

@injectable()
export class AgentManager implements AgentOutputReceiver {
  private statusValue: AgentManagerStatus = 'idle'
  private subscription?: ConfigSubscription
  private readonly turnWaiters = new Map<string, (error?: string) => void>()

  async runUntilComplete(ioThreadId: string, dispatch: () => Promise<void>, signal: AbortSignal): Promise<void> {
    if (this.turnWaiters.has(ioThreadId)) throw new Error('Thread already has pending work')
    let settle!: (error?: string) => void
    const completed = new Promise<void>((resolve, reject) => {
      settle = error => error ? reject(new Error(error)) : resolve()
    })
    const abort = () => settle('Agent listener stopped')
    this.turnWaiters.set(ioThreadId, settle)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      await Promise.all([dispatch(), completed])
    } finally {
      signal.removeEventListener('abort', abort)
      this.turnWaiters.delete(ioThreadId)
    }
  }

  completeAgentTurn(ioThreadId: string, error?: string): void {
    this.turnWaiters.get(ioThreadId)?.(error)
  }

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(CodexAgent) private readonly codexAgent: Agent,
    @inject(EchoAgent) private readonly echoAgent: Agent,
    @inject(ThreadWorkspaceResolver) private readonly workspaceResolver: ThreadWorkspaceResolver,
    @inject(MessageFileResolver) private readonly fileResolver: MessageFileResolver,
    @inject(ChannelOutputManager) private readonly outputManager: ChannelOutputManager
  ) {}

  status(): { status: AgentManagerStatus } {
    return {
      status: this.statusValue
    }
  }

  async start(): Promise<Result<void>> {
    if (this.statusValue === 'online') {
      return Result.successVoid()
    }
    if (!this.subscription) {
      this.subscription = this.configer.subscribe([
        'agents',
        'proxy',
        'app.workspace',
        'server',
        'channeli.userver.secret', 'channeli.userver.mcpUrl', 'channeli.userver.baseUrl', 'channeli.userver.websiteId'
      ], async () => {
        const applied = await this.applyConfig()
        if (applied.isFailed) {
          Logger.error('agent config apply failed', new Error(applied.message))
        }
      })
    }
    const agent = await this.getActiveAgent()
    await this.ensureWorkspace()
    const started = await agent.start(this)
    if (started.isFailed) {
      return started
    }
    this.statusValue = 'online'
    Logger.info('agent manager online', {
      agent: agent.type
    })
    return Result.successVoid()
  }

  async stop(): Promise<Result<void>> {
    this.subscription?.dispose()
    this.subscription = undefined
    const result = await this.stopAgents()
    this.statusValue = 'idle'
    return result
  }

  private async applyConfig(): Promise<Result<void>> {
    const stopped = await this.stopAgents()
    if (stopped.isFailed) {
      return stopped
    }
    const agent = await this.getActiveAgent()
    await this.ensureWorkspace()
    const started = await agent.start(this)
    if (started.isFailed) {
      return started
    }
    this.statusValue = 'online'
    return Result.successVoid()
  }

  private async stopAgents(): Promise<Result<void>> {
    const failures: string[] = []
    for (const agent of [
      this.codexAgent,
      this.echoAgent
    ]) {
      const stopped = await agent.stop()
      if (stopped.isFailed) {
        failures.push(`${agent.type}: ${stopped.message}`)
      }
    }
    if (failures.length > 0) {
      return Result.fail(failures.join('\n'))
    }
    return Result.successVoid()
  }

  async receive(message: Message): Promise<Result<void>> {
    const started = await this.start()
    if (started.isFailed) {
      return started
    }
    const agent = await this.getActiveAgent()
    Logger.info('agent receive started', {
      agent: agent.type,
      ioThreadId: message.thread.id,
      text: message.text,
      files: message.files?.length ?? 0
    })
    return agent.receive(message)
  }

  async receiveAgentOutput(message: Message): Promise<Result<void>> {
    const workspacePath = await this.workspaceResolver.resolve(message.thread.id)
    const resolved = await this.fileResolver.resolve(message, workspacePath)
    return this.outputManager.send(resolved)
  }

  private async getActiveAgent(): Promise<Agent> {
    if (await this.configer.get('agents.codex.enabled')) {
      return this.codexAgent
    }
    if (await this.configer.get('agents.echo.enabled')) {
      return this.echoAgent
    }
    throw new Error('one agent must be enabled')
  }

  private async ensureWorkspace(): Promise<void> {
    await this.workspaceResolver.ensureBase()
  }
}
