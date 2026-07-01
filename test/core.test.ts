import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChannelOutputManager } from '../src/component/channelo/ChannelOutputManager.js'
import { Configer } from '../src/component/Configer.js'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { EventBus } from '../src/component/EventBus.js'
import { IoThreadIdManager } from '../src/component/IoThreadIdManager.js'
import { Agent } from '../src/component/agent/Agent.js'
import { AgentManager } from '../src/component/agent/AgentManager.js'
import { CodexClient } from '../src/component/agent/CodexClient.js'
import { CodexMessageStreamer } from '../src/component/agent/CodexMessageStreamer.js'
import { AppEvent, ChannelMessageReceivedEvent } from '../src/value/Event.js'
import { ConfigSchema, createDefaultConfig, validateCodexioConfig } from '../src/value/ConfigDefinition.js'
import { Result } from '../src/value/Result.js'
import type { Message } from '../src/value/Message.js'
import { renderMarkdownHtml } from '../src/util/Markdown.js'

const testMetadata = new CodexioMetadata()

describe('core', () => {
  it('creates channel-only default config', () => {
    const config = createDefaultConfig()
    expect(config.server.host).toBe('127.0.0.1')
    expect(config.agents.codex.bundled).toBe(true)
    expect(config.workspace.path).toBe('')
    expect(config.proxy.host).toBe('127.0.0.1')
    expect(config.proxy.noProxy).toBe('')
    expect(config.channeli.web?.enabled).toBe(true)
    expect(config.channelo.web?.enabled).toBe(true)
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

  it('removes the final newline from rendered markdown html', () => {
    expect(renderMarkdownHtml('你好。')).toBe('<p>你好。</p>')
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

async function createRecordingChannelOutputManager(sent: Message[], ioThreadIdManager = new IoThreadIdManager()): Promise<ChannelOutputManager> {
  const configer = {
    subscribe: () => {}
  } as unknown as Configer
  const output = (type: string) => ({
    type,
    start: async () => type === 'web',
    send: async (message: Message) => {
      sent.push(message)
      return Result.successVoid()
    },
    stop: async () => Result.successVoid()
  })
  const manager = new ChannelOutputManager(
    configer,
    new EventBus(),
    ioThreadIdManager,
    output('web') as never,
    output('feishu') as never,
    output('feishuWebhook') as never,
    output('email') as never
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
