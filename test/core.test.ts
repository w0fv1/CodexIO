import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Container } from 'inversify'
import { ChannelOutputManager } from '../src/component/channelo/ChannelOutputManager.js'
import { ChannelOutput, ChannelOutputContext } from '../src/component/channelo/ChannelOutput.js'
import { FeishuChannelOutput } from '../src/component/channelo/FeishuChannelOutput.js'
import { WebChannelOutput } from '../src/component/channelo/WebChannelOutput.js'
import { Configer } from '../src/component/Configer.js'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { FileStore } from '../src/component/FileStore.js'
import { MessageFileResolver } from '../src/component/MessageFileResolver.js'
import { ThreadRegistry } from '../src/component/ThreadRegistry.js'
import { ThreadWorkspaceResolver } from '../src/component/ThreadWorkspaceResolver.js'
import { Agent } from '../src/component/agent/Agent.js'
import { AgentManager } from '../src/component/agent/AgentManager.js'
import { CodexClient, CodexClientThread } from '../src/component/agent/codex/CodexClient.js'
import { CodexMessageAssembler } from '../src/component/agent/codex/CodexMessageAssembler.js'
import { CodexAgent } from '../src/component/agent/CodexAgent.js'
import { CommandExecutor, parseCommandInput } from '../src/controller/CommandExecutor.js'
import { ChannelInput } from '../src/controller/channeli/ChannelInput.js'
import { ChannelInputManager } from '../src/controller/channeli/ChannelInputManager.js'
import { configDescriptor, ConfigSchema, createDefaultConfig, parseCodexioConfig, validateCodexioConfig } from '../src/value/ConfigDefinition.js'
import { Result } from '../src/value/Result.js'
import { createMessage, deriveMessageId, Message } from '../src/value/Message.js'
import { shouldReceiveFeishuMessage, shouldReceiveFeishuSender } from '../src/value/FeishuMessage.js'
import { parseMarkdownAttachmentReferences, renderMarkdownHtml } from '../src/util/Markdown.js'
import { resolveUserPath } from '../src/util/Path.js'
import { parseNfircoThreadSocketEvent } from '../src/component/channel/NfircoThreadClient.js'
import { WebThreadManager } from '../src/component/channel/WebThreadManager.js'
import { ServerRuntime } from '../src/component/ServerRuntime.js'
import { LoginItemManager } from '../src/component/desktop/LoginItemManager.js'
import { DesktopIntegration } from '../src/component/desktop/DesktopIntegration.js'
import { renderConfigTemplate } from '../src/value/ConfigTemplate.js'
import { CodexThreadObserver } from '../src/component/agent/codex/CodexThreadObserver.js'

const testMetadata = new CodexioMetadata()

function createTestCodexClient(configer: Configer, metadata = testMetadata): CodexClient {
  return new CodexClient(configer, metadata, new ThreadWorkspaceResolver(configer, metadata))
}

