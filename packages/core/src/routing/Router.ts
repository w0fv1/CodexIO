import { CodexioConfig } from '../config/ConfigSchema.js'
import { InboundTextMessage } from '../channel/ChannelAdapter.js'

export class Router {
  constructor(private readonly config: CodexioConfig) {}

  selectWorkspace(message: InboundTextMessage): string {
    const command = `${this.config.routing.repoCommand} `
    if (message.text.startsWith(command)) {
      const [workspaceName] = message.text.slice(command.length).trim().split(/\s+/)
      if (workspaceName && this.config.workspaces[workspaceName]) {
        return workspaceName
      }
    }
    return this.config.routing.defaultWorkspace
  }
}
