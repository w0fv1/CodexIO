import { CodexioConfig } from '../ConfigService.js'
import { Result } from '../Result.js'
import { ClaudeAgent } from './ClaudeAgent.js'
import { CodexAgent } from './CodexAgent.js'
import { EchoAgent } from './EchoAgent.js'
import { Agent } from './Agent.js'

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
  status: 'idle' | 'starting' | 'ready' | 'failed' | 'stopped'
  agent: string | null
  message: string
}

export type AgentManagerCallbacks = {
  send: (text: string) => Promise<Result<null>>
  status: (text: string) => Promise<Result<null>>
}

export type AgentReceiveResult = {
  action?: 'clear'
}

export class AgentManager {
  private agent?: Agent
  private startTask?: Promise<Result<null>>
  private state: AgentManagerState = {
    status: 'idle',
    agent: null,
    message: 'agent idle'
  }

  constructor(
    private readonly config: CodexioConfig,
    private readonly toolBaseUrl: string,
    private readonly callbacks: AgentManagerCallbacks
  ) {}

  status(): AgentManagerState {
    return {
      ...this.state
    }
  }

  async login(): Promise<void> {
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
        const agent = this.createAgent()
        await this.setState({
          status: 'starting',
          agent: agent.type,
          message: `agent starting: ${agent.type}`
        })
        await agent.start(this.config)
        this.agent = agent
        await this.setState({
          status: 'ready',
          agent: agent.type,
          message: `agent ready: ${agent.type}`
        })
        return Result.success(null)
      } catch (error) {
        const failed = Result.fromError(error)
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

  async receive(text: string): Promise<Result<AgentReceiveResult>> {
    if (text.trim().length === 0) {
      return Result.fail('text is required')
    }
    if (text.trim() === '/$ clear') {
      const started = await this.start()
      if (started.isFailed) {
        return Result.fail<AgentReceiveResult>(started.message)
      }
      if (!this.agent) {
        return Result.fail<AgentReceiveResult>('agent not started')
      }
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
    let input = text
    if (input.startsWith('/$$')) {
      input = `/$${input.slice(3)}`
    }
    const received = await this.callbacks.send(createReceiveConfirmation())
    if (received.isFailed) {
      return Result.fail<AgentReceiveResult>(received.message)
    }
    const started = await this.start()
    if (started.isFailed) {
      return Result.fail<AgentReceiveResult>(started.message)
    }
    if (!this.agent) {
      return Result.fail<AgentReceiveResult>('agent not started')
    }
    try {
      await this.agent.receive(input)
      return Result.success({})
    } catch (error) {
      const failed = Result.fromError(error)
      return Result.fail<AgentReceiveResult>(failed.message)
    }
  }

  async stop(): Promise<Result<null>> {
    try {
      await this.agent?.stop()
      this.agent = undefined
      await this.setState({
        status: 'stopped',
        agent: null,
        message: 'agent stopped'
      })
      return Result.success(null)
    } catch (error) {
      return Result.fromError(error)
    }
  }

  private createAgent(): Agent {
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
    if (agentName === 'echo') {
      return new EchoAgent({
        send
      })
    }
    if (agentName === 'codex') {
      return new CodexAgent({
        workspacePath: this.config.workspace.path,
        config: this.config,
        toolBaseUrl: this.toolBaseUrl,
        send
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
    await this.callbacks.status(state.message)
  }
}
