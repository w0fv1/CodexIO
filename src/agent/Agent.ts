import { Message } from '../value/Message.js'

export interface Agent {
  type: string
  start(): Promise<void>
  receive(message: Message): Promise<void>
  stop(): Promise<void>
}
