import { inject, injectable } from 'inversify'
import { AppEvent, ChannelMessageReceivedEvent } from '../../value/Event.js'
import { Result } from '../../value/Result.js'
import { Configer } from '../Configer.js'
import { EventBus } from '../EventBus.js'
import { Logger } from '../Logger.js'
import { ThreadWorkspaceResolver } from '../ThreadWorkspaceResolver.js'
import { Agent } from './Agent.js'
import { CodexAgent } from './CodexAgent.js'
import { EchoAgent } from './EchoAgent.js'

export type AgentManagerStatus = 'idle' | 'online'

@injectable()
export class AgentManager {
  private readonly listener = (event: ChannelMessageReceivedEvent) => this.receive(event)
  private statusValue: AgentManagerStatus = 'idle'
  private started = false
  private subscribed = false

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(EventBus) private readonly eventBus: EventBus,
    @inject(CodexAgent) private readonly codexAgent: Agent,
    @inject(EchoAgent) private readonly echoAgent: Agent,
    @inject(ThreadWorkspaceResolver) private readonly workspaceResolver: ThreadWorkspaceResolver
  ) {}

  status(): { status: AgentManagerStatus } {
    return {
      status: this.statusValue
    }
  }

  async start(): Promise<Result<void>> {
    if (!this.started) {
      this.started = true
      this.eventBus.on(AppEvent.ChannelMessageReceived, this.listener)
    }
    if (!this.subscribed) {
      this.subscribed = true
      this.configer.subscribe([
        'agents',
        'proxy',
        'workspace',
        'server'
      ], async () => {
        const applied = await this.applyConfig()
        if (applied.isFailed) {
          Logger.error('agent config apply failed', new Error(applied.message))
        }
      })
    }
    const agent = await this.getActiveAgent()
    await this.ensureWorkspace()
    const started = await agent.start()
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
    const failures: string[] = []
    if (this.started) {
      this.started = false
      this.eventBus.off(AppEvent.ChannelMessageReceived, this.listener)
    }
    for (const agent of [
      this.codexAgent,
      this.echoAgent
    ]) {
      const stopped = await agent.stop()
      if (stopped.isFailed) {
        failures.push(`${agent.type}: ${stopped.message}`)
      }
    }
    this.statusValue = 'idle'
    if (failures.length > 0) {
      return Result.fail(failures.join('\n'))
    }
    return Result.successVoid()
  }

  async applyConfig(): Promise<Result<void>> {
    const stopped = await this.stop()
    if (stopped.isFailed) {
      return stopped
    }
    return this.start()
  }

  private async receive(event: ChannelMessageReceivedEvent): Promise<Result<void>> {
    const started = await this.start()
    if (started.isFailed) {
      return started
    }
    const agent = await this.getActiveAgent()
    Logger.info('agent receive started', {
      agent: agent.type,
      inputType: event.inputType,
      ioThreadId: event.message.ioThreadId,
      text: event.message.text,
      files: event.message.files?.length ?? 0
    })
    return agent.receive(event)
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
