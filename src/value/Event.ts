import { CodexioConfig } from './ConfigDefinition.js'
import { Message } from './Message.js'
import { Result } from './Result.js'

export enum AppEvent {
  StopRequested = 'app.stopRequested',
  ChannelMessageReceived = 'channel.message.received',
  ChannelMessageSendRequested = 'channel.message.sendRequested'
}

export type ChannelMessageReceivedEvent = {
  inputType: keyof CodexioConfig['channeli']
  message: Message
}

export type ChannelInputReceiveResult = {
  ioThreadId?: string
}

export type ChannelMessageSendRequestedEvent = {
  inputType?: keyof CodexioConfig['channeli']
  message: Message
}

export type AppEventMap = {
  [AppEvent.StopRequested]: () => void
  [AppEvent.ChannelMessageReceived]: (event: ChannelMessageReceivedEvent) => Promise<Result<void>>
  [AppEvent.ChannelMessageSendRequested]: (event: ChannelMessageSendRequestedEvent) => Promise<Result<void>>
}
