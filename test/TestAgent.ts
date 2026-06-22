import { CodexioConfig } from '../src/config/ConfigDefinition.js'
import { Agent, AgentInput } from '../src/agent/Agent.js'

export class TestAgent implements Agent {
  readonly type = 'test'

  constructor(private readonly send: (text: string) => Promise<void>) {}

  async login(): Promise<void> {}

  async start(_config: CodexioConfig): Promise<void> {}

  async receive(input: AgentInput): Promise<void> {
    await this.send(`test: ${input.text}`)
  }

  async clear(): Promise<void> {}

  async stop(): Promise<void> {}
}