describe('core', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  it('creates channel-only default config', () => {
    const config = createDefaultConfig()
    expect(config.app.id).toBe('')
    expect(config.app.startAtLogin).toBe(false)
    expect(config.server.host).toBe('127.0.0.1')
    expect(config.agents.instruction).toContain('Markdown reference')
    expect(config.agents.instruction).toContain('previews without a file path')
    expect(config.agents.echo.enabled).toBe(true)
    expect(config.agents.codex.bundled).toBe(true)
    expect(config.agents.codex.observe.enabled).toBe(false)
    expect(config.app.workspace.path).toBe('workspace')
    expect(config.proxy.host).toBe('127.0.0.1')
    expect(config.proxy.noProxy).toBe('')
    expect(config.channeli.web?.enabled).toBe(true)
    expect(config.channeli.feishu?.aite).toBe(true)
    expect(config.channeli.feishu?.allowedOpenIds).toEqual([])
    expect(config.channeli.nfirco?.enabled).toBe(false)
    expect(config.channelo.nfirco?.enabled).toBe(false)
    expect(config.channelo.web?.enabled).toBe(true)
  })

  it('describes config groups by stable paths', () => {
    const feishuInput = configDescriptor.groups.find((group) => group.path === 'channeli.feishu')
    expect(feishuInput).toEqual({
      path: 'channeli.feishu',
      title: 'Feishu Input',
      description: '在已经引入 Codexio 的飞书群聊中，或与 Codexio 私聊时，输入 $bind ${app.id} 即可在飞书中绑定 Codexio。'
    })
    expect(configDescriptor.fields.find((field) => field.path === 'channeli.feishu.enabled')?.groupPath).toBe('channeli.feishu')
  })

  it('renders config references without interpreting markup', () => {
    expect(renderConfigTemplate('绑定 $bind ${app.id} 到 ${server.host}', {
      app: {
        id: '<script>alert(1)</script>'
      },
      server: {
        host: '127.0.0.1'
      }
    })).toBe('绑定 $bind <script>alert(1)</script> 到 127.0.0.1')
    expect(renderConfigTemplate('保留 ${missing.value}', {})).toBe('保留 ${missing.value}')
  })

  it('applies login item changes only for packaged Windows desktop builds', () => {
    const calls: unknown[] = []
    const loginItems = new LoginItemManager({
      setLoginItemSettings: (settings) => calls.push(settings)
    }, true, 'win32', 'C:\\Program Files\\Codexio\\Codexio.exe')
    loginItems.apply(true)
    loginItems.apply(false)
    expect(calls).toEqual([
      {
        openAtLogin: true,
        path: 'C:\\Program Files\\Codexio\\Codexio.exe'
      },
      {
        openAtLogin: false,
        path: 'C:\\Program Files\\Codexio\\Codexio.exe'
      }
    ])
  })

  it('does not register development Electron as a login item', () => {
    const calls: unknown[] = []
    const loginItems = new LoginItemManager({
      setLoginItemSettings: (settings) => calls.push(settings)
    }, false, 'win32', 'C:\\project\\node_modules\\electron.exe')
    loginItems.apply(true)
    expect(calls).toEqual([])
  })

  it('resolves desktop integration through the application container', () => {
    const container = new Container({
      autobind: true,
      defaultScope: 'Singleton'
    })
    const configer = {} as Configer
    container.bind(Configer).toConstantValue(configer)
    const integration = container.get(DesktopIntegration)
    expect(Reflect.get(integration, 'configer')).toBe(configer)
  })

  it('observes only new completed VS Code agent replies after startup', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    const baselineCompletedAt = Math.floor(Date.now() / 1000)
    let threads = [{
      id: 'vscode-thread',
      cwd: 'C:\\repo',
      updatedAt: baselineCompletedAt
    }]
    let turns = [{
      id: 'old-turn',
      status: 'completed',
      completedAt: baselineCompletedAt - 1,
      items: [{
        id: 'old-agent',
        type: 'agentMessage',
        text: 'old reply'
      }]
    }]
    const snapshots: unknown[] = []
    const diagnostics: Array<{ event: string, data: Record<string, unknown> }> = []
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/list') {
        return {
          data: threads,
          nextCursor: null
        }
      }
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'vscode-thread',
            name: 'VS Code project',
            turns
          }
        }
      }
      throw new Error(method)
    })
    const observer = new CodexThreadObserver({ request }, {
      intervalMs: 1000
    }, async (snapshot) => {
      snapshots.push(snapshot)
    }, undefined, (diagnostic) => diagnostics.push(diagnostic))
    await observer.start()
    expect(snapshots).toEqual([])
    expect(request).not.toHaveBeenCalledWith('thread/read', expect.anything())
    expect(request).toHaveBeenCalledWith('thread/list', expect.not.objectContaining({
      cwd: expect.anything()
    }))
    turns = [
      ...turns,
      {
        id: 'new-turn',
        status: 'completed',
        completedAt: baselineCompletedAt + 1,
        items: [
          {
            id: 'new-user',
            type: 'userMessage',
            text: 'new prompt'
          },
          {
            id: 'new-agent',
            type: 'agentMessage',
            text: 'new reply'
          }
        ]
      }
    ]
    threads = [{
      ...threads[0],
      updatedAt: baselineCompletedAt + 1
    }]
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:00:02Z'))
    await observer['poll']()
    expect(snapshots).toEqual([{
      thread: {
        id: 'vscode-thread',
        name: 'VS Code project'
      },
      messages: [{
        turnId: 'new-turn',
        itemId: 'new-agent',
        role: 'assistant',
        text: 'new reply',
        completedAt: baselineCompletedAt + 1,
        sequence: 2
      }]
    }])
    expect(diagnostics).toEqual(expect.arrayContaining([
      {
        event: 'baselineEstablished',
        data: expect.objectContaining({
          threadCount: 1,
          intervalMs: 1000
        })
      },
      {
        event: 'threadRead',
        data: expect.objectContaining({
          threadId: 'vscode-thread',
          turnCount: 2,
          completedTurnCount: 2,
          agentMessageCount: 2,
          snapshotMessageCount: 1
        })
      },
      {
        event: 'snapshotEmitted',
        data: expect.objectContaining({
          threadId: 'vscode-thread',
          messageCount: 1
        })
      }
    ]))
    await observer['poll']()
    expect(snapshots).toHaveLength(1)
    observer.stop()
  })

  it('does not observe threads created by Codexio', async () => {
    const messages: unknown[] = []
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/list') {
        return {
          data: [{
            id: 'codexio-thread',
            cwd: 'C:\\repo',
            updatedAt: 2
          }],
          nextCursor: null
        }
      }
      if (method === 'thread/read') {
        throw new Error('ignored thread must not be read')
      }
      throw new Error(method)
    })
    const observer = new CodexThreadObserver({ request }, {
      intervalMs: 1000
    }, async (message) => {
      messages.push(message)
    })
    observer.ignoreThread('codexio-thread')
    await observer.start()
    await observer['poll']()
    expect(messages).toEqual([])
    expect(request).not.toHaveBeenCalledWith('thread/read', expect.anything())
    observer.stop()
  })

  it('re-emits a turn that changes from interrupted to completed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    const completedAt = Math.floor(Date.now() / 1000) + 1
    let updatedAt = completedAt - 1
    let status = 'interrupted'
    const messages: unknown[] = []
    const observer = new CodexThreadObserver({
      request: async (method: string) => {
        if (method === 'thread/list') {
          return {
            data: [{ id: 'vscode-thread', updatedAt }],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'vscode-thread',
              name: 'VS Code thread',
              turns: [{
                id: 'turn',
                status,
                ...(status === 'completed' ? { completedAt } : {}),
                items: status === 'completed'
                  ? [{ id: 'agent-message', type: 'agentMessage', text: 'reply' }]
                  : []
              }]
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000
    }, async (message) => {
      messages.push(message)
    })
    await observer.start()
    updatedAt = completedAt
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:00:02Z'))
    await observer['poll']()
    expect(messages).toEqual([])
    status = 'completed'
    updatedAt = completedAt + 1
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:00:04Z'))
    await observer['poll']()
    updatedAt = completedAt + 2
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:00:06Z'))
    await observer['poll']()
    expect(messages).toHaveLength(2)
    expect(messages).toMatchObject([
      { messages: [{ turnId: 'turn', itemId: 'agent-message' }] },
      { messages: [{ turnId: 'turn', itemId: 'agent-message' }] }
    ])
    observer.stop()
  })

  it('retries a VS Code reply after a transient thread read failure', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    const completedAt = Math.floor(Date.now() / 1000) + 1
    let listed = false
    let readAttempts = 0
    const messages: unknown[] = []
    const errors: Error[] = []
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/list') {
        return {
          data: listed
            ? [{ id: 'vscode-thread', cwd: 'C:\\repo', updatedAt: completedAt }]
            : [],
          nextCursor: null
        }
      }
      if (method === 'thread/read') {
        readAttempts += 1
        if (readAttempts === 1) {
          throw new Error('temporary read failure')
        }
        return {
          thread: {
            id: 'vscode-thread',
            name: null,
            turns: [{
              id: 'new-turn',
              status: 'completed',
              completedAt,
              items: [{ id: 'new-agent', type: 'agentMessage', text: 'new reply' }]
            }]
          }
        }
      }
      throw new Error(method)
    })
    const observer = new CodexThreadObserver({ request }, {
      intervalMs: 1000
    }, async (message) => {
      messages.push(message)
    }, (error) => {
      errors.push(error)
    })
    await observer.start()
    listed = true
    await expect(observer['poll']()).resolves.toBeUndefined()
    vi.setSystemTime(new Date('2026-07-11T00:00:02Z'))
    await expect(observer['poll']()).resolves.toBeUndefined()
    expect(errors.map((error) => error.message)).toEqual(['temporary read failure'])
    vi.setSystemTime(new Date('2026-07-11T00:00:03Z'))
    await observer['poll']()
    expect(messages).toMatchObject([{
      thread: {
        id: 'vscode-thread',
        name: '新对话'
      }
    }])
    observer.stop()
  })

  it('does not persist config when a before-change integration fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-before-change-'))
    const configPath = join(dir, 'config.yaml')
    const configer = new Configer(new CodexioMetadata({
      dataPath: dir,
      configPath
    }))
    await configer.init()
    configer.beforeChange('app.startAtLogin', async () => {
      throw new Error('login item rejected')
    })
    await expect(configer.set('app.startAtLogin', true)).rejects.toThrow('login item rejected')
    expect(await configer.get('app.startAtLogin')).toBe(false)
  })

  it('parses nfirco thread message events', () => {
    expect(parseNfircoThreadSocketEvent({
      type: 'thread.message.created',
      eventId: 'event-1',
      threadUuid: 'thread-1',
      section: 'section-1',
      title: 'Project thread',
      authorAccessId: 'access-1',
      messageUuid: 'message-1',
      text: 'hello',
      files: [
        {
          id: 11,
          originalFilename: '需求.md',
          mimeType: 'text/markdown',
          size: 12,
          url: 'http://127.0.0.1/file/11'
        }
      ],
      images: [
        {
          id: 12,
          originalFilename: '截图.png',
          mimeType: 'image/png',
          size: 13,
          url: 'http://127.0.0.1/file/12'
        }
      ]
    })).toEqual({
      type: 'thread.message.created',
      eventId: 'event-1',
      threadUuid: 'thread-1',
      section: 'section-1',
      title: 'Project thread',
      authorAccessId: 'access-1',
      messageUuid: 'message-1',
      text: 'hello',
      files: [
        {
          id: '11',
          name: '需求.md',
          mime: 'text/markdown',
          size: 12,
          url: 'http://127.0.0.1/file/11'
        }
      ],
      images: [
        {
          id: '12',
          name: '截图.png',
          mime: 'image/png',
          size: 13,
          url: 'http://127.0.0.1/file/12'
        }
      ]
    })
    expect(parseNfircoThreadSocketEvent({
      type: 'thread.created',
      eventId: 'thread-2',
      threadUuid: 'thread-2',
      section: 'section-1',
      authorAccessId: 'access-2',
      text: 'thread body'
    })).toEqual({
      type: 'thread.created',
      eventId: 'thread-2',
      threadUuid: 'thread-2',
      section: 'section-1',
      authorAccessId: 'access-2',
      text: 'thread body',
      files: [],
      images: []
    })
  })

  it('parses nfirco thread file-only message events', () => {
    expect(parseNfircoThreadSocketEvent({
      type: 'thread.message.created',
      eventId: 'event-file',
      threadUuid: 'thread-file',
      messageUuid: 'message-file',
      text: '',
      files: [
        {
          id: 21,
          filename: 'file.bin',
          url: 'http://127.0.0.1/file/21'
        }
      ]
    })).toEqual({
      type: 'thread.message.created',
      eventId: 'event-file',
      threadUuid: 'thread-file',
      section: undefined,
      messageUuid: 'message-file',
      text: '',
      files: [
        {
          id: '21',
          name: 'file.bin',
          mime: undefined,
          size: undefined,
          url: 'http://127.0.0.1/file/21'
        }
      ],
      images: []
    })
  })

  it('controls whether feishu group messages require aite', () => {
    expect(shouldReceiveFeishuMessage('group', [], true)).toBe(false)
    expect(shouldReceiveFeishuMessage('group', [
      {
        key: '@_user_1'
      }
    ], true)).toBe(true)
    expect(shouldReceiveFeishuMessage('group', [], false)).toBe(true)
    expect(shouldReceiveFeishuMessage('p2p', [], true)).toBe(true)
  })

  it('allows feishu senders by open id list', () => {
    expect(shouldReceiveFeishuSender(undefined, [])).toBe(true)
    expect(shouldReceiveFeishuSender('ou_1', [])).toBe(true)
    expect(shouldReceiveFeishuSender('ou_1', [
      'ou_1'
    ])).toBe(true)
    expect(shouldReceiveFeishuSender('ou_2', [
      'ou_1'
    ])).toBe(false)
  })

  it('parses command prefixes', () => {
    expect(parseCommandInput('$test')).toEqual({
      type: 'command',
      name: 'test',
      args: []
    })
    expect(parseCommandInput('￥help now')).toEqual({
      type: 'command',
      name: 'help',
      args: [
        'now'
      ]
    })
    expect(parseCommandInput('hello')).toEqual({
      type: 'message',
      text: 'hello'
    })
  })

  it('parses empty feishu chat ids as unbound strings', async () => {
    const config = await parseCodexioConfig({
      channeli: {
        feishu: {
          chatId: null
        }
      },
      channelo: {
        feishu: {
          chatId: null
        }
      }
    }, 'config.yaml')
    expect(config.channeli.feishu.chatId).toBe('')
    expect(config.channelo.feishu.chatId).toBe('')
  })

  it('consumes test commands without sending them to the agent event', async () => {
    const executor = new CommandExecutor(recordingMessageOutput())
    const result = await executor.receive({
      source: 'feishu',
      message: {
        thread: { id: 'io-thread', name: '新对话' },
        role: 'user',
        text: '$test'
      },
      input: {
        channelThreadId: {
          source: 'feishu',
          id: 'chat:thread:omt_1'
        },
        text: '$test',
        mentioned: true,
        sender: {
          openId: 'ou_1'
        }
      }
    })
    expect(result.data?.consumed).toBe(true)
  })

  it('publishes input messages to display and agent manager events', async () => {
    const events: Array<{ type: string, source: string | undefined, sourceMessageId?: string, text: string }> = []
    const outputManager = recordingMessageOutput((message, context) => {
      events.push({
        type: 'display',
        source: context?.source,
        sourceMessageId: context?.sourceMessageId,
        text: message.text
      })
    })
    const agentManager = recordingAgentManager((message) => {
      events.push({
        type: 'agent',
        source: undefined,
        text: message.text
      })
    })
    const manager = new ChannelInputManager(
      {} as Configer,
      createThreadRegistry(),
      outputManager,
      agentManager,
      new CommandExecutor(outputManager),
      disabledInput('web'),
      disabledInput('feishu'),
      disabledInput('email'),
      disabledInput('nfirco')
    )
    const result = await manager.receive('feishu', {
      channelThreadId: {
        source: 'feishu',
        id: 'chat:thread:omt_1'
      },
      sourceMessageId: 'om_1',
      text: 'hello'
    })
    const repeated = await manager.receive('feishu', {
      channelThreadId: {
        source: 'feishu',
        id: 'chat:thread:omt_1'
      },
      sourceMessageId: 'om_1',
      text: 'hello'
    })
    expect(result.isFailed).toBe(false)
    expect(repeated.isFailed).toBe(false)
    expect(events).toEqual([
      {
        type: 'display',
        source: 'feishu',
        sourceMessageId: 'om_1',
        text: 'hello'
      },
      {
        type: 'agent',
        source: undefined,
        text: 'hello'
      }
    ])
  })

  it('continues to the Agent when a display channel fails', async () => {
    const messages: Message[] = []
    const outputManager = {
      send: async () => Result.fail('feishu unavailable')
    } as unknown as ChannelOutputManager
    const manager = new ChannelInputManager(
      {} as Configer,
      createThreadRegistry(),
      outputManager,
      recordingAgentManager((message) => messages.push(message)),
      new CommandExecutor(outputManager),
      disabledInput('web'),
      disabledInput('feishu'),
      disabledInput('email'),
      disabledInput('nfirco')
    )

    const result = await manager.receive('web', {
      channelThreadId: { source: 'web', id: 'web-thread' },
      sourceMessageId: 'web-message',
      text: 'continue'
    })

    expect(result.isFailed).toBe(false)
    expect(messages.map((message) => message.text)).toEqual(['continue'])
  })

  it('owns channel input config subscriptions for exactly one lifecycle', async () => {
    let subscriptions = 0
    let disposals = 0
    const configer = {
      subscribe: () => {
        subscriptions += 1
        return {
          dispose: () => {
            disposals += 1
          }
        }
      }
    } as unknown as Configer
    const outputManager = recordingMessageOutput()
    const manager = new ChannelInputManager(
      configer,
      createThreadRegistry(),
      outputManager,
      recordingAgentManager(),
      new CommandExecutor(outputManager),
      disabledInput('web'),
      disabledInput('feishu'),
      disabledInput('email'),
      disabledInput('nfirco')
    )
    await manager.start()
    await manager.start()
    expect(subscriptions).toBe(1)
    await manager.stop()
    expect(disposals).toBe(1)
    await manager.start()
    expect(subscriptions).toBe(2)
    await manager.stop()
  })

  it('rejects missing source message identity before resolving a thread', async () => {
    const threadRegistry = createThreadRegistry()
    const outputManager = recordingMessageOutput()
    const manager = new ChannelInputManager(
      {} as Configer,
      threadRegistry,
      outputManager,
      recordingAgentManager(),
      new CommandExecutor(outputManager),
      disabledInput('web'),
      disabledInput('feishu'),
      disabledInput('email'),
      disabledInput('nfirco')
    )

    const result = await manager.receive('feishu', {
      channelThreadId: {
        source: 'feishu',
        id: 'chat:thread:omt_missing'
      },
      sourceMessageId: '   ',
      text: 'hello'
    })

    expect(result).toMatchObject({
      isFailed: true,
      message: 'sourceMessageId is required'
    })
    expect(threadRegistry.getLastActive()).toBeUndefined()
  })

  it('scopes source message identities to their channel thread', async () => {
    const messages: Message[] = []
    const outputManager = recordingMessageOutput()
    const agentManager = recordingAgentManager((message) => {
      messages.push(message)
    })
    const manager = new ChannelInputManager(
      {} as Configer,
      createThreadRegistry(),
      outputManager,
      agentManager,
      new CommandExecutor(outputManager),
      disabledInput('web'),
      disabledInput('feishu'),
      disabledInput('email'),
      disabledInput('nfirco')
    )

    for (const channelThreadId of ['chat:thread:omt_1', 'chat:thread:omt_2']) {
      const result = await manager.receive('feishu', {
        channelThreadId: {
          source: 'feishu',
          id: channelThreadId
        },
        sourceMessageId: 'om_shared',
        text: 'hello'
      })
      expect(result.isFailed).toBe(false)
    }

    expect(messages).toHaveLength(2)
    expect(messages[0].id).not.toBe(messages[1].id)
    expect(messages[0].thread.id).not.toBe(messages[1].thread.id)
  })

  it('rejects configs without enabled channel input and output', () => {
    const config = ConfigSchema.parse({
      channeli: {
        web: {
          enabled: false
        }
      },
      channelo: {
        web: {
          enabled: false
        }
      }
    })
    expect(() => validateCodexioConfig(config)).toThrow('one channeli must be enabled')
    expect(() => validateCodexioConfig(config)).toThrow('one channelo must be enabled')
  })

  it('rejects configs without enabled agents', () => {
    const config = ConfigSchema.parse({
      agents: {
        echo: {
          enabled: false
        },
        codex: {
          enabled: false
        }
      }
    })
    expect(() => validateCodexioConfig(config)).toThrow('one agent must be enabled')
  })

  it('requires nfirco output section when nfirco output is enabled', () => {
    const config = ConfigSchema.parse({
      channelo: {
        nfirco: {
          enabled: true,
          baseUrl: 'https://next.firco.cn',
          account: 'codexio',
          password: 'password'
        }
      }
    })
    expect(() => validateCodexioConfig(config)).toThrow('channelo.nfirco.section is required')
  })

  it('keeps codex agent and workspace config fields when importing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-config-'))
    const configPath = join(dir, 'config.yaml')
    await writeFile(configPath, [
      'app:',
      '  workspace:',
      '    path: workspace',
      'server:',
      '  token: test-token',
      'agents:',
      '  instruction: Shared instruction',
      '  echo:',
      '    enabled: false',
      '  codex:',
      '    enabled: true',
      '    bundled: false',
      '    command: codex-dev',
      '    model: gpt-5.6-sol',
      '    reasoningEffort: medium',
      'proxy:',
      '  enabled: true',
      '  host: 127.0.0.1',
      '  port: 7891',
      '  noProxy: next.firco.cn,*.firco.cn',
      'channeli:',
      '  web:',
      '    enabled: true',
      'channelo:',
      '  web:',
      '    enabled: true'
    ].join('\n'))
    const configer = new Configer(new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      configPath
    }))
    const exported = await configer.exportText()
    expect(exported).toContain('agents:')
    expect(exported).toContain('workspace:')
    expect(await configer.get('agents.instruction')).toBe('Shared instruction')
    expect(await configer.get('agents.echo.enabled')).toBe(false)
    expect(await configer.get('agents.codex.enabled')).toBe(true)
    expect(await configer.get('agents.codex.bundled')).toBe(false)
    expect(await configer.get('agents.codex.command')).toBe('codex-dev')
    expect(await configer.get('agents.codex.model')).toBe('gpt-5.6-sol')
    expect(await configer.get('agents.codex.reasoningEffort')).toBe('medium')
    expect(await configer.get('app.workspace.path')).toBe('workspace')
    expect(await configer.get('proxy.port')).toBe(7891)
    expect(await configer.get('proxy.noProxy')).toBe('next.firco.cn,*.firco.cn')
    expect(await configer.get('channeli.web.enabled')).toBe(true)
    expect(await configer.get('channelo.web.enabled')).toBe(true)
  })

  it('does not rewrite an existing config during init', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-config-preserve-'))
    const configPath = join(dir, 'config.yaml')
    const text = [
      '# keep this comment',
      'server:',
      '  token: keep-token',
      'agents:',
      '  echo:',
      '    enabled: true',
      'channeli:',
      '  web:',
      '    enabled: true',
      'channelo:',
      '  web:',
      '    enabled: true'
    ].join('\n')
    await writeFile(configPath, text, 'utf8')
    const configer = new Configer(new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      configPath
    }))
    await configer.init(false)
    expect(await readFile(configPath, 'utf8')).toBe(text)
  })

  it('keeps command-line runtime overrides out of persistent config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-runtime-config-'))
    const configPath = join(dir, 'config.yaml')
    await writeFile(configPath, [
      'server:',
      '  token: test-token',
      '  autoPort: false',
      'channeli:',
      '  web:',
      '    enabled: true',
      'channelo:',
      '  web:',
      '    enabled: true'
    ].join('\n'))
    const configer = new Configer(new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      configPath
    }))
    const runtime = new ServerRuntime({
      forceAutoPort: true
    })
    expect(runtime.forceAutoPort).toBe(true)
    expect(await configer.get('server.autoPort')).toBe(false)
    expect((await readFile(configPath, 'utf8'))).toContain('autoPort: false')
  })

  it('passes configured no proxy hosts to the codex process', async () => {
    const values = new Map<string, unknown>([
      ['agents.codex.bundled', false],
      ['app.workspace.path', 'workspace'],
      ['proxy.enabled', true],
      ['proxy.host', '127.0.0.1'],
      ['proxy.port', 7890],
      ['proxy.noProxy', 'next.firco.cn, *.firco.cn ,'],
      ['server.host', '127.0.0.1'],
      ['agents.codex.command', 'codex'],
      ['agents.instruction', ''],
      ['agents.codex.requestTimeoutSeconds', 120],
      ['agents.codex.observe', { enabled: false,  intervalSeconds: 1 }]
    ])
    const client = createTestCodexClient({
      get: async (path: string) => values.get(path)
    } as unknown as Configer)
    const runtimeConfig = await client['readRuntimeConfig']()
    expect(runtimeConfig.noProxyHosts).toEqual([
      'localhost',
      '127.0.0.1',
      '::1',
      '127.0.0.1',
      'next.firco.cn',
      '*.firco.cn'
    ])
  })

  it('uses data workspace and a filesystem codex command by default', async () => {
    const values = new Map<string, unknown>([
      ['agents.codex.bundled', true],
      ['app.workspace.path', ''],
      ['proxy.enabled', false],
      ['proxy.host', '127.0.0.1'],
      ['proxy.port', 7890],
      ['proxy.noProxy', ''],
      ['server.host', '127.0.0.1'],
      ['agents.codex.command', 'codex'],
      ['agents.instruction', ''],
      ['agents.codex.requestTimeoutSeconds', 120],
      ['agents.codex.observe', { enabled: false,  intervalSeconds: 1 }]
    ])
    const dir = await mkdtemp(join(tmpdir(), 'codexio-default-workspace-'))
    const metadata = new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      dataPath: dir
    })
    const client = createTestCodexClient({
      get: async (path: string) => values.get(path)
    } as unknown as Configer, metadata)
    const runtimeConfig = await client['readRuntimeConfig']()
    expect(runtimeConfig.processCwd).toBe(join(dir, 'workspace'))
    expect(runtimeConfig.command).not.toContain('app.asar')
  })

  it('resolves the system codex command by platform search order', async () => {
    const previousPath = process.env.PATH
    const previousLocalAppData = process.env.LOCALAPPDATA
    const previousUserProfile = process.env.USERPROFILE
    const localAppData = await mkdtemp(join(tmpdir(), 'codexio-localappdata-'))
    const userProfile = await mkdtemp(join(tmpdir(), 'codexio-userprofile-'))
    const pathBin = await mkdtemp(join(tmpdir(), 'codexio-path-bin-'))
    const localBin = join(localAppData, 'OpenAI', 'Codex', 'bin', 'system-codex')
    const vscodeBin = join(userProfile, '.vscode', 'extensions', 'openai.chatgpt-test', 'bin', 'windows-x86_64')
    await mkdir(localBin, {
      recursive: true
    })
    await mkdir(vscodeBin, {
      recursive: true
    })
    await writeFile(join(localBin, 'codex.exe'), '')
    await writeFile(join(vscodeBin, 'codex.exe'), '')
    await writeFile(join(pathBin, process.platform === 'win32' ? 'codex.exe' : 'codex'), '')
    process.env.PATH = pathBin
    process.env.LOCALAPPDATA = localAppData
    process.env.USERPROFILE = userProfile
    try {
      const values = new Map<string, unknown>([
        ['agents.codex.bundled', false],
        ['app.workspace.path', ''],
        ['proxy.enabled', false],
        ['proxy.host', '127.0.0.1'],
        ['proxy.port', 7890],
        ['proxy.noProxy', ''],
        ['server.host', '127.0.0.1'],
        ['agents.codex.command', 'codex'],
        ['agents.instruction', ''],
        ['agents.codex.requestTimeoutSeconds', 120],
        ['agents.codex.observe', { enabled: false,  intervalSeconds: 1 }]
      ])
      const metadata = new CodexioMetadata({
        rootPath: testMetadata.rootPath,
        dataPath: await mkdtemp(join(tmpdir(), 'codexio-command-resolution-'))
      })
      const client = createTestCodexClient({
        get: async (path: string) => values.get(path)
      } as unknown as Configer, metadata)
      const runtimeConfig = await client['readRuntimeConfig']()
      const expectedCommand = process.platform === 'win32' ? join(vscodeBin, 'codex.exe') : join(pathBin, 'codex')
      expect(runtimeConfig.command).toBe(expectedCommand)
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = previousPath
      }
      if (previousLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA
      } else {
        process.env.LOCALAPPDATA = previousLocalAppData
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE
      } else {
        process.env.USERPROFILE = previousUserProfile
      }
    }
  })

  it('does not resolve the external codex command from its own package bin', async () => {
    const previousPath = process.env.PATH
    const previousLocalAppData = process.env.LOCALAPPDATA
    const previousUserProfile = process.env.USERPROFILE
    const rootPath = await mkdtemp(join(tmpdir(), 'codexio-root-'))
    const dataPath = await mkdtemp(join(tmpdir(), 'codexio-data-'))
    process.env.LOCALAPPDATA = await mkdtemp(join(tmpdir(), 'codexio-localappdata-'))
    process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'codexio-userprofile-'))
    const localBin = join(rootPath, 'node_modules', '.bin')
    const systemBin = await mkdtemp(join(tmpdir(), 'codexio-system-bin-'))
    await mkdir(localBin, {
      recursive: true
    })
    const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex'
    await writeFile(join(localBin, executableName), '')
    await writeFile(join(systemBin, executableName), '')
    process.env.PATH = [
      localBin,
      systemBin
    ].join(delimiter)
    try {
      const values = new Map<string, unknown>([
        ['agents.codex.bundled', false],
        ['app.workspace.path', ''],
        ['proxy.enabled', false],
        ['proxy.host', '127.0.0.1'],
        ['proxy.port', 7890],
        ['proxy.noProxy', ''],
        ['server.host', '127.0.0.1'],
        ['agents.codex.command', 'codex'],
        ['agents.instruction', ''],
        ['agents.codex.requestTimeoutSeconds', 120],
        ['agents.codex.observe', { enabled: false,  intervalSeconds: 1 }]
      ])
      const client = createTestCodexClient({
        get: async (path: string) => values.get(path)
      } as unknown as Configer, new CodexioMetadata({
        rootPath,
        dataPath
      }))
      const runtimeConfig = await client['readRuntimeConfig']()
      expect(runtimeConfig.command).toBe(join(systemBin, executableName))
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = previousPath
      }
      if (previousLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA
      } else {
        process.env.LOCALAPPDATA = previousLocalAppData
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE
      } else {
        process.env.USERPROFILE = previousUserProfile
      }
    }
  })

  it('requires external Codex when observing VS Code replies', () => {
    const bundled = createDefaultConfig()
    bundled.agents.codex.observe.enabled = true
    expect(() => validateCodexioConfig(bundled)).toThrow('agents.codex.enabled must be true')
    expect(() => validateCodexioConfig(bundled)).toThrow('agents.codex.bundled must be false')
  })

  it('adds Codexio file delivery instructions to new codex threads', async () => {
    const values = new Map<string, unknown>([
      ['agents.codex.bundled', false],
      ['app.workspace.path', '~'],
      ['proxy.enabled', false],
      ['proxy.host', '127.0.0.1'],
      ['proxy.port', 7890],
      ['proxy.noProxy', ''],
      ['server.host', '127.0.0.1'],
      ['agents.codex.command', 'codex'],
      ['agents.instruction', 'File rule with Markdown reference'],
      ['agents.codex.requestTimeoutSeconds', 120],
      ['agents.codex.observe', { enabled: false,  intervalSeconds: 1 }]
    ])
    const client = createTestCodexClient({
      get: async (path: string) => values.get(path)
    } as unknown as Configer)
    let threadStartParams: Record<string, unknown> | undefined
    client['request'] = async (method: string, params?: unknown) => {
      if (method === 'thread/start') {
        threadStartParams = params as Record<string, unknown>
        return {
          thread: {
            id: 'thread-1',
            name: 'thread'
          }
        }
      }
      throw new Error(method)
    }
    await client['startThread']({ id: 'io-thread', name: 'Thread' })
    expect(String(threadStartParams?.developerInstructions)).toContain('Markdown reference')
  })

  it('adds the resolved codex executable directory to codex thread instructions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-command-dir-'))
    const codexCommand = join(dir, 'bin', 'codex.exe')
    const values = new Map<string, unknown>([
      ['agents.codex.bundled', false],
      ['app.workspace.path', '~'],
      ['proxy.enabled', false],
      ['proxy.host', '127.0.0.1'],
      ['proxy.port', 7890],
      ['proxy.noProxy', ''],
      ['server.host', '127.0.0.1'],
      ['agents.codex.command', codexCommand],
      ['agents.instruction', 'Project instruction'],
      ['agents.codex.requestTimeoutSeconds', 120],
      ['agents.codex.observe', { enabled: false,  intervalSeconds: 1 }]
    ])
    const client = createTestCodexClient({
      get: async (path: string) => values.get(path)
    } as unknown as Configer)
    let threadStartParams: Record<string, unknown> | undefined
    client['request'] = async (method: string, params?: unknown) => {
      if (method === 'thread/start') {
        threadStartParams = params as Record<string, unknown>
        return {
          thread: {
            id: 'thread-1',
            name: 'thread'
          }
        }
      }
      throw new Error(method)
    }
    await client['startThread']({ id: 'io-thread', name: 'Thread' })
    expect(String(threadStartParams?.developerInstructions)).toContain('Project instruction')
    expect(String(threadStartParams?.developerInstructions)).toContain(`Codex executable directory: ${dirname(codexCommand)}`)
  })

  it('does not add a codex executable directory instruction for unresolved bare commands', async () => {
    const values = new Map<string, unknown>([
      ['agents.codex.bundled', false],
      ['app.workspace.path', '~'],
      ['proxy.enabled', false],
      ['proxy.host', '127.0.0.1'],
      ['proxy.port', 7890],
      ['proxy.noProxy', ''],
      ['server.host', '127.0.0.1'],
      ['agents.codex.command', 'codexio-missing-command'],
      ['agents.instruction', 'Project instruction'],
      ['agents.codex.requestTimeoutSeconds', 120],
      ['agents.codex.observe', { enabled: false,  intervalSeconds: 1 }]
    ])
    const client = createTestCodexClient({
      get: async (path: string) => values.get(path)
    } as unknown as Configer)
    const runtimeConfig = await client['readRuntimeConfig']()
    expect(runtimeConfig.command).toBe('codexio-missing-command')
    expect(runtimeConfig.instruction).toBe('Project instruction')
  })

  it('starts new codex threads inside the io thread workspace when enabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-thread-workspace-'))
    const values = new Map<string, unknown>([
      ['agents.codex.bundled', false],
      ['app.workspace.path', dir],
      ['app.workspace.perIoThread', true],
      ['proxy.enabled', false],
      ['proxy.host', '127.0.0.1'],
      ['proxy.port', 7890],
      ['proxy.noProxy', ''],
      ['server.host', '127.0.0.1'],
      ['agents.codex.command', 'codex'],
      ['agents.instruction', ''],
      ['agents.codex.requestTimeoutSeconds', 120],
      ['agents.codex.observe', { enabled: false,  intervalSeconds: 1 }]
    ])
    const client = createTestCodexClient({
      get: async (path: string) => values.get(path)
    } as unknown as Configer)
    let threadStartParams: Record<string, unknown> | undefined
    client['request'] = async (method: string, params?: unknown) => {
      if (method === 'thread/start') {
        threadStartParams = params as Record<string, unknown>
        return {
          thread: {
            id: 'thread-1',
            name: 'thread'
          }
        }
      }
      throw new Error(method)
    }
    await client['startThread']({ id: 'io-thread', name: 'Thread' })
    expect(threadStartParams?.cwd).toBe(join(dir, 'io-thread'))
  })

  it('emits codex client thread callbacks as single threads', () => {
    const client = createTestCodexClient({
      get: async () => undefined
    } as unknown as Configer)
    const threads: CodexClientThread[] = []
    client.on('thread', (thread) => {
      threads.push(thread)
    })
    client['upsertThread']({
      id: 'codex-thread',
      title: 'Thread',
      isWorking: false
    })
    client['removeThread']('codex-thread')
    expect(threads).toEqual([
      {
        id: 'codex-thread',
        title: 'Thread',
        isWorking: false
      },
      {
        id: 'codex-thread',
        title: 'Thread',
        isWorking: false,
        deleted: true
      }
    ])
  })

  it('sends non-web channel messages to the web thread history', async () => {
    const sent: Message[] = []
    const output = new WebChannelOutput({
      get: async (path: string) => {
        if (path === 'channelo.web') {
          return {
            enabled: true
          }
        }
        if (path === 'server.host') {
          return '127.0.0.1'
        }
        if (path === 'server.port') {
          return 8787
        }
        return undefined
      }
    } as unknown as Configer, {
      send: (message: Message) => {
        sent.push(message)
        return Result.successVoid()
      }
    }, new ServerRuntime())
    expect(await output.start()).toBe(true)
    const result = await output.send({
      thread: { id: 'external-io-thread', name: '新对话' },
      role: 'agent',
      text: 'external'
    })
    expect(result.isFailed).toBe(false)
    expect(sent).toMatchObject([
      {
        thread: { id: 'external-io-thread', name: '新对话' },
        role: 'agent',
        text: 'external'
      }
    ])
  })

  it('stores non-web channel messages in an io thread web view', () => {
    const manager = new WebThreadManager(createThreadRegistry())
    manager.appendMessage(createMessage({
      id: 'external-user',
      occurredAt: 1,
      thread: { id: 'external-io-thread', name: '新对话' },
      role: 'user',
      text: 'hello'
    }))
    manager.appendMessage(createMessage({
      id: 'external-agent',
      occurredAt: 2,
      thread: { id: 'external-io-thread', name: '新对话' },
      role: 'agent',
      text: 'world'
    }))
    expect(manager.snapshot()).toMatchObject({
      threads: [
        {
          id: 'io:external-io-thread',
          thread: { id: 'external-io-thread', name: '新对话' }
        }
      ],
      messages: [
        {
          role: 'user',
          webThreadId: 'io:external-io-thread',
          text: 'hello'
        },
        {
          role: 'agent',
          webThreadId: 'io:external-io-thread',
          text: 'world'
        }
      ]
    })
  })

  it('continues an explicit Codex thread without requiring a process-local cache entry', async () => {
    const client = createTestCodexClient({
      get: async () => undefined
    } as unknown as Configer)
    const requests: Array<{ method: string, params?: unknown }> = []
    const ignoreThread = vi.spyOn(client['observerLifecycle'], 'ignoreThread')
    client['request'] = async (method: string, params?: unknown) => {
      requests.push({ method, params })
      if (method === 'thread/resume') {
        return {
          thread: {
            id: 'codex-thread',
            name: 'VS Code thread',
            status: { type: 'idle' }
          }
        }
      }
      if (method === 'turn/start') {
        return {
          turn: {
            id: 'continued-turn',
            threadId: 'codex-thread'
          }
        }
      }
      throw new Error(method)
    }

    const result = await client.send({
      thread: { id: 'codex-thread', name: 'VS Code thread' },
      threadId: 'codex-thread',
      text: 'continue'
    })

    expect(result.isFailed).toBe(false)
    expect(ignoreThread).not.toHaveBeenCalled()
    expect(requests).toEqual([
      {
        method: 'thread/resume',
        params: {
          threadId: 'codex-thread',
          excludeTurns: true
        }
      },
      {
        method: 'turn/start',
        params: {
          threadId: 'codex-thread',
          input: [{
            type: 'text',
            text: 'continue',
            text_elements: []
          }]
        }
      }
    ])
  })

  it('applies the configured model and reasoning effort to every new turn', async () => {
    const client = createTestCodexClient({
      get: async (path: string) => new Map<string, unknown>([
        ['agents.codex.model', 'gpt-5.6-sol'],
        ['agents.codex.reasoningEffort', 'medium']
      ]).get(path)
    } as unknown as Configer)
    client['threads'].set('codex-thread', {
      id: 'codex-thread',
      title: 'Thread',
      isWorking: false
    })
    const requests: Array<{ method: string, params?: unknown }> = []
    client['request'] = async (method: string, params?: unknown) => {
      requests.push({ method, params })
      return {
        turn: {
          id: 'turn',
          threadId: 'codex-thread'
        }
      }
    }

    const result = await client.send({
      thread: { id: 'io-thread', name: 'Thread' },
      threadId: 'codex-thread',
      text: 'continue'
    })

    expect(result.isFailed).toBe(false)
    expect(requests).toEqual([{
      method: 'turn/start',
      params: {
        threadId: 'codex-thread',
        input: [{
          type: 'text',
          text: 'continue',
          text_elements: []
        }],
        model: 'gpt-5.6-sol',
        effort: 'medium'
      }
    }])
  })

  it('never creates a replacement thread when an explicit Codex thread cannot resume', async () => {
    const client = createTestCodexClient({
      get: async () => undefined
    } as unknown as Configer)
    const requests: string[] = []
    client['request'] = async (method: string) => {
      requests.push(method)
      throw new Error('thread not found')
    }

    const result = await client.send({
      thread: { id: 'codex-thread', name: 'VS Code thread' },
      threadId: 'codex-thread',
      text: 'continue'
    })

    expect(result.isFailed).toBe(true)
    expect(result.message).toContain('thread not found')
    expect(requests).toEqual(['thread/resume'])
  })

  it('does not resume an explicit Codex thread already loaded by this client', async () => {
    const client = createTestCodexClient({
      get: async () => undefined
    } as unknown as Configer)
    client['threads'].set('codex-thread', {
      id: 'codex-thread',
      title: 'VS Code thread',
      isWorking: false
    })
    const requests: string[] = []
    client['request'] = async (method: string) => {
      requests.push(method)
      if (method === 'turn/start') {
        return {
          turn: {
            id: 'continued-turn',
            threadId: 'codex-thread'
          }
        }
      }
      throw new Error(method)
    }

    const result = await client.send({
      thread: { id: 'codex-thread', name: 'VS Code thread' },
      threadId: 'codex-thread',
      text: 'continue'
    })

    expect(result.isFailed).toBe(false)
    expect(requests).toEqual(['turn/start'])
  })

  it('rejects a resume response for a different Codex thread identity', async () => {
    const client = createTestCodexClient({
      get: async () => undefined
    } as unknown as Configer)
    const requests: string[] = []
    client['request'] = async (method: string) => {
      requests.push(method)
      return {
        thread: {
          id: 'different-thread',
          name: 'Different thread'
        }
      }
    }

    const result = await client.send({
      thread: { id: 'codex-thread', name: 'VS Code thread' },
      threadId: 'codex-thread',
      text: 'continue'
    })

    expect(result.isFailed).toBe(true)
    expect(result.message).toContain('codex resumed unexpected thread: different-thread')
    expect(requests).toEqual(['thread/resume'])
    expect(client['threads'].size).toBe(0)
  })

  it('keeps new Codexio threads out of external thread observation', async () => {
    const values = new Map<string, unknown>([
      ['agents.codex.bundled', false],
      ['app.workspace.path', '~'],
      ['proxy.enabled', false],
      ['proxy.host', '127.0.0.1'],
      ['proxy.port', 7890],
      ['proxy.noProxy', ''],
      ['server.host', '127.0.0.1'],
      ['agents.codex.command', 'codex'],
      ['agents.instruction', ''],
      ['agents.codex.requestTimeoutSeconds', 120],
      ['agents.codex.observe', { enabled: true, intervalSeconds: 1 }]
    ])
    const client = createTestCodexClient({
      get: async (path: string) => values.get(path)
    } as unknown as Configer)
    const ignoreThread = vi.spyOn(client['observerLifecycle'], 'ignoreThread')
    client['request'] = async (method: string) => {
      if (method === 'thread/start') {
        return {
          thread: {
            id: 'new-thread',
            name: 'New thread'
          }
        }
      }
      if (method === 'turn/start') {
        return {
          turn: {
            id: 'new-turn',
            threadId: 'new-thread'
          }
        }
      }
      throw new Error(method)
    }

    const result = await client.send({
      thread: { id: 'io-thread', name: 'New thread' },
      text: 'start'
    })

    expect(result.isFailed).toBe(false)
    expect(ignoreThread).toHaveBeenCalledExactlyOnceWith('new-thread')
  })

  it('upserts repeated web messages by stable message id', () => {
    const manager = new WebThreadManager(createThreadRegistry())
    const message = createMessage({
      id: 'stable-message',
      thread: { id: 'io-thread', name: 'Thread' },
      role: 'agent',
      text: 'reply'
    })
    const first = manager.appendMessage(message)
    const second = manager.appendMessage(message)
    expect(second.id).toBe(first.id)
    expect(manager.snapshot().messages).toHaveLength(1)
  })

  it('updates web thread names from the thread registry', () => {
    const registry = createThreadRegistry()
    const original = registry.ensure('external-io-thread', 'Original name')
    const manager = new WebThreadManager(registry)
    manager.appendMessage(createMessage({
      id: 'rename-message',
      thread: original,
      role: 'agent',
      text: 'hello'
    }))
    registry.rename(original.id, 'Updated name')
    expect(manager.snapshot().threads).toMatchObject([{
      thread: {
        id: original.id,
        name: 'Updated name'
      }
    }])
    expect(manager.snapshot().messages).toMatchObject([{
      thread: {
        id: original.id,
        name: 'Updated name'
      }
    }])
  })

  it('resolves tilde workspace paths to the user home directory', async () => {
    const parsed = await parseCodexioConfig({
      app: {
        workspace: {
          path: null
        }
      }
    }, 'config.yaml')
    expect(parsed.app.workspace.path).toBe('~')
    expect(resolveUserPath('~')).toBe(homedir())
    expect(resolveUserPath('~/work')).toBe(join(homedir(), 'work'))
    expect(resolveUserPath('~\\work')).toBe(join(homedir(), 'work'))
    const values = new Map<string, unknown>([
      ['agents.codex.bundled', false],
      ['app.workspace.path', '~'],
      ['proxy.enabled', false],
      ['proxy.host', '127.0.0.1'],
      ['proxy.port', 7890],
      ['proxy.noProxy', ''],
      ['server.host', '127.0.0.1'],
      ['agents.codex.command', 'codex'],
      ['agents.instruction', ''],
      ['agents.codex.requestTimeoutSeconds', 120],
      ['agents.codex.observe', { enabled: false,  intervalSeconds: 1 }]
    ])
    const client = createTestCodexClient({
      get: async (path: string) => values.get(path)
    } as unknown as Configer)
    const runtimeConfig = await client['readRuntimeConfig']()
    expect(runtimeConfig.processCwd).toBe(homedir())
  })

  it('resolves relative app workspaces from the Codexio data directory', async () => {
    const dataPath = await mkdtemp(join(tmpdir(), 'codexio-relative-workspace-'))
    const resolver = new ThreadWorkspaceResolver({
      get: async (path: string) => path === 'app.workspace.path' ? 'workspace' : false
    } as unknown as Configer, new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      dataPath
    }))
    expect(await resolver.resolveBase()).toBe(join(dataPath, 'workspace'))
  })

  it('removes the final newline from rendered markdown html', () => {
    expect(renderMarkdownHtml('你好。')).toBe('<p>你好。</p>')
  })

  it('parses markdown attachment references', () => {
    expect(parseMarkdownAttachmentReferences('图片 ![图](https://example.com/a.png) 下载 [官网](https://example.com/a.zip) 文件 [说明](./docs/readme.md)')).toEqual({
      text: '图片 `https://example.com/a.png` 下载 [官网](https://example.com/a.zip) 文件 `./docs/readme.md`',
      files: [
        {
          label: '图',
          path: 'https://example.com/a.png',
          image: true
        },
        {
          label: '说明',
          path: './docs/readme.md',
          image: false
        }
      ]
    })
  })

  it('binds one channel thread identity to one io thread', () => {
    const manager = createThreadRegistry()
    const ioThreadId = 'io-thread'
    expect(manager.getLastActive()).toBeUndefined()
    manager.bind(ioThreadId, {
      source: 'feishu',
      id: ' chat:thread:omt_1 '
    })
    expect(manager.getLastActive()?.id).toBe(ioThreadId)
    expect(manager.resolve({
      source: 'feishu',
      id: 'chat:thread:omt_1'
    }).id).toBe(ioThreadId)
    expect(manager.getLastActive()?.id).toBe(ioThreadId)
    expect(manager.resolve({
      source: 'email',
      id: 'chat:thread:omt_1'
    }).id).not.toBe(ioThreadId)
  })

  it('binds multiple channels to one io thread', () => {
    const manager = createThreadRegistry()
    const ioThreadId = 'io-thread'
    manager.bind(ioThreadId, {
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })
    manager.bind(ioThreadId, {
      source: 'email',
      id: 'mailbox:root:message-1'
    })
    expect(manager.resolve({
      source: 'email',
      id: 'mailbox:root:message-1'
    }).id).toBe(ioThreadId)
    expect(manager.getChannelThreadIds(ioThreadId)).toEqual([
      {
        source: 'feishu',
        id: 'chat:thread:omt_1'
      },
      {
        source: 'email',
        id: 'mailbox:root:message-1'
      }
    ])
    expect(manager.getLastActive()?.id).toBe(ioThreadId)
  })

  it('uses the last active io thread for system messages', async () => {
    const sent: Message[] = []
    const threadRegistry = createThreadRegistry()
    const manager = await createRecordingChannelOutputManager(sent, threadRegistry)
    expect((await manager.sendSystem('empty')).isFailed).toBe(true)
    threadRegistry.bind('io-thread-system', {
      source: 'web',
      id: 'io-thread-system'
    })
    const result = await manager.sendSystem('system message')
    expect(result.isFailed).toBe(false)
    expect(sent).toMatchObject([
      {
        thread: { id: 'io-thread-system', name: '新对话' },
        role: 'system',
        text: 'system message'
      }
    ])
  })

  it('owns channel output config subscriptions for exactly one lifecycle', async () => {
    let subscriptions = 0
    let disposals = 0
    const configer = {
      subscribe: () => {
        subscriptions += 1
        return {
          dispose: () => {
            disposals += 1
          }
        }
      },
      get: async (path: string) => path === 'app.workspace.path' ? '~' : undefined
    } as unknown as Configer
    const manager = await createRecordingChannelOutputManager([], createThreadRegistry(), ['web'], configer)
    await manager.start()
    expect(subscriptions).toBe(1)
    await manager.stop()
    expect(disposals).toBe(1)
    await manager.start()
    expect(subscriptions).toBe(2)
    await manager.stop()
  })

  it('creates and binds an io thread when getting a new channel thread id', () => {
    const manager = createThreadRegistry()
    const ioThreadId = manager.resolve({
      source: 'feishu',
      id: 'chat:thread:omt_1'
    }).id
    expect(ioThreadId).toBeTruthy()
    expect(manager.resolve({
      source: 'feishu',
      id: 'chat:thread:omt_1'
    }).id).toBe(ioThreadId)
  })

  it('rejects binding one channel thread id to two io threads', () => {
    const manager = createThreadRegistry()
    manager.bind('io-thread-a', {
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })
    expect(() => manager.bind('io-thread-b', {
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })).toThrow('thread key already bound')
  })

  it('keeps channel thread ids source scoped', () => {
    const manager = createThreadRegistry()
    manager.bind('io-thread-feishu', {
      source: 'feishu',
      id: 'same-id'
    })
    manager.bind('io-thread-email', {
      source: 'email',
      id: 'same-id'
    })
    expect(manager.resolve({
      source: 'feishu',
      id: 'same-id'
    }).id).toBe('io-thread-feishu')
    expect(manager.resolve({
      source: 'email',
      id: 'same-id'
    }).id).toBe('io-thread-email')
  })

  it('rejects more than one id of the same channel on one io thread', () => {
    const manager = createThreadRegistry()
    manager.bind('io-thread', {
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })
    expect(() => manager.bind('io-thread', {
      source: 'feishu',
      id: 'chat:thread:omt_2'
    })).toThrow('thread source already bound')
    expect(manager.resolve({
      source: 'feishu',
      id: 'chat:thread:omt_1'
    }).id).toBe('io-thread')
  })

  it('restores io thread identities from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-io-thread-'))
    const metadata = new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      dataPath: dir
    })
    const manager = new ThreadRegistry(metadata)
    const ioThreadId = manager.resolve({
      source: 'feishu',
      id: 'chat-1:thread:omt_1'
    }, 'Saved thread').id
    manager.bind(ioThreadId, {
      source: 'web',
      id: 'web-thread'
    })
    await manager.flush()
    const persisted = JSON.parse(await readFile(metadata.ioThreadStatePath, 'utf8')) as {
      lastActiveThreadId?: string
    }
    expect(persisted.lastActiveThreadId).toBe(ioThreadId)
    const restored = new ThreadRegistry(metadata)
    await restored.init()
    expect(restored.resolve({
      source: 'feishu',
      id: 'chat-1:thread:omt_1'
    }).id).toBe(ioThreadId)
    expect(restored.resolve({
      source: 'web',
      id: 'web-thread'
    }).id).toBe(ioThreadId)
    expect(restored.getLastActive()?.id).toBe(ioThreadId)
  })

  it('rejects duplicated io thread ids in persisted state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-io-thread-duplicated-'))
    const metadata = new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      dataPath: dir
    })
    await mkdir(join(dir, 'state'), {
      recursive: true
    })
    await writeFile(metadata.ioThreadStatePath, JSON.stringify({
      version: 3,
      threads: [
        {
          id: 'io-thread',
          name: '新对话',
          channelThreadIds: [
            {
              source: 'feishu',
              id: 'chat-1:thread:omt_1'
            }
          ],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'io-thread',
          name: '新对话',
          channelThreadIds: [
            {
              source: 'feishu',
              id: 'chat-1:thread:omt_2'
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    }), 'utf8')
    const manager = new ThreadRegistry(metadata)
    await expect(manager.init()).rejects.toThrow('thread id duplicated in state')
  })

  it('reports io thread persist failures through flush', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-io-thread-failed-'))
    const blockedDataPath = join(dir, 'data-file')
    await writeFile(blockedDataPath, 'not a directory')
    const metadata = new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      dataPath: blockedDataPath
    })
    const manager = new ThreadRegistry(metadata)
    manager.resolve({
      source: 'feishu',
      id: 'chat-1:thread:omt_1'
    })
    await expect(manager.flush()).rejects.toThrow()
  })

  it('broadcasts channel messages without storing conversation history', async () => {
    const sent: Message[] = []
    const manager = await createRecordingChannelOutputManager(sent)
    await manager.send(createMessage({
      id: 'user-message',
      thread: { id: 'io-thread', name: '新对话' },
      role: 'user',
      text: 'hello'
    }), 'web')
    expect(sent).toMatchObject([
      {
        thread: { id: 'io-thread', name: '新对话' },
        role: 'user',
        text: 'hello'
      }
    ])
  })

  it('routes channel output to every enabled channel', async () => {
    const sent: Array<{ type: string, message: Message }> = []
    const manager = await createRecordingChannelOutputManager(sent, createThreadRegistry(), [
      'web',
      'feishu',
      'feishuWebhook',
      'email'
    ])
    await manager.send(createMessage({
      id: 'broadcast-agent',
      thread: { id: 'io-thread', name: '新对话' },
      role: 'agent',
      text: 'hello'
    }), 'feishu')
    await manager.stop()
    expect(sent.map((item) => item.type)).toEqual([
      'web',
      'feishu',
      'feishuWebhook',
      'email'
    ])
  })

  it('replies to feishu source messages in the topic thread', async () => {
    const threadRegistry = createThreadRegistry()
    threadRegistry.bind('io-thread', {
      source: 'feishu',
      id: 'chat-1:thread:omt_1'
    })
    const calls: unknown[] = []
    const output = new FeishuChannelOutput({
      get: async (path: string) => {
        if (path === 'channelo.feishu') {
          return {
            enabled: true,
            appId: 'app-id',
            appSecret: 'app-secret',
            chatId: 'chat-1'
          }
        }
        return undefined
      }
    } as unknown as Configer, threadRegistry)
    await output.start()
    Reflect.set(output, 'client', {
      im: {
        v1: {
          message: {
            list: async () => ({
              data: {
                items: [{
                  message_id: 'om_user',
                  thread_id: 'omt_1'
                }]
              }
            }),
            create: async (payload: unknown) => {
              calls.push(payload)
              return {
                data: {
                  message_id: 'om_created',
                  thread_id: 'omt_1'
                }
              }
            },
            reply: async (payload: unknown) => {
              calls.push(payload)
              return {
                data: {
                  message_id: 'om_reply',
                  thread_id: 'omt_1'
                }
              }
            }
          }
        }
      }
    })
    const first = await output.send({
      id: 'message-1',
      thread: { id: 'io-thread', name: '新对话' },
      role: 'agent',
      text: 'hello'
    }, {
      source: 'feishu',
      sourceMessageId: 'om_user'
    })
    expect(first.isFailed).toBe(false)
    const second = await output.send({
      id: 'message-2',
      thread: { id: 'io-thread', name: '新对话' },
      role: 'agent',
      text: 'again'
    }, {
      source: 'feishu',
      sourceMessageId: 'om_user'
    })
    expect(second.isFailed).toBe(false)
    expect(calls).toMatchObject([
      {
        path: {
          message_id: 'om_user'
        },
        data: {
          reply_in_thread: true,
          uuid: expect.any(String)
        }
      },
      {
        path: {
          message_id: 'om_user'
        },
        data: {
          reply_in_thread: true,
          uuid: expect.any(String)
        }
      }
    ])
    expect(Reflect.get(calls[0] as object, 'data').uuid).not.toBe(Reflect.get(calls[1] as object, 'data').uuid)
  })

  it('creates a feishu topic for non-feishu output and continues with reply', async () => {
    const threadRegistry = createThreadRegistry()
    const calls: unknown[] = []
    const output = new FeishuChannelOutput({
      get: async (path: string) => {
        if (path === 'channelo.feishu') {
          return {
            enabled: true,
            appId: 'app-id',
            appSecret: 'app-secret',
            chatId: 'chat-1'
          }
        }
        return undefined
      }
    } as unknown as Configer, threadRegistry)
    await output.start()
    Reflect.set(output, 'client', {
      im: {
        v1: {
          message: {
            list: async () => ({
              data: {
                items: [{
                  message_id: 'om_created',
                  thread_id: 'omt_1'
                }]
              }
            }),
            create: async (payload: unknown) => {
              calls.push(payload)
              return {
                data: {
                  message_id: 'om_created',
                  thread_id: 'omt_1'
                }
              }
            },
            reply: async (payload: unknown) => {
              calls.push(payload)
              return {
                data: {
                  message_id: 'om_reply',
                  thread_id: 'omt_1'
                }
              }
            }
          }
        }
      }
    })
    const first = await output.send({
      thread: { id: 'io-thread', name: '新对话' },
      role: 'agent',
      text: 'hello'
    }, {
      source: 'web'
    })
    expect(first.isFailed).toBe(false)
    expect(threadRegistry.getChannelThreadIds('io-thread')).toEqual([
      {
        source: 'feishu',
        id: 'chat-1:thread:omt_1'
      }
    ])
    const second = await output.send({
      thread: { id: 'io-thread', name: '新对话' },
      role: 'agent',
      text: 'again'
    }, {
      source: 'web'
    })
    expect(second.isFailed).toBe(false)
    expect(calls).toMatchObject([
      {
        params: {
          receive_id_type: 'chat_id'
        },
        data: {
          receive_id: 'chat-1'
        }
      },
      {
        path: {
          message_id: 'om_created'
        },
        data: {
          reply_in_thread: true
        }
      }
    ])
  })

  it('turns agent markdown file references into message files before output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-output-file-'))
    const imagePath = join(dir, 'agent.png')
    await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'))
    const sent: Message[] = []
    const manager = await createRecordingChannelOutputManager(sent, createThreadRegistry(), [
      'web'
    ])
    const resolved = await new MessageFileResolver(new FileStore(new CodexioMetadata({ rootPath: dir }))).resolve(createMessage({
      id: 'absolute-file-agent',
      thread: { id: 'io-thread', name: '新对话' },
      role: 'agent',
      text: `已生成：![agent](${imagePath.replaceAll('\\', '/')})`
    }), dir)
    await manager.send(resolved)
    await manager.stop()
    expect(sent).toHaveLength(1)
    expect(sent[0].files?.[0]).toMatchObject({
      name: 'agent.png',
      mime: 'image/png'
    })
    expect(sent[0].text).toContain('`')
  })

  it('resolves relative agent file references from the io thread workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-output-thread-file-'))
    const threadDir = join(dir, 'io-thread')
    await mkdir(threadDir, {
      recursive: true
    })
    await writeFile(join(threadDir, 'agent.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'))
    const sent: Message[] = []
    const manager = await createRecordingChannelOutputManager(sent, createThreadRegistry(), [
      'web'
    ], {
      subscribe: () => ({ dispose: () => undefined }),
      get: async (path: string) => {
        if (path === 'app.workspace.path') {
          return dir
        }
        if (path === 'app.workspace.perIoThread') {
          return true
        }
        return undefined
      }
    } as unknown as Configer)
    const resolved = await new MessageFileResolver(new FileStore(new CodexioMetadata({ rootPath: dir }))).resolve(createMessage({
      id: 'relative-file-agent',
      thread: { id: 'io-thread', name: '新对话' },
      role: 'agent',
      text: '已生成：![agent](./agent.png)'
    }), threadDir)
    await manager.send(resolved)
    await manager.stop()
    expect(sent[0].files?.[0]).toMatchObject({
      name: 'agent.png',
      mime: 'image/png'
    })
  })

  it('routes channel messages to echo by default and codex when enabled', async () => {
    let codexEnabled = false
    let subscriptionDisposed = false
    let configChanged: (() => Promise<void>) | undefined
    const echo = createRecordingAgent('echo')
    const codex = createRecordingAgent('codex')
    const configer = {
      get: async (path: string) => {
        if (path === 'agents.codex.enabled') {
          return codexEnabled
        }
        if (path === 'agents.echo.enabled') {
          return true
        }
        return undefined
      },
      subscribe: (_paths: unknown, listener: () => Promise<void>) => {
        configChanged = listener
        return {
          dispose: () => {
            subscriptionDisposed = true
          }
        }
      }
    } as unknown as Configer
    const workspaceResolver = new ThreadWorkspaceResolver(configer, testMetadata)
    const manager = new AgentManager(
      configer,
      codex,
      echo,
      workspaceResolver,
      new MessageFileResolver(new FileStore(testMetadata)),
      recordingMessageOutput()
    )
    await manager.start()
    await manager.receive(channelMessage('first'))
    expect(echo.messages.map((message) => message.text)).toEqual([
      'first'
    ])
    expect(codex.messages).toEqual([])
    codexEnabled = true
    await configChanged?.()
    await manager.receive(channelMessage('second'))
    expect(codex.messages.map((message) => message.text)).toEqual([
      'second'
    ])
    await manager.stop()
    expect(subscriptionDisposed).toBe(true)
  })

  it('buffers codex deltas until completion', async () => {
    const sent: Message[] = []
    const outputManager = recordingMessageOutput((message) => sent.push(message))
    const assembler = createCodexMessageAssembler(outputManager)
    const thread = {
      thread: { id: 'io-thread', name: '新对话' },
      agentThreadId: 'codex-thread',
      turnId: 'turn'
    }
    await assembler.append(thread, 'item', '你')
    await assembler.append(thread, 'item', '好')
    await assembler.append(thread, 'item', '。')
    expect(sent).toEqual([])
    await assembler.complete(thread, [
      {
        itemId: 'item',
        text: '你好。'
      }
    ])
    expect(sent).toMatchObject([
      {
        thread: { id: 'io-thread', name: '新对话' },
        role: 'agent',
        text: '你好。'
      }
    ])
  })

  it('routes an unbound Codex thread through its thread id IoThread', async () => {
    const sent: Message[] = []
    const outputManager = recordingMessageOutput((message) => sent.push(message))
    const configer = {
      get: async () => false
    } as unknown as Configer
    const assembler = createCodexMessageAssembler(outputManager)
    const agent = new CodexAgent(
      configer,
      createThreadRegistry(),
      {} as CodexClient,
      assembler
    )
    attachCodexAgentOutput(agent, assembler, outputManager)
    const completedMessage = {
      thread: {
        id: 'vscode-thread',
        name: 'VS Code thread'
      },
      turnId: 'vscode-turn',
      status: 'turnCompleted',
      role: 'assistant',
      text: '',
      messages: [{
        itemId: 'vscode-agent-message',
        role: 'assistant',
        text: 'VS Code reply'
      }]
    } as const
    await agent['receiveCodexMessage'](completedMessage)
    await agent['receiveCodexMessage'](completedMessage)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({
      id: expect.any(String),
      thread: { id: 'vscode-thread', name: 'VS Code thread' },
      role: 'agent',
      text: 'VS Code reply'
    })
    expect(sent[1].id).toBe(sent[0].id)
  })

  it('preserves known thread names and applies later Codex title updates', async () => {
    const sent: Message[] = []
    const outputManager = recordingMessageOutput((message) => sent.push(message))
    const registry = createThreadRegistry()
    registry.ensure('io-thread', 'Original prompt')
    const assembler = createCodexMessageAssembler(outputManager)
    const agent = new CodexAgent(
      { get: async () => false } as unknown as Configer,
      registry,
      {} as CodexClient,
      assembler
    )
    attachCodexAgentOutput(agent, assembler, outputManager)
    agent['bindThread']('io-thread', 'codex-thread')
    await agent['receiveCodexMessage']({
      thread: {
        id: 'codex-thread',
        name: '新对话'
      },
      turnId: 'turn',
      status: 'turnCompleted',
      role: 'assistant',
      text: '',
      messages: [{
        itemId: 'message',
        role: 'assistant',
        text: 'reply'
      }]
    })
    expect(sent[0].thread.name).toBe('Original prompt')
    agent['receiveCodexThread']({
      id: 'codex-thread',
      title: 'Generated title',
      isWorking: false
    })
    expect(registry.get('io-thread')?.name).toBe('Generated title')
  })

  it('publishes assembled Codex messages without channel context', async () => {
    const sent: Message[] = []
    const outputManager = recordingMessageOutput((message) => sent.push(message))
    const assembler = createCodexMessageAssembler(outputManager)
    await assembler.complete({
      thread: { id: 'io-thread', name: '新对话' },
      agentThreadId: 'codex-thread',
      turnId: 'turn'
    }, [
      {
        itemId: 'item',
        text: '你好。'
      }
    ])
    expect(sent).toMatchObject([
      {
        thread: { id: 'io-thread', name: '新对话' },
        role: 'agent',
        text: '你好。'
      }
    ])
  })

  it('replays repeated Codex completion with one canonical identity', async () => {
    const sent: Message[] = []
    const assembler = createCodexMessageAssembler(recordingMessageOutput((message) => sent.push(message)))
    const thread = {
      thread: { id: 'io-thread', name: '新对话' },
      agentThreadId: 'codex-thread',
      turnId: 'turn'
    }
    await assembler.append(thread, 'item', '你好')
    await assembler.completeItem(thread, 'item')
    await assembler.complete(thread, [
      {
        itemId: 'item',
        text: '你好'
      }
    ])
    expect(sent).toHaveLength(2)
    expect(sent).toMatchObject([
      {
        thread: { id: 'io-thread', name: '新对话' },
        role: 'agent',
        text: '你好'
      },
      {
        thread: { id: 'io-thread', name: '新对话' },
        role: 'agent',
        text: '你好'
      }
    ])
    expect(sent[1].id).toBe(sent[0].id)
    expect(sent[1]).not.toHaveProperty('revision')
  })
})

