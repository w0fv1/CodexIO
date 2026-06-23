import { Agent } from '../src/agent/Agent.js'
import { Message } from '../src/value/Message.js'

export class TestAgent implements Agent {
  readonly type = 'test'

  constructor(private readonly send: (message: Message) => Promise<void>) {}

  async login(): Promise<void> {}

  async start(): Promise<void> {}

  async receive(input: Message): Promise<void> {
    await this.send({
      ioThreadId: input.ioThreadId,
      role: 'agent',
      text: `test: ${input.text}`,
      createdAt: Date.now()
    })
  }

  async clear(_ioThreadId: string): Promise<void> {}

  async stop(): Promise<void> {}
}
