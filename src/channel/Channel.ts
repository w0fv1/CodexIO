import { CodexioConfig } from '../value/ConfigDefinition.js'
import { Result } from '../value/Result.js'
import { Message } from '../value/Message.js'

export type ChannelReceiveResult = {
  action?: 'clear' | 'restart' | 'update'
  ioThreadId?: string
}

export type ChannelType = keyof CodexioConfig['channels']

export interface Channel {
  type: ChannelType
  start(): Promise<void>
  send(message: Message): Promise<Result<null>>
  stop(): Promise<Result<null>>
}
