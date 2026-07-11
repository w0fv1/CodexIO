import { CodexioConfig } from '../../value/ConfigDefinition.js'
import { Message } from '../../value/Message.js'
import { Result } from '../../value/Result.js'

export type ChannelType = keyof CodexioConfig['channelo']

export type ChannelOutputContext = {
  source?: keyof CodexioConfig['channeli']
  sourceMessageId?: string
  targets?: ChannelType[]
}

export interface ChannelOutput {
  type: ChannelType
  start(): Promise<boolean>
  send(message: Message, context?: ChannelOutputContext): Promise<Result<void>>
  stop(): Promise<Result<void>>
}
