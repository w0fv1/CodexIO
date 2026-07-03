import { mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChannelOutputManager } from '../src/component/channelo/ChannelOutputManager.js'
import { Configer } from '../src/component/Configer.js'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { EventBus } from '../src/component/EventBus.js'
import { FileStore } from '../src/component/FileStore.js'
import { IoThreadIdManager } from '../src/component/IoThreadIdManager.js'
import { Agent } from '../src/component/agent/Agent.js'
import { AgentManager } from '../src/component/agent/AgentManager.js'
import { CodexClient } from '../src/component/agent/CodexClient.js'
import { CodexMessageStreamer } from '../src/component/agent/CodexMessageStreamer.js'
import { CommandExecutor, parseCommandInput } from '../src/controller/CommandExecutor.js'
import { AppEvent, ChannelMessageReceivedEvent } from '../src/value/Event.js'
import { ConfigSchema, createDefaultConfig, parseCodexioConfig, validateCodexioConfig } from '../src/value/ConfigDefinition.js'
import { Result } from '../src/value/Result.js'
import type { Message } from '../src/value/Message.js'
import { shouldReceiveFeishuMessage, shouldReceiveFeishuSender } from '../src/value/FeishuMessage.js'
import { parseMarkdownAttachmentReferences, renderMarkdownHtml } from '../src/util/Markdown.js'
import { resolveUserPath } from '../src/util/Path.js'
import { parseNfircoThreadSocketEvent } from '../src/component/channel/NfircoThreadClient.js'
import { applyRuntimeConfig } from '../src/CodexioApplication.js'

const testMetadata = new CodexioMetadata()

