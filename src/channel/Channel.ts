import { CodexioConfig } from '../ConfigService.js'
import { Result } from '../value/Result.js'
import { StoredFile } from '../component/FileStore.js'

export type ChannelReceiveResult = {
  action?: 'clear' | 'restart' | 'update'
}

export type ChannelType = keyof CodexioConfig['channels']

export type ChannelFile = StoredFile

export type ChannelInput = {
  text: string
  files?: ChannelFile[]
}

export type ChannelMessage = {
  role: 'user' | 'agent' | 'system'
  text: string
  createdAt: number
  source?: string
  files?: ChannelFile[]
}

export interface Channel {
  type: ChannelType
  start(config: CodexioConfig): void
  send(message: ChannelMessage): Promise<Result<null>>
  stop(): Promise<Result<null>>
}
