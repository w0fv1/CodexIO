import { Writable } from 'node:stream'
import { inject, injectable } from 'inversify'
import { OutputId } from '../ComponentIdentifier.js'
import { CodexioMetadata } from '../component/CodexioMetadata.js'
import { Result } from '../value/Result.js'
import { AgentManager } from './AgentManager.js'
import { ClaudeAgent } from './ClaudeAgent.js'
import { CodexAgent } from './CodexAgent.js'
import { Configer } from '../component/Configer.js'

@injectable()
export class AgentLoginService {
  constructor(
    @inject(CodexioMetadata) private readonly metadata: CodexioMetadata,
    @inject(CodexAgent) private readonly codexAgent: CodexAgent,
    @inject(ClaudeAgent) private readonly claudeAgent: ClaudeAgent,
    @inject(OutputId) private readonly output: Writable
  ) {}

  async login(configPath?: string): Promise<void> {
    const configer = new Configer(configPath ? new CodexioMetadata({
      rootPath: this.metadata.rootPath,
      configPath
    }) : this.metadata)
    await configer.init(false)
    await configer.validate()
    const agentManager = new AgentManager(configer, {
      send: async (message) => {
        this.output.write(`${message.text}\n`)
        return Result.success(null)
      },
      status: async (text) => {
        this.output.write(`${text}\n`)
        return Result.success(null)
      }
    }, this.codexAgent, this.claudeAgent)
    await agentManager.login()
  }
}
