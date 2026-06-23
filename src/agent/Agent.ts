import { Message } from '../value/Message.js'

export interface Agent {
  type: string
  login(): Promise<void>
  start(ioThreadId?: string): Promise<void>
  receive(message: Message): Promise<void>
  clear(ioThreadId: string): Promise<void>
  stop(): Promise<void>
}
