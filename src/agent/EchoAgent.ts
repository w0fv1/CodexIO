import { CodexioConfig } from '../ConfigService.js'
import { Agent } from './Agent.js'

export type EchoAgentOptions = {
  send: (text: string) => Promise<void>
}

export class EchoAgent implements Agent {
  readonly type = 'echo'
  private started = false

  constructor(private readonly options: EchoAgentOptions) {}

  async login(): Promise<void> {}

  async start(_config: CodexioConfig): Promise<void> {
    this.started = true
  }

  async receive(text: string): Promise<void> {
    if (!this.started) {
      throw new Error('agent not started')
    }
    await this.options.send(`echo: ${text}`)
  }

  async clear(): Promise<void> {
    this.started = true
  }

  async stop(): Promise<void> {
    this.started = false
  }
}
