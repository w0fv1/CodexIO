import { Express } from 'express'
import { Result } from '../value/Result.js'

export type ChannelReceiveResult = {
  action?: 'clear' | 'restart' | 'update'
}

export type ChannelMessage = {
  role: 'user' | 'agent' | 'system'
  text: string
  createdAt: number
  source?: string
}

export type ChannelStartInput = {
  app: Express
  displayHistory: () => ChannelMessage[]
  receive: (text: string) => Promise<Result<ChannelReceiveResult>>
}

export interface Channel {
  type: string
  start(input: ChannelStartInput): void
  send(message: ChannelMessage): Promise<Result<null>>
  stop(): Promise<Result<null>>
}
