export type RuntimeContext = {
  runtimeId: string
  agent: string
  model?: string
  workspaceName: string
  workspacePath: string
  channel: string
  conversationId: string
  startedAt: number
  lastActiveAt: number
}

export class RuntimeRegistry {
  private readonly conversationRuntimeMap = new Map<string, RuntimeContext>()
  private readonly runtimeMap = new Map<string, RuntimeContext>()

  findByConversation(channel: string, conversationId: string, workspaceName: string): RuntimeContext | undefined {
    const key = this.getConversationKey(channel, conversationId, workspaceName)
    return this.conversationRuntimeMap.get(key)
  }

  findByRuntime(runtimeId: string): RuntimeContext | undefined {
    return this.runtimeMap.get(runtimeId)
  }

  save(context: RuntimeContext): void {
    const key = this.getConversationKey(context.channel, context.conversationId, context.workspaceName)
    this.conversationRuntimeMap.set(key, context)
    this.runtimeMap.set(context.runtimeId, context)
  }

  remove(runtimeId: string): RuntimeContext | undefined {
    const context = this.runtimeMap.get(runtimeId)
    if (!context) {
      return undefined
    }
    const key = this.getConversationKey(context.channel, context.conversationId, context.workspaceName)
    this.conversationRuntimeMap.delete(key)
    this.runtimeMap.delete(runtimeId)
    return context
  }

  removeByConversation(channel: string, conversationId: string, workspaceName: string): RuntimeContext | undefined {
    const context = this.findByConversation(channel, conversationId, workspaceName)
    if (!context) {
      return undefined
    }
    return this.remove(context.runtimeId)
  }

  touch(runtimeId: string): void {
    const context = this.runtimeMap.get(runtimeId)
    if (context) {
      context.lastActiveAt = Date.now()
      this.save(context)
    }
  }

  getConversationKey(channel: string, conversationId: string, workspaceName: string): string {
    return `${channel}:${conversationId}:${workspaceName}`
  }
}
