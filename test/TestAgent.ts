import { Agent } from '../src/agent/Agent.js'
import { Message } from '../src/value/Message.js'

export class TestAgent implements Agent {
  readonly type = 'test'

  constructor(private send: (message: Message) => Promise<void> = async () => {}) {}

  setSend(send: (message: Message) => Promise<void>): void {
    this.send = send
  }

  async start(): Promise<void> {}

  async receive(input: Message): Promise<void> {
    await this.send({
      ioThreadId: input.ioThreadId,
      role: 'agent',
      text: `test: ${input.text}`
    })
  }

  async stop(): Promise<void> {}
}
