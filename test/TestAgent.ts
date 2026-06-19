import { CodexioConfig } from '../src/ConfigService.js'
import { Agent } from '../src/agent/Agent.js'

export class TestAgent implements Agent {
  readonly type = 'test'

  constructor(private readonly send: (text: string) => Promise<void>) {}

  async login(): Promise<void> {}

  async start(_config: CodexioConfig): Promise<void> {}

  async receive(text: string): Promise<void> {
    await this.send(`test: ${text}`)
  }

  async restart(): Promise<void> {}

  async clear(): Promise<void> {}

  async stop(): Promise<void> {}
}