async function createRecordingChannelOutputManager(
  sent: Message[] | Array<{ type: string, message: Message }>,
  threadRegistry = createThreadRegistry(),
  enabledTypes = ['web'],
  configer = {
    subscribe: () => ({ dispose: () => undefined }),
    get: async (path: string) => path === 'app.workspace.path' ? '~' : undefined
  } as unknown as Configer
): Promise<ChannelOutputManager> {
  const output = (type: ChannelOutput['type']): ChannelOutput => ({
    type,
    start: async () => enabledTypes.includes(type),
    send: async (message: Message) => {
      if (enabledTypes.length === 1) {
        ;(sent as Message[]).push(message)
      } else {
        ;(sent as Array<{ type: string, message: Message }>).push({
          type,
          message
        })
      }
      return Result.successVoid()
    },
    stop: async () => Result.successVoid()
  })
  const manager = new ChannelOutputManager(
    configer,
    threadRegistry,
    output('web'),
    output('feishu'),
    output('feishuWebhook'),
    output('email'),
    output('nfirco')
  )
  await manager.start()
  return manager
}

function createThreadRegistry(): ThreadRegistry {
  return new ThreadRegistry(new CodexioMetadata({
    rootPath: testMetadata.rootPath,
    dataPath: join(tmpdir(), `codexio-io-thread-${randomUUID()}`)
  }))
}

