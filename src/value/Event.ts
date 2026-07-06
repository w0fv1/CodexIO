import { CodexioConfig } from './ConfigDefinition.js'
import { Message } from './Message.js'
import { Result } from './Result.js'

export enum AppEvent {
  StopRequested = 'app.stopRequested',
  ChannelMessageReceived = 'channel.message.received',
  ChannelMessageDisplayRequested = 'channel.message.displayRequested'
}

export type ChannelMessageReceivedEvent = {
  source: keyof CodexioConfig['channeli']
  message: Message
}

export type ChannelInputReceiveResult = {
  consumed?: boolean
  ioThreadId?: string
}

export type ChannelMessageDisplayRequestedEvent = {
  source?: keyof CodexioConfig['channeli']
  message: Message
}

export type AppEventMap = {
  [AppEvent.StopRequested]: () => void
  [AppEvent.ChannelMessageReceived]: (event: ChannelMessageReceivedEvent) => Promise<Result<void>>
  [AppEvent.ChannelMessageDisplayRequested]: (event: ChannelMessageDisplayRequestedEvent) => Promise<Result<void>>
}
