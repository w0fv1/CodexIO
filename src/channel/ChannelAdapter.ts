import { Express } from 'express'
import { Result } from '../Result.js'

export type ChannelReceiveResult = {
  action?: 'clear'
}

export type HumanInput = {
  channel: string
  text: string
}

export type ChannelStartInput = {
  app: Express
  receive: (input: HumanInput) => Promise<Result<ChannelReceiveResult>>
}

export interface ChannelAdapter {
  type: string
  start(input: ChannelStartInput): void
  receive(text: string): Promise<Result<null>>
  send(text: string): Promise<Result<null>>
}
