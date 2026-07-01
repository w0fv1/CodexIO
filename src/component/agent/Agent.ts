import { ChannelMessageReceivedEvent } from '../../value/Event.js'
import { Result } from '../../value/Result.js'

export interface Agent {
  type: string
  start(): Promise<Result<void>>
  receive(event: ChannelMessageReceivedEvent): Promise<Result<void>>
  stop(): Promise<Result<void>>
}
