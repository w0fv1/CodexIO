import { CodexioConfig } from '../../value/ConfigDefinition.js'
import { Message } from '../../value/Message.js'
import { Result } from '../../value/Result.js'

export type AgentInput = {
  source: keyof CodexioConfig['channeli']
  message: Message
  sourceMessageId?: string
}

export interface Agent {
  type: string
  start(): Promise<Result<void>>
  receive(input: AgentInput): Promise<Result<void>>
  stop(): Promise<Result<void>>
}
