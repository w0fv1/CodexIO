import { mkdir } from 'node:fs/promises'
import { inject, injectable } from 'inversify'
import { Result } from '../value/Result.js'
import { AgentLoginInProgressError, CodexAgent } from './CodexAgent.js'
import { Agent } from './Agent.js'
import { Logger } from '../component/Logger.js'
import { allIoThreadId, Message } from '../value/Message.js'
import { ClaudeAgent } from './ClaudeAgent.js'
import { Configer } from '../component/Configer.js'
import { ChannelOutputManager } from '../channel/ChannelOutputManager.js'

const receiveConfirmationStarts = [
  '收到',
  '明白',
  '好的',
  '了解',
  '可以',
  '知道了',
  '没问题',
  '我看到了',
  '已收到',
  '行'
]

const receiveConfirmationEnds = [
  '我会马上处理这条消息。',
  '我马上开始处理。',
  '我先看一下怎么处理。',
  '我来判断下一步怎么做。',
  '我会先看上下文再动手。',
  '我想想该怎么处理。',
  '我马上开始看。',
  '我会继续往下处理。',
  '我先确认情况再处理。',
  '我会尽快给出结果。'
]

export function createReceiveConfirmation(): string {
  const start = receiveConfirmationStarts[Math.floor(Math.random() * receiveConfirmationStarts.length)]
  const end = receiveConfirmationEnds[Math.floor(Math.random() * receiveConfirmationEnds.length)]
  return `${start}，${end}`
}

export type AgentManagerState = {
  status: 'idle' | 'starting' | 'ready' | 'loginRequired' | 'failed' | 'stopped'
  agent: string | null
  message: string
}

export type AgentReceiveResult = {
  action?: 'clear'
}

