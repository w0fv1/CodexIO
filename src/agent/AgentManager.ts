import { CodexioConfig } from '../ConfigService.js'
import { Result } from '../value/Result.js'
import { ClaudeAgent } from './ClaudeAgent.js'
import { CodexAgent } from './CodexAgent.js'
import { Agent, AgentInput, AgentLoginInProgressError } from './Agent.js'
import { Logger } from '../component/Logger.js'

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

export type AgentManagerCallbacks = {
  send: (text: string) => Promise<Result<null>>
  system?: (text: string) => Promise<Result<null>>
  status: (text: string) => Promise<Result<null>>
}

export type AgentReceiveResult = {
  action?: 'clear'
}

export type AgentFactory = () => Agent

export type AgentManagerOptions = {
  agentFactory?: AgentFactory
}

export class AgentManager {
  private agent?: Agent
  private startTask?: Promise<Result<null>>
  private receiveQueue: Promise<void> = Promise.resolve()
  private state: AgentManagerState = {
    status: 'idle',
    agent: null,
    message: 'agent idle'
  }

  constructor(
    private config: CodexioConfig,
    private readonly toolBaseUrl: string,
    private readonly callbacks: AgentManagerCallbacks,
    private readonly options: AgentManagerOptions = {}
  ) {}

  status(): AgentManagerState {
    return {
      ...this.state
    }
  }

  async login(): Promise<void> {
    Logger.info('agent login requested')
    await this.createAgent().login()
  }

  async start(): Promise<Result<null>> {
    if (this.state.status === 'ready') {
      return Result.success(null)
    }
    if (this.startTask) {
      return this.startTask
    }
    this.startTask = (async () => {
      try {
        const agent = this.agent ?? this.createAgent()
        this.agent = agent
        Logger.info('agent starting', {
          agent: agent.type
        })
        await this.setState({
          status: 'starting',
          agent: agent.type,
          message: `agent starting: ${agent.type}`
        })
        await agent.start(this.config)
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

  async receiveMessage(input: AgentInput): Promise<Result<AgentReceiveResult>> {
    const task = this.receiveQueue.then(() => this.receiveMessageNow(input), () => this.receiveMessageNow(input))
    this.receiveQueue = task.then(() => {}, () => {})
    return task
  }

  async clear(): Promise<Result<AgentReceiveResult>> {
    const task = this.receiveQueue.then(() => this.clearNow(), () => this.clearNow())
    this.receiveQueue = task.then(() => {}, () => {})
    return task
  }

  private async receiveMessageNow(input: AgentInput): Promise<Result<AgentReceiveResult>> {
    if (input.text.trim().length === 0 && (!input.files || input.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    const started = await this.start()
    if (started.isFailed) {
      return Result.fail<AgentReceiveResult>(started.message)
    }
    if (!this.agent) {
      return Result.fail<AgentReceiveResult>('agent not started')
    }
    const received = await (this.callbacks.system ?? this.callbacks.send)(createReceiveConfirmation())
    if (received.isFailed) {
      return Result.fail<AgentReceiveResult>(received.message)
    }
    try {
      Logger.info('agent receive started', {
        agent: this.agent.type,
        length: input.text.length,
        files: input.files?.length ?? 0
      })
      await this.agent.receive(input)
      Logger.info('agent receive accepted', {
        agent: this.agent.type
      })
      return Result.success({})
    } catch (error) {
      const failed = Result.fromError(error)
      Logger.error('agent receive failed', error)
      return Result.fail<AgentReceiveResult>(failed.message)
    }
  }

  private async clearNow(): Promise<Result<AgentReceiveResult>> {
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
      agent: this.agent.type
    })
    await this.agent.clear()
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

  async applyConfig(config: CodexioConfig): Promise<Result<null>> {
    this.config = config
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

  private createAgent(): Agent {
    if (this.options.agentFactory) {
      return this.options.agentFactory()
    }
    const enabledAgents = Object.entries(this.config.agents).filter(([, agentConfig]) => agentConfig.enabled)
    if (enabledAgents.length === 0) {
      throw new Error('agent not found')
    }
    if (enabledAgents.length > 1) {
      throw new Error('only one agent can be enabled')
    }
    const [agentName] = enabledAgents[0]
    const send = async (value: string) => {
      const result = await this.callbacks.send(value)
      if (result.isFailed) {
        throw new Error(result.message)
      }
    }
    const system = async (value: string) => {
      const result = await (this.callbacks.system ?? this.callbacks.send)(value)
      if (result.isFailed) {
        throw new Error(result.message)
      }
    }
    if (agentName === 'codex') {
      return new CodexAgent({
        workspacePath: this.config.workspace.path,
        config: this.config,
        toolBaseUrl: this.toolBaseUrl,
        send,
        system,
        onLoginRequired: async (message) => {
          await this.setState({
            status: 'loginRequired',
            agent: 'codex',
            message
          })
        }
      })
    }
    if (agentName === 'claude') {
      return new ClaudeAgent({
        workspacePath: this.config.workspace.path,
        config: this.config,
        send
      })
    }
    throw new Error(`agent not supported: ${agentName}`)
  }

  private async setState(state: AgentManagerState): Promise<void> {
    this.state = state
    Logger.info('agent state changed', state)
    await this.callbacks.status(state.message)
  }
}