describe('core', () => {
  it('creates channel-only default config', () => {
    const config = createDefaultConfig()
    expect(config.server.host).toBe('127.0.0.1')
    expect(config.agents.codex.bundled).toBe(true)
    expect(config.agents.codex.instruction).toContain('Markdown reference')
    expect(config.agents.codex.instruction).toContain('previews without a file path')
    expect(config.workspace.path).toBe('')
    expect(config.proxy.host).toBe('127.0.0.1')
    expect(config.proxy.noProxy).toBe('')
    expect(config.channeli.web?.enabled).toBe(true)
    expect(config.channeli.feishu?.aite).toBe(true)
    expect(config.channeli.feishu?.allowedOpenIds).toEqual([])
    expect(config.channeli.nfirco?.enabled).toBe(false)
    expect(config.channelo.nfirco?.enabled).toBe(false)
    expect(config.channelo.web?.enabled).toBe(true)
  })

  it('parses nfirco thread message events', () => {
    expect(parseNfircoThreadSocketEvent({
      type: 'thread.message.created',
      eventId: 'event-1',
      threadUuid: 'thread-1',
      section: 'section-1',
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
      text: 'thread body'
    })).toEqual({
      type: 'thread.created',
      eventId: 'thread-2',
      threadUuid: 'thread-2',
      section: 'section-1',
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

  it('consumes test commands without sending them to the agent event', async () => {
    const eventBus = new EventBus()
    const executor = new CommandExecutor(eventBus)
    const result = await executor.receive({
      inputType: 'feishu',
      message: {
        ioThreadId: 'io-thread',
        role: 'user',
        text: '$test'
      },
      input: {
        platformThreadIds: [
          {
            source: 'feishu',
            id: 'chat:message:om_1'
          }
        ],
        text: '$test',
        mentioned: true,
        sender: {
          openId: 'ou_1'
        }
      }
    })
    expect(result.data?.consumed).toBe(true)
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

  it('keeps codex agent and workspace config fields when importing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-config-'))
    const configPath = join(dir, 'config.yaml')
    await writeFile(configPath, [
      'server:',
      '  token: test-token',
      'agents:',
      '  codex:',
      '    enabled: true',
      '    bundled: false',
      '    command: codex-dev',
      'workspace:',
      '  path: workspace',
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
    expect(await configer.get('agents.codex.enabled')).toBe(true)
    expect(await configer.get('agents.codex.bundled')).toBe(false)
    expect(await configer.get('agents.codex.command')).toBe('codex-dev')
    expect(await configer.get('workspace.path')).toBe('workspace')
    expect(await configer.get('proxy.port')).toBe(7891)
    expect(await configer.get('proxy.noProxy')).toBe('next.firco.cn,*.firco.cn')
    expect(await configer.get('channeli.web.enabled')).toBe(true)
    expect(await configer.get('channelo.web.enabled')).toBe(true)
  })

  it('enables auto port from runtime args', async () => {
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
    await applyRuntimeConfig(configer, [
      'node',
      'CodexioApplication.js',
      '--auto-port'
    ])
    expect(await configer.get('server.autoPort')).toBe(true)
  })

  it('passes configured no proxy hosts to the codex process', async () => {
    const values = new Map<string, unknown>([
      ['agents.codex.bundled', false],
      ['workspace.path', 'workspace'],
      ['proxy.enabled', true],
      ['proxy.host', '127.0.0.1'],
      ['proxy.port', 7890],
      ['proxy.noProxy', 'next.firco.cn, *.firco.cn ,'],
      ['server.host', '127.0.0.1'],
      ['agents.codex.command', 'codex'],
      ['agents.codex.instruction', ''],
      ['agents.codex.developerInstructions', ''],
      ['agents.codex.requestTimeoutSeconds', 120]
    ])
    const client = new CodexClient({
      get: async (path: string) => values.get(path)
    } as unknown as Configer, testMetadata)
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

  it('adds Codexio file delivery instructions to new codex threads', async () => {
    const values = new Map<string, unknown>([
      ['agents.codex.bundled', false],
      ['workspace.path', '~'],
      ['proxy.enabled', false],
      ['proxy.host', '127.0.0.1'],
      ['proxy.port', 7890],
      ['proxy.noProxy', ''],
      ['server.host', '127.0.0.1'],
      ['agents.codex.command', 'codex'],
      ['agents.codex.instruction', 'File rule with Markdown reference'],
      ['agents.codex.developerInstructions', 'Project rule'],
      ['agents.codex.requestTimeoutSeconds', 120]
    ])
    const client = new CodexClient({
      get: async (path: string) => values.get(path)
    } as unknown as Configer, testMetadata)
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
    await client['startThread']()
    expect(String(threadStartParams?.developerInstructions)).toContain('Markdown reference')
    expect(String(threadStartParams?.developerInstructions)).toContain('Project rule')
  })

  it('resolves tilde workspace paths to the user home directory', async () => {
    const parsed = await parseCodexioConfig({
      workspace: {
        path: null
      }
    }, 'config.yaml')
    expect(parsed.workspace.path).toBe('~')
    expect(resolveUserPath('~')).toBe(homedir())
    expect(resolveUserPath('~/work')).toBe(join(homedir(), 'work'))
    expect(resolveUserPath('~\\work')).toBe(join(homedir(), 'work'))
    const values = new Map<string, unknown>([
      ['agents.codex.bundled', false],
      ['workspace.path', '~'],
      ['proxy.enabled', false],
      ['proxy.host', '127.0.0.1'],
      ['proxy.port', 7890],
      ['proxy.noProxy', ''],
      ['server.host', '127.0.0.1'],
      ['agents.codex.command', 'codex'],
      ['agents.codex.instruction', ''],
      ['agents.codex.developerInstructions', ''],
      ['agents.codex.requestTimeoutSeconds', 120]
    ])
    const client = new CodexClient({
      get: async (path: string) => values.get(path)
    } as unknown as Configer, testMetadata)
    const runtimeConfig = await client['readRuntimeConfig']()
    expect(runtimeConfig.cwd).toBe(homedir())
  })

  it('removes the final newline from rendered markdown html', () => {
    expect(renderMarkdownHtml('你好。')).toBe('<p>你好。</p>')
  })

  it('parses markdown attachment references', () => {
    expect(parseMarkdownAttachmentReferences('图片 ![图](https://example.com/a.png) 文件 [说明](./docs/readme.md)')).toEqual({
      text: '图片 `https://example.com/a.png` 文件 `./docs/readme.md`',
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

  it('binds platform thread identities to one io thread', () => {
    const manager = new IoThreadIdManager()
    const ioThreadId = 'io-thread'
    expect(manager.getLastActiveIoThreadId()).toBeUndefined()
    manager.bind(ioThreadId, {
      source: 'feishu',
      id: ' chat:thread:omt_1 '
    })
    expect(manager.getLastActiveIoThreadId()).toBe(ioThreadId)
    manager.bind(ioThreadId, {
      source: 'feishu',
      id: 'chat:message:om_1'
    })
    expect(manager.getIoThreadId({
      source: 'feishu',
      id: 'chat:message:om_1'
    })).toBe(ioThreadId)
    expect(manager.getLastActiveIoThreadId()).toBe(ioThreadId)
    expect(manager.getIoThreadId({
      source: 'email',
      id: 'chat:message:om_1'
    })).not.toBe(ioThreadId)
  })

  it('binds multiple channels to one io thread', () => {
    const manager = new IoThreadIdManager()
    const ioThreadId = 'io-thread'
    manager.bind(ioThreadId, {
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })
    manager.bind(ioThreadId, {
      source: 'email',
      id: 'mailbox:root:message-1'
    })
    expect(manager.getIoThreadId({
      source: 'email',
      id: 'mailbox:root:message-1'
    })).toBe(ioThreadId)
    expect(manager.getPlatformThreadId(ioThreadId)).toEqual([
      {
        source: 'feishu',
        id: 'chat:thread:omt_1'
      },
      {
        source: 'email',
        id: 'mailbox:root:message-1'
      }
    ])
    expect(manager.getLastActiveIoThreadId()).toBe(ioThreadId)
  })

  it('uses the last active io thread for system messages', async () => {
    const sent: Message[] = []
    const ioThreadIdManager = new IoThreadIdManager()
    const manager = await createRecordingChannelOutputManager(sent, ioThreadIdManager)
    expect((await manager.sendSystem('empty')).isFailed).toBe(true)
    ioThreadIdManager.bind('io-thread-system', {
      source: 'web',
      id: 'io-thread-system'
    })
    const result = await manager.sendSystem('system message')
    expect(result.isFailed).toBe(false)
    expect(sent).toEqual([
      {
        ioThreadId: 'io-thread-system',
        role: 'system',
        text: 'system message'
      }
    ])
  })

  it('creates and binds an io thread when getting a new channel thread id', () => {
    const manager = new IoThreadIdManager()
    const ioThreadId = manager.getIoThreadId({
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })
    expect(ioThreadId).toBeTruthy()
    expect(manager.getIoThreadId({
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })).toBe(ioThreadId)
  })

  it('rejects binding one channel thread id to two io threads', () => {
    const manager = new IoThreadIdManager()
    manager.bind('io-thread-a', {
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })
    expect(() => manager.bind('io-thread-b', {
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })).toThrow('ioThread key already bound')
  })

  it('keeps channel thread ids source scoped', () => {
    const manager = new IoThreadIdManager()
    manager.bind('io-thread-feishu', {
      source: 'feishu',
      id: 'same-id'
    })
    manager.bind('io-thread-email', {
      source: 'email',
      id: 'same-id'
    })
    expect(manager.getIoThreadId({
      source: 'feishu',
      id: 'same-id'
    })).toBe('io-thread-feishu')
    expect(manager.getIoThreadId({
      source: 'email',
      id: 'same-id'
    })).toBe('io-thread-email')
  })

  it('binds more than one id of the same channel to one io thread', () => {
    const manager = new IoThreadIdManager()
    manager.bind('io-thread', {
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })
    manager.bind('io-thread', {
      source: 'feishu',
      id: 'chat:message:om_1'
    })
    expect(manager.getIoThreadId({
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })).toBe('io-thread')
    expect(manager.getIoThreadId({
      source: 'feishu',
      id: 'chat:message:om_1'
    })).toBe('io-thread')
  })

  it('broadcasts channel messages without storing conversation history', async () => {
    const sent: Message[] = []
    const manager = await createRecordingChannelOutputManager(sent)
    await manager.sendUser({
      ioThreadId: 'io-thread',
      role: 'user',
      text: 'hello'
    }, 'web')
    expect(sent).toEqual([
      {
        ioThreadId: 'io-thread',
        role: 'user',
        text: 'hello'
      }
    ])
  })

  it('routes channel output to web, the originating channel, and output-only channels', async () => {
    const sent: Array<{ type: string, message: Message }> = []
    const manager = await createRecordingChannelOutputManager(sent, new IoThreadIdManager(), [
      'web',
      'feishu',
      'feishuWebhook',
      'email'
    ])
    await manager.sendAgent({
      ioThreadId: 'io-thread',
      role: 'agent',
      text: 'hello'
    }, 'feishu')
    await manager.stop()
    expect(sent.map((item) => item.type)).toEqual([
      'web',
      'feishu',
      'feishuWebhook'
    ])
  })

  it('turns agent markdown file references into message files before output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-output-file-'))
    const imagePath = join(dir, 'agent.png')
    await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'))
    const sent: Message[] = []
    const manager = await createRecordingChannelOutputManager(sent, new IoThreadIdManager(), [
      'web'
    ])
    await manager.sendAgent({
      ioThreadId: 'io-thread',
      role: 'agent',
      text: `已生成：![agent](${imagePath.replaceAll('\\', '/')})`
    })
    await manager.stop()
    expect(sent).toHaveLength(1)
    expect(sent[0].files?.[0]).toMatchObject({
      name: 'agent.png',
      mime: 'image/png'
    })
    expect(sent[0].text).toContain('`')
  })

  it('routes channel messages to echo by default and codex when enabled', async () => {
    let codexEnabled = false
    const eventBus = new EventBus()
    const echo = createRecordingAgent('echo')
    const codex = createRecordingAgent('codex')
    const manager = new AgentManager({
      get: async (path: string) => path === 'agents.codex.enabled' ? codexEnabled : undefined,
      subscribe: () => {}
    } as unknown as Configer, eventBus, codex, echo)
    await manager.start()
    await eventBus.emitAsync(AppEvent.ChannelMessageReceived, channelMessage('first'))
    expect(echo.messages.map((message) => message.text)).toEqual([
      'first'
    ])
    expect(codex.messages).toEqual([])
    codexEnabled = true
    await manager.applyConfig()
    await eventBus.emitAsync(AppEvent.ChannelMessageReceived, channelMessage('second'))
    expect(codex.messages.map((message) => message.text)).toEqual([
      'second'
    ])
    await manager.stop()
  })

  it('buffers codex deltas until completion', async () => {
    const sent: Message[] = []
    const eventBus = new EventBus()
    eventBus.on(AppEvent.ChannelMessageSendRequested, async (event) => {
      sent.push(event.message)
      return Result.successVoid()
    })
    const streamer = new CodexMessageStreamer(eventBus)
    const thread = {
      ioThreadId: 'io-thread',
      agentThreadId: 'codex-thread'
    }
    await streamer.append(thread, 'item', '你')
    await streamer.append(thread, 'item', '好')
    await streamer.append(thread, 'item', '。')
    expect(sent).toEqual([])
    await streamer.complete(thread, [
      {
        itemId: 'item',
        text: '你好。'
      }
    ])
    expect(sent).toEqual([
      {
        ioThreadId: 'io-thread',
        role: 'agent',
        text: '你好。'
      }
    ])
  })

  it('does not flush codex deltas at a double newline after a colon', async () => {
    const sent: Message[] = []
    const eventBus = new EventBus()
    eventBus.on(AppEvent.ChannelMessageSendRequested, async (event) => {
      sent.push(event.message)
      return Result.successVoid()
    })
    const streamer = new CodexMessageStreamer(eventBus)
    const thread = {
      ioThreadId: 'io-thread',
      agentThreadId: 'codex-thread'
    }
    await streamer.append(thread, 'item', '根因有两个:\n\n')
    expect(sent).toEqual([])
    await streamer.append(thread, 'item', '第一个原因。')
    expect(sent).toEqual([])
    await streamer.completeItem(thread, 'item')
    expect(sent).toEqual([
      {
        ioThreadId: 'io-thread',
        role: 'agent',
        text: '根因有两个:\n\n第一个原因。'
      }
    ])
  })

  it('flushes codex deltas at a double newline after a sentence end', async () => {
    const sent: Message[] = []
    const eventBus = new EventBus()
    eventBus.on(AppEvent.ChannelMessageSendRequested, async (event) => {
      sent.push(event.message)
      return Result.successVoid()
    })
    const streamer = new CodexMessageStreamer(eventBus)
    const thread = {
      ioThreadId: 'io-thread',
      agentThreadId: 'codex-thread'
    }
    await streamer.append(thread, 'item', '服务恢复了。\n\n继续验证。')
    expect(sent).toEqual([
      {
        ioThreadId: 'io-thread',
        role: 'agent',
        text: '服务恢复了。'
      }
    ])
    await streamer.completeItem(thread, 'item')
    expect(sent).toEqual([
      {
        ioThreadId: 'io-thread',
        role: 'agent',
        text: '服务恢复了。'
      },
      {
        ioThreadId: 'io-thread',
        role: 'agent',
        text: '继续验证。'
      }
    ])
  })

  it('flushes the remaining codex buffer on completion without sentence end punctuation', async () => {
    const sent: Message[] = []
    const eventBus = new EventBus()
    eventBus.on(AppEvent.ChannelMessageSendRequested, async (event) => {
      sent.push(event.message)
      return Result.successVoid()
    })
    const streamer = new CodexMessageStreamer(eventBus)
    const thread = {
      ioThreadId: 'io-thread',
      agentThreadId: 'codex-thread'
    }
    await streamer.append(thread, 'item', '我改了 ThreadComposer.svelte:\n\n新增 sendDisabled')
    expect(sent).toEqual([])
    await streamer.completeItem(thread, 'item')
    expect(sent).toEqual([
      {
        ioThreadId: 'io-thread',
        role: 'agent',
        text: '我改了 ThreadComposer.svelte:\n\n新增 sendDisabled'
      }
    ])
  })

  it('keeps the originating channel on codex stream output', async () => {
    const sent: Array<{ inputType: string | undefined, message: Message }> = []
    const eventBus = new EventBus()
    eventBus.on(AppEvent.ChannelMessageSendRequested, async (event) => {
      sent.push({
        inputType: event.inputType,
        message: event.message
      })
      return Result.successVoid()
    })
    const streamer = new CodexMessageStreamer(eventBus)
    await streamer.complete({
      ioThreadId: 'io-thread',
      agentThreadId: 'codex-thread',
      inputType: 'feishu'
    }, [
      {
        itemId: 'item',
        text: '你好。'
      }
    ])
    expect(sent).toEqual([
      {
        inputType: 'feishu',
        message: {
          ioThreadId: 'io-thread',
          role: 'agent',
          text: '你好。'
        }
      }
    ])
  })

  it('does not resend codex item text when the turn completes', async () => {
    const sent: Message[] = []
    const eventBus = new EventBus()
    eventBus.on(AppEvent.ChannelMessageSendRequested, async (event) => {
      sent.push(event.message)
      return Result.successVoid()
    })
    const streamer = new CodexMessageStreamer(eventBus)
    const thread = {
      ioThreadId: 'io-thread',
      agentThreadId: 'codex-thread'
    }
    await streamer.append(thread, 'item', '你好')
    await streamer.completeItem(thread, 'item')
    await streamer.complete(thread, [
      {
        itemId: 'item',
        text: '你好'
      }
    ])
    expect(sent).toEqual([
      {
        ioThreadId: 'io-thread',
        role: 'agent',
        text: '你好'
      }
    ])
  })
})

async function createRecordingChannelOutputManager(
  sent: Message[] | Array<{ type: string, message: Message }>,
  ioThreadIdManager = new IoThreadIdManager(),
  enabledTypes = ['web']
): Promise<ChannelOutputManager> {
  const configer = {
    subscribe: () => {},
    get: async (path: string) => path === 'workspace.path' ? '~' : undefined
  } as unknown as Configer
  const fileStore = new FileStore(testMetadata)
  const output = (type: string) => ({
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
    fileStore,
    new EventBus(),
    ioThreadIdManager,
    output('web') as never,
    output('feishu') as never,
    output('feishuWebhook') as never,
    output('email') as never,
    output('nfirco') as never
  )
  await manager.start()
  return manager
}

function createRecordingAgent(type: string): Agent & { messages: Message[] } {
  const messages: Message[] = []
  return {
    type,
    messages,
    start: async () => Result.successVoid(),
    receive: async (event) => {
      messages.push(event.message)
      return Result.successVoid()
    },
    stop: async () => Result.successVoid()
  }
}

function channelMessage(text: string): ChannelMessageReceivedEvent {
  return {
    inputType: 'web',
    message: {
      ioThreadId: 'io-thread',
      role: 'user',
      text
    }
  }
}