@injectable()
export class AgentManager {
  private agent?: Agent
  private startTask?: Promise<Result<null>>
  private readonly receiveQueues = new Map<string, Promise<void>>()
  private state: AgentManagerState = {
    status: 'idle',
    agent: null,
    message: 'agent idle'
  }

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
        await this.outputManager.sendSystem(`Agent 配置应用失败：${applied.message}`, 'agent', allIoThreadId)
      }
    })
  }

  status(): AgentManagerState {
    return {
      ...this.state
    }
  }

  async login(): Promise<void> {
    Logger.info('agent login requested')
    await this.prepareWorkspace()
    await (await this.createAgent()).login()
  }

  async start(ioThreadId?: string): Promise<Result<null>> {
    if (this.state.status === 'ready') {
      return Result.success(null)
    }
    if (this.startTask) {
      return this.startTask
    }
    this.startTask = (async () => {
      try {
        const agent = this.agent ?? await this.createAgent()
        this.agent = agent
        Logger.info('agent starting', {
          agent: agent.type
        })
        await this.setState({
          status: 'starting',
          agent: agent.type,
          message: `agent starting: ${agent.type}`
        })
        await this.prepareWorkspace()
        await agent.start(ioThreadId)
        this.agent = agent
        Logger.info('agent ready', {
          agent: agent.type
        })
        await this.setState({
          status: 'ready',
          agent: agent.type,
          message: `agent ready: ${agent.type}`
        })
        return Result.success(null)
      } catch (error) {
        const failed = Result.fromError(error)
        if (error instanceof AgentLoginInProgressError) {
          Logger.warn('agent login required', {
            message: failed.message
          })
          await this.setState({
            status: 'loginRequired',
            agent: this.agent?.type ?? null,
            message: failed.message
          })
          return Result.fail(failed.message)
        }
        Logger.error('agent start failed', error)
        await this.agent?.stop().catch((stopError) => {
          Logger.warn('agent stop after start failure failed', stopError)
        })
        this.agent = undefined
        await this.setState({
          status: 'failed',
          agent: null,
          message: failed.message
        })
        return Result.fail(failed.message)
      } finally {
        this.startTask = undefined
      }
    })()
    return this.startTask
  }

  async receiveMessage(input: Message): Promise<Result<AgentReceiveResult>> {
    const task = this.threadQueue(input.ioThreadId).then(() => this.receiveMessageNow(input), () => this.receiveMessageNow(input))
    this.saveThreadQueue(input.ioThreadId, task)
    return task
  }

  async clear(ioThreadId: string): Promise<Result<AgentReceiveResult>> {
    const task = this.threadQueue(ioThreadId).then(() => this.clearNow(ioThreadId), () => this.clearNow(ioThreadId))
    this.saveThreadQueue(ioThreadId, task)
    return task
  }

  private async receiveMessageNow(input: Message): Promise<Result<AgentReceiveResult>> {
    if (input.text.trim().length === 0 && (!input.files || input.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    const started = await this.start(input.ioThreadId)
    if (started.isFailed) {
      return Result.fail<AgentReceiveResult>(started.message)
    }
    if (!this.agent) {
      return Result.fail<AgentReceiveResult>('agent not started')
    }
    const received = await this.outputManager.sendSystem(createReceiveConfirmation(), 'agent', input.ioThreadId)
    if (received.isFailed) {
      return Result.fail<AgentReceiveResult>(received.message)
    }
    try {
      Logger.info('agent receive started', {
        agent: this.agent.type,
        ioThreadId: input.ioThreadId,
        length: input.text.length,
        files: input.files?.length ?? 0
      })
      await this.agent.receive(input)
      Logger.info('agent receive accepted', {
        agent: this.agent.type,
        ioThreadId: input.ioThreadId
      })
      return Result.success({})
    } catch (error) {
      const failed = Result.fromError(error)
      Logger.error('agent receive failed', error)
      return Result.fail<AgentReceiveResult>(failed.message)
    }
  }

  private async clearNow(ioThreadId: string): Promise<Result<AgentReceiveResult>> {
    if (this.state.status !== 'ready') {
      await this.agent?.stop().catch((error) => {
        Logger.warn('agent stop during clear reset failed', error)
      })
      this.agent = undefined
      await this.setState({
        status: 'idle',
        agent: null,
        message: 'agent idle'
      })
      return Result.success({
        action: 'clear'
      })
    }
    const started = await this.start()
    if (started.isFailed) {
      return Result.fail<AgentReceiveResult>(started.message)
    }
    if (!this.agent) {
      return Result.fail<AgentReceiveResult>('agent not started')
    }
    Logger.info('agent clear requested', {
      agent: this.agent.type,
      ioThreadId
    })
    await this.agent.clear(ioThreadId)
    await this.setState({
      status: 'ready',
      agent: this.agent.type,
      message: `agent ready: ${this.agent.type}`
    })
    return Result.success({
      action: 'clear'
    })
  }

  async stop(): Promise<Result<null>> {
    try {
      Logger.info('agent stopping', {
        agent: this.agent?.type ?? null
      })
      await this.agent?.stop()
      this.agent = undefined
      await this.setState({
        status: 'stopped',
        agent: null,
        message: 'agent stopped'
      })
      return Result.success(null)
    } catch (error) {
      Logger.error('agent stop failed', error)
      return Result.fromError(error)
    }
  }

  async applyConfig(): Promise<Result<null>> {
    const stopped = await this.stop()
    if (stopped.isFailed) {
      return stopped
    }
    await this.setState({
      status: 'idle',
      agent: null,
      message: 'agent idle'
    })
    Logger.info('agent config applied')
    return Result.success(null)
  }

  private async createAgent(): Promise<Agent> {
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

  private async prepareWorkspace(): Promise<void> {
    await mkdir(await this.configer.get('workspace.path'), {
      recursive: true
    })
  }

  private async setState(state: AgentManagerState): Promise<void> {
    this.state = state
    Logger.info('agent state changed', state)
  }

  private threadQueue(ioThreadId: string): Promise<void> {
    return this.receiveQueues.get(ioThreadId) ?? Promise.resolve()
  }

  private saveThreadQueue(ioThreadId: string, task: Promise<unknown>): void {
    const queue = task.then(() => {}, () => {})
    this.receiveQueues.set(ioThreadId, queue)
    void queue.finally(() => {
      if (this.receiveQueues.get(ioThreadId) === queue) {
        this.receiveQueues.delete(ioThreadId)
      }
    })
  }

}
