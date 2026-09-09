import { Message } from '../../value/Message.js'
import { Result } from '../../value/Result.js'

export interface AgentOutputReceiver {
  receiveAgentOutput(message: Message): Promise<Result<void>>
  completeAgentTurn?(ioThreadId: string, error?: string): void
}

export interface Agent {
  type: string
  start(receiver: AgentOutputReceiver): Promise<Result<void>>
  receive(message: Message): Promise<Result<void>>
  stop(): Promise<Result<void>>
}
