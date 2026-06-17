import { AgentRuntime, RuntimeHandle, RuntimeStartInput } from './RuntimeManager.js'

export type EchoRuntimeOptions = {
  onMessage: (runtimeId: string, text: string) => Promise<void>
}

export class EchoRuntime implements AgentRuntime {
  readonly type = 'echo'
  private readonly runtimeIds = new Set<string>()

  constructor(private readonly options: EchoRuntimeOptions) {}

  async start(input: RuntimeStartInput): Promise<RuntimeHandle> {
    this.runtimeIds.add(input.runtimeId)
    return {
      runtimeId: input.runtimeId
    }
  }

  async send(input: { runtimeId: string; text: string }): Promise<void> {
    if (!this.runtimeIds.has(input.runtimeId)) {
      throw new Error(`runtime not started: ${input.runtimeId}`)
    }
    await this.options.onMessage(input.runtimeId, `echo: ${input.text}`)
  }

  async stop(runtimeId: string): Promise<void> {
    this.runtimeIds.delete(runtimeId)
  }
}
