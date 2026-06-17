import { Express } from 'express'
import { Result } from '../Result.js'

export type ChannelReceiveResult = {
  action?: 'clear'
}

export type ChannelMessage = {
  role: 'human' | 'agent' | 'system'
  text: string
  createdAt: number
  source?: string
}

export type ChannelStartInput = {
  app: Express
  displayHistory: () => ChannelMessage[]
  receive: (text: string) => Promise<Result<ChannelReceiveResult>>
}

export interface ChannelAdapter {
  type: string
  start(input: ChannelStartInput): void
  send(message: ChannelMessage): Promise<Result<null>>
  stop(): Promise<Result<null>>
}
