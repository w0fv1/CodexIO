import { CodexioConfig } from '../value/ConfigDefinition.js'
import { Result } from '../value/Result.js'
import { Message } from '../value/Message.js'

export type ChannelReceiveResult = {
  action?: 'update'
  ioThreadId?: string
}

export type ChannelType = keyof CodexioConfig['channels']

export type ChannelInputReceive = (message: Message) => Promise<Result<ChannelReceiveResult>>
export type ChannelOutputContext = {
  inputType?: ChannelType
}

export interface ChannelInput {
  type: ChannelType
  start(receive: ChannelInputReceive): Promise<boolean>
  stop(): Promise<Result<void>>
}

export interface ChannelOutput {
  type: ChannelType
  start(): Promise<boolean>
  send(message: Message, context?: ChannelOutputContext): Promise<Result<void>>
  stop(): Promise<Result<void>>
}
