import { Express } from 'express'
import { Result } from '../Result.js'

export type ChannelReceiveResult = {
  action?: 'clear'
}

export type ChannelMessage = {
  role: 'human' | 'agent'
  text: string
  createdAt: number
}

export type ChannelStartInput = {
  app: Express
  history: () => ChannelMessage[]
  receive: (text: string) => Promise<Result<ChannelReceiveResult>>
}

export interface ChannelAdapter {
  type: string
  start(input: ChannelStartInput): void
  receive(text: string): Promise<Result<null>>
  send(text: string): Promise<Result<null>>
}
