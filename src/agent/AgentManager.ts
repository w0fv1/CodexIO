import { mkdir } from 'node:fs/promises'
import { inject, injectable } from 'inversify'
import { Result } from '../value/Result.js'
import { CodexAgent } from './CodexAgent.js'
import { Agent } from './Agent.js'
import { Logger } from '../component/Logger.js'
import { allIoThreadId, Message } from '../value/Message.js'
import { ClaudeAgent } from './ClaudeAgent.js'
import { Configer } from '../component/Configer.js'
import { ChannelOutputManager } from '../channel/ChannelOutputManager.js'
import { createReceiveConfirmation } from '../util/ReceiveConfirmation.js'
import { AgentManagerStatus } from '../value/AgentManagerStatus.js'

@injectable()
export class AgentManager {
  private statusValue = AgentManagerStatus.Idle

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(ChannelOutputManager) private readonly outputManager: ChannelOutputManager,
    @inject(CodexAgent) private readonly codexAgent: Agent,
    @inject(ClaudeAgent) private readonly claudeAgent: Agent
  ) {
    this.configer.subscribe([
      'agents',
      'proxy',
      'workspace',
      'server'
    ], async () => {
      const applied = await this.applyConfig()
      if (applied.isFailed) {
        await this.outputManager.sendSystem(`Agent 配置应用失败：${applied.message}`, allIoThreadId)
      }
    })
  }

  status(): { status: AgentManagerStatus } {
    return {
      status: this.statusValue
    }
  }

  async start(): Promise<Result<void>> {
    if (this.statusValue === AgentManagerStatus.Online) {
      return Result.successVoid()
    }
    if (this.statusValue === AgentManagerStatus.Connecting) {
      return Result.fail('agent connecting')
    }
    await this.setStatus(AgentManagerStatus.Connecting)

    try {
      Logger.info('agent connecting', {
        agent: (await this.getActiveAgent()).type
      })
      await mkdir(await this.configer.get('workspace.path'), {
        recursive: true
      })
      await (await this.getActiveAgent()).start()
      Logger.info('agent online', {
        agent: (await this.getActiveAgent()).type
      })
      await this.setStatus(AgentManagerStatus.Online)
      return Result.successVoid()
    } catch (error) {
      const failed = Result.fromError(error)
      Logger.error('agent start failed', error)
      await this.stop().catch((stopError) => {
        Logger.warn('agent stop after start failure failed', stopError)
      })
      return Result.fail(failed.message)
    }
  }

  async receiveMessage(input: Message): Promise<Result<void>> {
    if (input.text.trim().length === 0 && (!input.files || input.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    const started = await this.start()
    if (started.isFailed) {
      await this.outputManager.sendSystem(started.message, input.ioThreadId)
      return Result.fail(started.message)
    }
    const agent = await this.getActiveAgent()
    const received = await this.outputManager.sendSystem(createReceiveConfirmation(), input.ioThreadId)
    if (received.isFailed) {
      return Result.fail(received.message)
    }
    try {
      Logger.info('agent receive started', {
        agent: agent.type,
        ioThreadId: input.ioThreadId,
        length: input.text.length,
        files: input.files?.length ?? 0
      })
      await agent.receive(input)
      Logger.info('agent receive accepted', {
        agent: agent.type,
        ioThreadId: input.ioThreadId
      })
      return Result.successVoid()
    } catch (error) {
      const failed = Result.fromError(error)
      Logger.error('agent receive failed', error)
      return Result.fail(failed.message)
    }
  }

  async stop(): Promise<Result<void>> {
    try {
      Logger.info('agent stopping')
      await this.codexAgent.stop()
      await this.claudeAgent.stop()
      await this.setStatus(AgentManagerStatus.Idle)
      return Result.successVoid()
    } catch (error) {
      Logger.error('agent stop failed', error)
      return Result.fromError(error)
    }
  }

  async applyConfig(): Promise<Result<void>> {
    const stopped = await this.stop()
    if (stopped.isFailed) {
      return stopped
    }
    await this.setStatus(AgentManagerStatus.Idle)
    Logger.info('agent config applied')
    return Result.successVoid()
  }

  private async getActiveAgent(): Promise<Agent> {
    const enabledAgents = [
      await this.configer.get('agents.codex.enabled') ? this.codexAgent : undefined,
      await this.configer.get('agents.claude.enabled') ? this.claudeAgent : undefined
    ].filter((agent): agent is Agent => Boolean(agent))
    if (enabledAgents.length === 0) {
      throw new Error('agent not found')
    }
    if (enabledAgents.length > 1) {
      throw new Error('only one agent can be enabled')
    }
    return enabledAgents[0]
  }

  private async setStatus(status: AgentManagerStatus): Promise<void> {
    this.statusValue = status
    Logger.info('agent status changed', {
      status
    })
  }

}
