import { CodexioConfig } from '../ConfigService.js'

export interface Agent {
  type: string
  login(): Promise<void>
  start(config: CodexioConfig): Promise<void>
  receive(text: string): Promise<void>
  clear(): Promise<void>
  stop(): Promise<void>
}

export class AgentLoginInProgressError extends Error {
  constructor(message = '请先完成 Codex 登录。') {
    super(message)
    this.name = 'AgentLoginInProgressError'
  }
}
