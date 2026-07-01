import { CodexioConfig } from '../../value/ConfigDefinition.js'
import { Message } from '../../value/Message.js'
import { Result } from '../../value/Result.js'

export type ChannelType = keyof CodexioConfig['channelo']

export type ChannelOutputContext = {
  inputType?: keyof CodexioConfig['channeli']
}

export interface ChannelOutput {
  type: ChannelType
  start(): Promise<boolean>
  send(message: Message, context?: ChannelOutputContext): Promise<Result<void>>
  stop(): Promise<Result<void>>
}