function recordingMessageOutput(
  receive: (message: Message, context?: ChannelOutputContext) => void = () => undefined
): ChannelOutputManager {
  const send = async (message: Message, context?: ChannelOutputContext) => {
    receive(message, context)
    return Result.successVoid()
  }
  return {
    send
  } as unknown as ChannelOutputManager
}

function createCodexMessageAssembler(outputManager: ChannelOutputManager): CodexMessageAssembler {
  const assembler = new CodexMessageAssembler()
  assembler.start({
    receiveAgentOutput: (message) => outputManager.send(message)
  })
  return assembler
}

function attachCodexAgentOutput(agent: CodexAgent, assembler: CodexMessageAssembler, outputManager: ChannelOutputManager): void {
  const receiver = {
    receiveAgentOutput: (message: Message) => outputManager.send(message)
  }
  Reflect.set(agent, 'outputReceiver', receiver)
  assembler.start(receiver)
}

function recordingAgentManager(
  receive: (message: Message) => void = () => undefined
): AgentManager {
  return {
    receive: async (message: Message) => {
      receive(message)
      return Result.successVoid()
    }
  } as unknown as AgentManager
}

function disabledInput(type: ChannelInput['type']): ChannelInput {
  return {
    type,
    start: async () => false,
    stop: async () => Result.successVoid()
  }
}

function createRecordingAgent(type: string): Agent & { messages: Message[] } {
  const messages: Message[] = []
  return {
    type,
    messages,
    start: async () => Result.successVoid(),
    receive: async (message) => {
      messages.push(message)
      return Result.successVoid()
    },
    stop: async () => Result.successVoid()
  }
}

function channelMessage(text: string): Message {
  return createMessage({
    id: deriveMessageId('test-channel-message', text),
    thread: { id: 'io-thread', name: '新对话' },
    role: 'user',
    text
  })
}
