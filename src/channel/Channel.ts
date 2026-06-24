import { CodexioConfig } from '../value/ConfigDefinition.js'
import { Result } from '../value/Result.js'
import { Message } from '../value/Message.js'

export type ChannelReceiveResult = {
  action?: 'clear' | 'update'
  ioThreadId?: string
}

export type ChannelType = keyof CodexioConfig['channels']

export type ChannelInputReceive = (message: Message) => Promise<Result<ChannelReceiveResult>>

export interface ChannelInput {
  type: ChannelType
  start(receive: ChannelInputReceive): Promise<boolean>
  stop(): Promise<Result<null>>
}

export interface ChannelOutput {
  type: ChannelType
  start(): Promise<boolean>
  send(message: Message): Promise<Result<null>>
  stop(): Promise<Result<null>>
}
