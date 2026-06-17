import { CodexioConfig } from '../ConfigService.js'

export interface Agent {
  type: string
  login(): Promise<void>
  start(config: CodexioConfig): Promise<void>
  receive(text: string): Promise<void>
  clear(): Promise<void>
  stop(): Promise<void>
}
