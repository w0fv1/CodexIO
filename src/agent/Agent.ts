import { CodexioConfig } from '../config/ConfigDefinition.js'
import { ChannelFile } from '../channel/Channel.js'

export type AgentInput = {
  text: string
  files?: ChannelFile[]
}

export interface Agent {
  type: string
  login(): Promise<void>
  start(config: CodexioConfig): Promise<void>
  receive(input: AgentInput): Promise<void>
  clear(): Promise<void>
  stop(): Promise<void>
}

export class AgentLoginInProgressError extends Error {
  constructor(message = '请先完成 Codex 登录。') {
    super(message)
    this.name = 'AgentLoginInProgressError'
  }
}
