import { inject, injectable } from 'inversify'
import { UserverAgentClient } from '@w0fv1/uclient-js/agent'
import { UserverThreadClient } from '@w0fv1/uclient-js/thread'
import { Configer } from '../../component/Configer.js'
import { Logger } from '../../component/Logger.js'
import { FileStore } from '../../component/FileStore.js'
import { ThreadRegistry } from '../../component/ThreadRegistry.js'
import { AgentManager } from '../../component/agent/AgentManager.js'
import { MessageFile } from '../../value/Message.js'
import { Result } from '../../value/Result.js'
import { ChannelInput, ChannelInputReceiver } from './ChannelInput.js'

@injectable()
export class UserverThreadInput implements ChannelInput {
  readonly type = 'userver'
  private abort?: AbortController
  private task?: Promise<void>

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(FileStore) private readonly files: FileStore,
    @inject(ThreadRegistry) private readonly threads: ThreadRegistry,
    @inject(AgentManager) private readonly agents: AgentManager
  ) {}

  async start(receiver: ChannelInputReceiver): Promise<boolean> {
    const config = await this.configer.get('channeli.userver')
    if (!config.enabled) return false
    const client = new UserverAgentClient(config)
    const abort = new AbortController()
    this.abort = abort
    const listener = UserverThreadClient.forAgent(config)
    this.task = listener.listen({
      signal: abort.signal,
      checkpoint: identity => this.threads.checkpoint(JSON.stringify([new URL(config.baseUrl).origin, config.websiteId, identity.agentUuid, null])),
      onError: error => Logger.warn('Userver listener will retry', { message: String(error) }),
      receive: async (event, identity) => {
        if (event.actorAgentUuid === identity.agentUuid) return
        const threadUuid = event.threadUuid
        const thread = await client.thread(threadUuid, abort.signal)
        const message = event.messageUuid ? await client.message(threadUuid, event.messageUuid, abort.signal) : undefined
        const text = message?.content ?? thread.content
        const files: MessageFile[] = []
        const siteAttachments: { id: number, name: string }[] = []
        for (const attachment of [...(message?.files ?? []), ...(message?.images ?? [])]) {
          if (!attachment.url) {
            siteAttachments.push({ id: attachment.id, name: attachment.originalFilename || attachment.filename })
            continue
          }
          const response = await fetch(attachment.url, { signal: abort.signal })
          if (!response.ok) throw new Error(`Attachment download failed (${response.status})`)
          files.push(await this.files.importBuffer({ buffer: Buffer.from(await response.arrayBuffer()), name: attachment.originalFilename || attachment.filename, mime: attachment.mimeType }))
        }
        const channelThreadId = { source: 'userver' as const, id: JSON.stringify([new URL(config.baseUrl).origin, config.websiteId, identity.agentUuid, threadUuid]) }
        const prompt = `Userver 主题有新进展。先读取并核实当前任务状态，在授权范围内继续推进；仅在缺少必要信息或需要用户决策时停止。已完成、重复或仅确认的信息不必再回复；回复、正式交付和验收都通过本站 MCP 执行；监听连接只读，不会自动发送你的最终回答。事件 ${event.cursor}，主题 ${threadUuid}。\n\n${text}\n\n${siteAttachments.length ? `以下附件需要通过本站 MCP 查询下载权限并获取，尚未下载：${JSON.stringify(siteAttachments)}` : ''}`
        const ioThread = this.threads.resolve(channelThreadId, prompt)
        await this.agents.runUntilComplete(ioThread.id, async () => {
          const result = await receiver.receive('userver', { channelThreadId, sourceMessageId: String(event.cursor), text: prompt, files })
          if (result.isFailed) throw new Error(result.message)
          if (result.data?.consumed) this.agents.completeAgentTurn(ioThread.id)
        }, abort.signal)
      }
    })
    return true
  }

  async stop(): Promise<Result<void>> {
    this.abort?.abort()
    await this.task
    this.task = undefined
    this.abort = undefined
    return Result.successVoid()
  }
}
