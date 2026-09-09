import { createServer, IncomingHttpHeaders, Server as HttpServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { RawData, WebSocket, WebSocketServer } from 'ws'
import * as Lark from '@larksuiteoapi/node-sdk'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { resolveAvailableServerPort } from '../src/util/Network.js'
import { configPageHtml } from '../src/controller/ConfigPage.js'
import { webPageHtml } from '../src/controller/channeli/WebPage.js'
import { Configer } from '../src/component/Configer.js'
import { Result } from '../src/value/Result.js'
import { ChannelInputManager } from '../src/controller/channeli/ChannelInputManager.js'
import { ChannelOutputManager } from '../src/component/channelo/ChannelOutputManager.js'
import { CodexioApiController } from '../src/controller/CodexioApiController.js'
import { FileStore } from '../src/component/FileStore.js'
import { MessageFileResolver } from '../src/component/MessageFileResolver.js'
import { WebChannelInput } from '../src/controller/channeli/WebChannelInput.js'
import { FeishuChannelInput } from '../src/controller/channeli/FeishuChannelInput.js'
import { EmailChannelInput } from '../src/controller/channeli/EmailChannelInput.js'
import { UserverThreadInput } from '../src/controller/channeli/UserverThreadInput.js'
import { WebChannelHub } from '../src/component/channel/WebChannelHub.js'
import { WebThreadManager } from '../src/component/channel/WebThreadManager.js'
import { WebChannelOutput } from '../src/component/channelo/WebChannelOutput.js'
import { FeishuChannelOutput } from '../src/component/channelo/FeishuChannelOutput.js'
import { FeishuWebhookChannelOutput } from '../src/component/channelo/FeishuWebhookChannelOutput.js'
import { EmailChannelOutput } from '../src/component/channelo/EmailChannelOutput.js'
import { deriveExternalDeliveryId } from '../src/component/channelo/ExternalDeliveryIdentity.js'
import { EventBus } from '../src/component/EventBus.js'
import { AppEvent } from '../src/value/Event.js'
import { ThreadRegistry } from '../src/component/ThreadRegistry.js'
import { ThreadWorkspaceResolver } from '../src/component/ThreadWorkspaceResolver.js'
import { EchoAgent } from '../src/component/agent/EchoAgent.js'
import { AgentManager } from '../src/component/agent/AgentManager.js'
import { CodexAgent } from '../src/component/agent/CodexAgent.js'
import { CodexClient } from '../src/component/agent/codex/CodexClient.js'
import { CodexMessageAssembler } from '../src/component/agent/codex/CodexMessageAssembler.js'
import { CommandExecutor } from '../src/controller/CommandExecutor.js'
import { createMessage } from '../src/value/Message.js'
import { ServerRuntime } from '../src/component/ServerRuntime.js'

const testToken = 'test-message-token'
const testMetadata = new CodexioMetadata()
const testServerStops = new WeakMap<HttpServer, () => Promise<Result<void>>>()
type FeishuWsClientOptions = ConstructorParameters<typeof Lark.WSClient>[0]

class FakeFeishuWsClient {
  readonly autoReconnect: boolean
  started = false
  closed = false
  connectUrl = ''
  readonly wsConfig = {
    updateWs: (config: { connectUrl: string }) => {
      this.connectUrl = config.connectUrl
    }
  }

  constructor(readonly options: FeishuWsClientOptions) {
    this.autoReconnect = options.autoReconnect ?? true
  }

  async pullConnectConfig(): Promise<{ ok: boolean }> {
    return {
      ok: true
    }
  }

  async start(): Promise<void> {
    this.started = true
    await this.pullConnectConfig()
    this.options.onReady?.()
  }

  close(): void {
    this.closed = true
  }
}

class FakeFeishuOpenApiClient {
  readonly replies: unknown[] = []
  readonly resources = new Map<string, Buffer>()
  readonly resourceRequests: unknown[] = []
  readonly im = {
    v1: {
      message: {
        reply: async (payload: unknown) => {
          this.replies.push(payload)
          return {}
        }
      },
      messageResource: {
        get: async (payload: { path: { file_key: string } }) => {
          this.resourceRequests.push(payload)
          return {
            getReadableStream: () => Readable.from(this.resources.get(payload.path.file_key) ?? Buffer.alloc(0)),
            headers: {
              'content-type': 'application/pdf'
            }
          }
        }
      }
    }
  }
}

class TestFeishuChannelInput extends FeishuChannelInput {
  readonly clients: FakeFeishuWsClient[] = []
  readonly openApiClients: FakeFeishuOpenApiClient[] = []

  protected override createWsClient(options: FeishuWsClientOptions): Lark.WSClient {
    const client = new FakeFeishuWsClient(options)
    this.clients.push(client)
    return client as unknown as Lark.WSClient
  }

  protected override createOpenApiClient(): Lark.Client {
    const client = new FakeFeishuOpenApiClient()
    this.openApiClients.push(client)
    return client as unknown as Lark.Client
  }
}

describe('server', () => {
  it('serves the Codexio web chat page', () => {
    expect(webPageHtml).toContain('Codexio')
    expect(webPageHtml).toContain('id="messages"')
    expect(webPageHtml).toContain('id="form"')
    expect(webPageHtml).toContain('id="threads"')
    expect(webPageHtml).toContain("type: 'thread.create'")
    expect(webPageHtml).toContain("event === 'thread.created'")
    expect(webPageHtml).toContain("message.type === 'agent'")
    expect(webPageHtml).toContain('replaceHistory')
    expect(webPageHtml).toContain('replaceThreads')
    expect(webPageHtml).toContain("fetch('/version')")
    expect(webPageHtml).toContain("'v' + version")
  })

  it('serves config field descriptions on the config page', () => {
    expect(configPageHtml).toContain('field.description')
    expect(configPageHtml).toContain('group.description')
    expect(configPageHtml).toContain('renderTemplate(binding.template, current)')
    expect(configPageHtml).toContain('binding.element.textContent')
    expect(configPageHtml).toContain('refreshExternalConfig')
    expect(configPageHtml).toContain('配置已在外部更新')
  })

  it('uses the next available runtime port without rewriting the configured port', async () => {
    const configuredPort = await resolveAvailableServerPort('127.0.0.1', 8787)
    const blocker = createServer()
    await new Promise<void>((resolve, reject) => {
      blocker.once('listening', resolve)
      blocker.once('error', reject)
      blocker.listen(configuredPort, '127.0.0.1')
    })
    const runtime = new ServerRuntime()
    const configer = {
      get: async (path: string) => {
        if (path === 'server.host') {
          return '127.0.0.1'
        }
        if (path === 'server.port') {
          return configuredPort
        }
        if (path === 'server.autoPort') {
          return true
        }
        throw new Error(`unexpected config path: ${path}`)
      },
      set: async () => {
        throw new Error('server port must not be persisted')
      }
    } as unknown as Configer
    const webChannel = {
      attach: () => undefined,
      stop: () => undefined
    } as unknown as WebChannelHub
    const controller = new CodexioApiController(
      configer,
      {} as ChannelOutputManager,
      {} as FileStore,
      webChannel,
      new EventBus(),
      testMetadata,
      runtime
    )
    try {
      const listener = await controller.start()
      const address = listener.address()
      const runtimePort = address && typeof address !== 'string' ? address.port : undefined
      expect(runtimePort).toBeGreaterThan(configuredPort)
      expect(runtime.requireEndpoint().port).toBe(runtimePort)
    } finally {
      await controller.stop()
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('returns all described config fields to the config page', async () => {
    const { baseUrl, listener } = await startTestServer()
    const response = await fetch(`${baseUrl}/api/config`)
    const result = await response.json() as {
      isFailed: boolean
      data: {
        config: Record<string, unknown>
        descriptor: {
          groups: Array<{
            path: string
            title: string
            description: string
          }>
          fields: Array<{
            path: string
            groupPath: string
            description: string
          }>
        }
      }
    }
    expect(result.isFailed).toBe(false)
    expect(Object.keys(result.data.config).sort()).toEqual([
      'agents',
      'app',
      'channeli',
      'channelo',
      'proxy',
      'server'
    ])
    expect(result.data.descriptor.groups.find((group) => group.path === 'channeli.feishu')).toMatchObject({
      title: 'Feishu Input',
      description: expect.stringContaining('${app.id}')
    })
    for (const field of result.data.descriptor.fields) {
      expect(field.description.trim().length).toBeGreaterThan(0)
      expect(result.data.descriptor.groups.some((group) => group.path === field.groupPath)).toBe(true)
      const value = field.path.split('.').reduce<unknown>((current, key) => {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
          return undefined
        }
        return (current as Record<string, unknown>)[key]
      }, result.data.config)
      expect(value).not.toBeUndefined()
    }
    await closeTestServer(listener)
  })

  it('returns the runtime version', async () => {
    const { baseUrl, listener } = await startTestServer()
    const response = await fetch(`${baseUrl}/version`)
    const result = await response.json() as {
      isFailed: boolean
      data: {
        name: string
        version: string
        pid: number
      }
    }
    expect(result.isFailed).toBe(false)
    expect(result.data).toEqual({
      name: 'codexio',
      version: testMetadata.readVersion(),
      pid: expect.any(Number)
    })
    await closeTestServer(listener)
  })

  it('shows web user input before echo output', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    const webThreadId = await createWebThread(socket)
    socket.send(JSON.stringify({
      type: 'message.send',
      webThreadId,
      sourceMessageId: 'web-message',
      text: 'hello'
    }))
    await waitForWebSocketMessages(messages, 2)
    expect(messages[0]).toMatchObject({
      event: 'message',
      role: 'user',
      webThreadId,
      thread: { id: expect.any(String), name: 'hello' },
      text: 'hello'
    })
    expect(messages[1]).toMatchObject({
      event: 'message',
      role: 'agent',
      webThreadId,
      thread: { id: expect.any(String), name: 'hello' },
      text: 'hello'
    })
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('projects a repeated Web request only once from receive to display', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    const webThreadId = await createWebThread(socket)
    const payload = JSON.stringify({
      type: 'message.send',
      webThreadId,
      sourceMessageId: 'web-message-idempotent',
      text: 'hello'
    })

    socket.send(payload)
    socket.send(payload)
    await waitForWebSocketMessages(messages, 2)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(messages.map((message) => `${message.role}:${message.text}`)).toEqual([
      'user:hello',
      'agent:hello'
    ])
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('rejects a message for a Web thread id that the server did not issue', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordAllWebSocket(socket)

    socket.send(JSON.stringify({
      type: 'message.send',
      webThreadId: 'caller-created-thread',
      sourceMessageId: 'caller-created-message',
      text: 'must be rejected'
    }))
    await waitForWebSocketMessages(messages, 1)

    expect(messages[0]).toEqual({
      event: 'error',
      webThreadId: 'caller-created-thread',
      message: 'web thread not found'
    })
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('restores conversation history on a new web connection', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    const webThreadId = await createWebThread(socket)
    socket.send(JSON.stringify({
      type: 'message.send',
      webThreadId,
      sourceMessageId: 'web-message-history',
      text: 'message'
    }))
    await waitForWebSocketMessages(messages, 2)
    const restored = await openRecordedWebSocket(baseUrl)
    await waitForWebSocketMessages(restored.messages, 1)
    expect(restored.messages[0]).toMatchObject({
      event: 'history',
      threads: [
        {
          id: webThreadId,
          thread: { id: expect.any(String), name: 'message' }
        }
      ],
      messages: [
        {
          event: 'message',
          role: 'user',
          webThreadId,
          thread: { id: expect.any(String), name: 'message' },
          text: 'message'
        },
        {
          event: 'message',
          role: 'agent',
          webThreadId,
          thread: { id: expect.any(String), name: 'message' },
          text: 'message'
        }
      ]
    })
    await closeWebSocket(restored.socket)
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('restores web thread metadata after stopping and reopening the app data directory', async () => {
    const dataPath = await mkdtemp(join(tmpdir(), 'codexio-app-restart-'))
    const firstServer = await startTestServer(dataPath)
    const firstSocket = await openWebSocket(firstServer.baseUrl)
    const webThreadId = await createWebThread(firstSocket)
    await closeWebSocket(firstSocket)
    await closeTestServer(firstServer.listener)

    const secondServer = await startTestServer(dataPath)
    const restored = await openRecordedWebSocket(secondServer.baseUrl)
    await waitForWebSocketMessages(restored.messages, 1)

    expect(restored.messages[0]).toMatchObject({
      event: 'history',
      threads: [{
        id: webThreadId,
        thread: {
          id: expect.any(String),
          name: '新对话'
        }
      }],
      messages: []
    })
    await closeWebSocket(restored.socket)
    await closeTestServer(secondServer.listener)
  })

  it('broadcasts web user input and echo output', async () => {
    const { baseUrl, listener } = await startTestServer()
    const first = await openWebSocket(baseUrl)
    const second = await openWebSocket(baseUrl)
    const firstMessages = recordWebSocket(first)
    const secondMessages = recordWebSocket(second)
    const webThreadId = await createWebThread(first)
    first.send(JSON.stringify({
      type: 'message.send',
      webThreadId,
      sourceMessageId: 'web-message-shared',
      text: 'shared input'
    }))
    await waitForWebSocketMessages(firstMessages, 2)
    await waitForWebSocketMessages(secondMessages, 2)
    expect(firstMessages[0]).toMatchObject({
      event: 'message',
      role: 'user',
      webThreadId,
      thread: { id: expect.any(String), name: 'shared input' },
      text: 'shared input'
    })
    expect(secondMessages[0]).toMatchObject({
      event: 'message',
      role: 'user',
      webThreadId,
      thread: { id: expect.any(String), name: 'shared input' },
      text: 'shared input'
    })
    expect(firstMessages[1]).toMatchObject({
      event: 'message',
      role: 'agent',
      webThreadId,
      thread: { id: expect.any(String), name: 'shared input' },
      text: 'shared input'
    })
    expect(secondMessages[1]).toMatchObject({
      event: 'message',
      role: 'agent',
      webThreadId,
      thread: { id: expect.any(String), name: 'shared input' },
      text: 'shared input'
    })
    await closeWebSocket(first)
    await closeWebSocket(second)
    await closeTestServer(listener)
  })

  it('stops the host server through the api', async () => {
    const { baseUrl, listener } = await startTestServer()
    const closed = new Promise<void>((resolve) => {
      listener.once('close', resolve)
    })
    const response = await fetch(`${baseUrl}/api/server/stop`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${testToken}`
      }
    })
    const result = await response.json() as {
      isFailed: boolean
      data: {
        stopping: boolean
      }
    }
    expect(result.isFailed).toBe(false)
    expect(result.data.stopping).toBe(true)
    await closed
  })

  it('reconnects feishu input after websocket client error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-feishu-input-'))
    const configPath = join(dir, 'config.yaml')
    await writeFile(configPath, [
      'app:',
      '  id: bind-secret',
      'server:',
      '  host: 127.0.0.1',
      'channeli:',
      '  feishu:',
      '    enabled: true',
      '    appId: app-id',
      '    appSecret: app-secret',
      '    chatId: chat-id',
      '    ws: wss://example.test/ws',
      'channelo:',
      '  web:',
      '    enabled: true'
    ].join('\n'))
    const metadata = new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      configPath
    })
    const input = new TestFeishuChannelInput(new Configer(metadata), new FileStore(metadata))
    ;(input as unknown as { reconnectDelayMs: number }).reconnectDelayMs = 10
    await input.start({
      receive: async () => Result.success({
        ioThreadId: 'io-thread'
      })
    })
    input.clients[0].options.onError?.(new Error('socket closed'))
    const startedAt = Date.now()
    while (input.clients.length < 2) {
      if (Date.now() - startedAt > 4000) {
        throw new Error(`feishu reconnect timeout: ${input.clients.length}`)
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 5)
      })
    }
    expect(input.clients[0].closed).toBe(true)
    expect(input.clients[1].started).toBe(true)
    expect(input.clients[1].autoReconnect).toBe(true)
    await input.stop()
  })

  it('downloads an allowed Feishu attachment without a mention when aite is disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-feishu-file-'))
    const configPath = join(dir, 'config.yaml')
    await writeFile(configPath, [
      'channeli:',
      '  feishu:',
      '    enabled: true',
      '    appId: app-id',
      '    appSecret: app-secret',
      '    chatId: chat-id',
      '    aite: false',
      '    allowedOpenIds:',
      '      - ou_allowed'
    ].join('\n'))
    const metadata = new CodexioMetadata({
      rootPath: dir,
      configPath
    })
    const input = new TestFeishuChannelInput(new Configer(metadata), new FileStore(metadata))
    const received: Array<{ text: string, files?: Array<{ path: string }> }> = []
    await input.start({
      receive: async (_source, message) => {
        received.push(message)
        return Result.success({ ioThreadId: 'io-thread' })
      }
    })
    expect(Reflect.get(input, 'inputConfig')).toMatchObject({
      aite: false,
      allowedOpenIds: ['ou_allowed']
    })
    input.openApiClients[0].resources.set('file-key', Buffer.from('pdf-body'))
    expect(Reflect.get(input, 'openApiClient')).toBe(input.openApiClients[0])

    await Reflect.get(input, 'receive').call(input, {
      sender: {
        sender_id: {
          open_id: 'ou_allowed'
        }
      },
      message: {
        message_id: 'om_file',
        chat_id: 'chat-id',
        chat_type: 'group',
        message_type: 'file',
        content: JSON.stringify({
          file_key: 'file-key',
          file_name: 'report.pdf'
        })
      }
    })
    expect(input.openApiClients[0].resourceRequests).toHaveLength(1)
    expect(received).toHaveLength(1)
    expect(received[0].text).toBe('')
    expect(await readFile(received[0].files?.[0].path ?? '', 'utf8')).toBe('pdf-body')
    await input.stop()
  })

  it('binds feishu input from a bind command when chat id is empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-feishu-bind-'))
    const configPath = join(dir, 'config.yaml')
    await writeFile(configPath, [
      'app:',
      '  id: bind-secret',
      'server:',
      '  host: 127.0.0.1',
      'channeli:',
      '  feishu:',
      '    enabled: true',
      '    appId: app-id',
      '    appSecret: app-secret',
      '    chatId: ""',
      '    aite: false',
      '    allowedOpenIds: []',
      'channelo:',
      '  feishu:',
      '    enabled: false',
      '    appId: app-id',
      '    appSecret: app-secret',
      '    chatId: ""',
      '  web:',
      '    enabled: true'
    ].join('\n'))
    const metadata = new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      configPath
    })
    const configer = new Configer(metadata)
    const input = new TestFeishuChannelInput(configer, new FileStore(metadata))
    const received: unknown[] = []
    await input.start({
      receive: async (source, message) => {
        received.push({
          source,
          message
        })
        return Result.success({
          ioThreadId: 'io-thread'
        })
      }
    })
    await Reflect.get(input, 'receive').call(input, {
      sender: {
        sender_id: {
          open_id: 'ou_ignored'
        }
      },
      message: {
        message_id: 'om_ignored',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({
          text: 'hello'
        })
      }
    })
    expect(received).toEqual([])
    await Reflect.get(input, 'receive').call(input, {
      sender: {
        sender_id: {
          open_id: 'ou_wrong'
        }
      },
      message: {
        message_id: 'om_wrong_bind',
        chat_id: 'oc_wrong',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({
          text: '$bind wrong-secret'
        })
      }
    })
    expect((await configer.get('channeli.feishu')).chatId).toBe('')
    expect(input.openApiClients[0].replies).toMatchObject([
      {
        path: {
          message_id: 'om_wrong_bind'
        },
        data: {
          reply_in_thread: true
        }
      }
    ])
    await Reflect.get(input, 'receive').call(input, {
      sender: {
        sender_id: {
          open_id: 'ou_1'
        }
      },
      message: {
        message_id: 'om_bind',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({
          text: '$bind bind-secret'
        })
      }
    })
    const config = await configer.get('channeli.feishu')
    expect(config.chatId).toBe('oc_1')
    expect(config.allowedOpenIds).toEqual([
      'ou_1'
    ])
    const outputConfig = await configer.get('channelo.feishu')
    expect(outputConfig.enabled).toBe(true)
    expect(outputConfig.chatId).toBe('oc_1')
    expect(input.openApiClients[0].replies).toMatchObject([
      {
        path: {
          message_id: 'om_wrong_bind'
        },
        data: {
          reply_in_thread: true
        }
      },
      {
        path: {
          message_id: 'om_bind'
        },
        data: {
          reply_in_thread: true
        }
      }
    ])
    expect(received).toEqual([])
    await Reflect.get(input, 'receive').call(input, {
      sender: {
        sender_id: {
          open_id: 'ou_1'
        }
      },
      message: {
        message_id: 'om_after_bind',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({
          text: 'hello after bind'
        })
      }
    })
    expect(received).toMatchObject([
      {
        source: 'feishu',
        message: {
          channelThreadId: {
            source: 'feishu',
            id: 'oc_1:chat'
          },
          sourceMessageId: 'om_after_bind',
          text: 'hello after bind',
          sender: {
            openId: 'ou_1'
          }
        }
      }
    ])
    await Reflect.get(input, 'receive').call(input, {
      sender: {
        sender_id: {
          open_id: 'ou_2'
        }
      },
      message: {
        message_id: 'om_rebind_denied',
        chat_id: 'oc_denied',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({
          text: '$bind bind-secret'
        })
      }
    })
    const deniedInputConfig = await configer.get('channeli.feishu')
    expect(deniedInputConfig.chatId).toBe('oc_1')
    await Reflect.get(input, 'receive').call(input, {
      sender: {
        sender_id: {
          open_id: 'ou_1'
        }
      },
      message: {
        message_id: 'om_rebind',
        chat_id: 'oc_2',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({
          text: '￥bind bind-secret'
        })
      }
    })
    const reboundInputConfig = await configer.get('channeli.feishu')
    expect(reboundInputConfig.chatId).toBe('oc_2')
    expect(reboundInputConfig.allowedOpenIds).toEqual([
      'ou_1'
    ])
    const reboundOutputConfig = await configer.get('channelo.feishu')
    expect(reboundOutputConfig.chatId).toBe('oc_2')
    await input.stop()
  })



})

it('drives an Agent from read-only Userver WebSocket events and resumes its checkpoint', async () => {
  const received = vi.spyOn(EchoAgent.prototype, 'receive')
  const cursors: number[] = []
  let writes = 0
  let origin = ''
  const service = createServer((request, response) => {
    expect(request.headers.authorization).toBe('Bearer userver-site-secret')
    if (request.method !== 'GET') writes++
    const url = new URL(request.url!, 'http://localhost')
    const data = url.pathname === '/subscription'
      ? { url: origin.replace('http:', 'ws:') + '/live?ticket=test', expiresAt: new Date(Date.now() + 60000).toISOString(), websiteId: 7, threadUuid: null, userAccessId: 'owner', agentUuid: 'agent-1' }
      : url.pathname.endsWith('/me')
        ? { uuid: 'agent-1', ownerAccessId: 'owner', websiteId: 7, permission: 'READ_WRITE' }
        : { uuid: 'thread-1', title: '协作', content: '继续验证实现', files: [{ id: 42, filename: 'restricted.zip', url: null }] }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ code: '1', data }))
  })
  const sockets = new WebSocketServer({ server: service })
  sockets.on('connection', (socket, request) => {
    socket.on('message', () => { writes++ })
    const after = Number(new URL(request.url!, 'http://localhost').searchParams.get('after'))
    cursors.push(after)
    for (const event of [
      { messageUuid: 'message-1', cursor: 1, type: 'thread.message.created', threadUuid: 'thread-1', actorAccessId: 'human' },
      { cursor: 2, type: 'thread.created', threadUuid: 'thread-2', actorAccessId: 'another-human' },
      { cursor: 3, type: 'thread.message.created', threadUuid: 'thread-1', actorAgentUuid: 'agent-1' }
    ]) if (event.cursor > after) socket.send(JSON.stringify(event))
  })
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve))
  const address = service.address() as { port: number }
  origin = `http://127.0.0.1:${address.port}`
  const dir = await mkdtemp(join(tmpdir(), 'codexio-userver-'))
  const configPath = join(dir, 'config.yaml')
  await writeFile(configPath, JSON.stringify({
    app: { workspace: { path: dir } },
    agents: { codex: { enabled: false }, echo: { enabled: true } },
    channeli: { userver: { enabled: true, baseUrl: origin, subscriptionUrl: origin + '/subscription', mcpUrl: origin + '/mcp', websiteId: 7, secret: 'userver-site-secret' } }
  }))
  const configer = new Configer(new CodexioMetadata({ rootPath: testMetadata.rootPath, configPath }))
  let app = await createTestCodexioApp(configer)
  try {
    await expect.poll(() => received.mock.calls.length).toBe(2)
    const metadata = new CodexioMetadata({ rootPath: testMetadata.rootPath, configPath })
    const check = new ThreadRegistry(metadata)
    const key = JSON.stringify([origin, 7, 'agent-1', null])
    await expect.poll(() => check.checkpoint(key).load()).toBe(3)
    await check.close()
    await app.stop()
    app = await createTestCodexioApp(configer)
    await expect.poll(() => cursors).toEqual([0, 3])
    expect(received).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(received.mock.calls)).toContain('restricted.zip')
    expect(JSON.stringify(received.mock.calls)).toContain('尚未下载')
    expect(received.mock.calls[0][0].thread.id).not.toBe(received.mock.calls[1][0].thread.id)
    expect(writes).toBe(0)
  } finally {
    await app.stop()
    received.mockRestore()
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => sockets.close(error => error ? reject(error) : resolve()))
    await new Promise<void>((resolve, reject) => service.close(error => error ? reject(error) : resolve()))
  }
})

async function startTestServer(dataPath?: string): Promise<{
  baseUrl: string
  listener: HttpServer
}> {
  const port = await resolveAvailableServerPort('127.0.0.1', 8787)
  const dir = dataPath ?? await mkdtemp(join(tmpdir(), 'codexio-app-'))
  const configPath = join(dir, 'config.yaml')
  await writeFile(configPath, [
    'server:',
    '  host: 127.0.0.1',
    `  port: ${port}`,
    `  token: ${testToken}`,
    'channeli:',
    '  web:',
    '    enabled: true',
    'channelo:',
    '  web:',
    '    enabled: true'
  ].join('\n'))
  const server = await createTestCodexioApp(new Configer(new CodexioMetadata({
    rootPath: testMetadata.rootPath,
    configPath
  })))
  const listener = server.listen(port, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    listener.once('listening', resolve)
    listener.once('error', reject)
  })
  testServerStops.set(listener, server.stop)
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    listener
  }
}

async function createTestCodexioApp(configer: Configer): Promise<{
  listen: (port?: number, host?: string) => HttpServer
  stop: () => Promise<Result<void>>
}> {
  await configer.validate()
  const metadata = new CodexioMetadata({
    rootPath: testMetadata.rootPath,
    configPath: configer.path
  })
  const eventBus = new EventBus()
  const fileStore = new FileStore(metadata)
  const threadRegistry = new ThreadRegistry(metadata)
  await threadRegistry.init()
  const workspaceResolver = new ThreadWorkspaceResolver(configer, metadata)
  const codexClient = new CodexClient(configer, metadata, workspaceResolver)
  const webThreadManager = new WebThreadManager(threadRegistry)
  const webHub = new WebChannelHub(fileStore, webThreadManager)
  const serverRuntime = new ServerRuntime()
  const webInput = new WebChannelInput(configer, webHub)
  const webOutput = new WebChannelOutput(configer, webHub, serverRuntime)
  const feishuInput = new FeishuChannelInput(configer, fileStore)
  const feishuOutput = new FeishuChannelOutput(configer, threadRegistry)
  const emailInput = new EmailChannelInput(configer)
  const emailOutput = new EmailChannelOutput(configer)
  const outputManager = new ChannelOutputManager(
    configer,
    threadRegistry,
    webOutput,
    feishuOutput,
    new FeishuWebhookChannelOutput(configer),
    emailOutput
  )
  const codexAgent = new CodexAgent(configer, threadRegistry, codexClient, new CodexMessageAssembler())
  const echoAgent = new EchoAgent()
  const agentManager = new AgentManager(configer, codexAgent, echoAgent, workspaceResolver, new MessageFileResolver(fileStore), outputManager)
  const userverInput = new UserverThreadInput(configer, fileStore, threadRegistry, agentManager)
  const inputManager = new ChannelInputManager(configer, threadRegistry, outputManager, agentManager, new CommandExecutor(outputManager), webInput, feishuInput, emailInput, userverInput)
  const apiController = new CodexioApiController(configer, outputManager, fileStore, webHub, eventBus, metadata, serverRuntime)
  await outputManager.start()
  await agentManager.start()
  await inputManager.start()
  const stop = async () => {
    await ignoreStopFailure(apiController.stop())
    await ignoreStopFailure(inputManager.stop())
    await ignoreStopFailure(agentManager.stop())
    await ignoreStopFailure(outputManager.stop())
    await threadRegistry.close()
    return Result.successVoid()
  }
  eventBus.on(AppEvent.StopRequested, () => {
    void stop()
  })
  return {
    listen: (port?: number, host?: string) => apiController.listen(port, host),
    stop
  }
}

async function closeTestServer(listener: HttpServer): Promise<void> {
  const stop = testServerStops.get(listener)
  if (stop) {
    await stop()
    testServerStops.delete(listener)
    return
  }
  await new Promise<void>((resolve) => {
    listener.close(() => resolve())
  })
}

async function ignoreStopFailure(result: Promise<Result<void>>): Promise<void> {
  await result.catch(() => Result.successVoid())
}

async function openWebSocket(baseUrl: string): Promise<WebSocket> {
  const url = baseUrl.replace('http://', 'ws://').replace('https://', 'wss://')
  const socket = new WebSocket(`${url}/ws`)
  await new Promise<void>((resolve, reject) => {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>
      if (message.event === 'ready') {
        resolve()
      }
    })
    socket.once('error', reject)
  })
  return socket
}

async function openRecordedWebSocket(baseUrl: string): Promise<{
  socket: WebSocket
  messages: Array<Record<string, unknown>>
}> {
  const url = baseUrl.replace('http://', 'ws://').replace('https://', 'wss://')
  const socket = new WebSocket(`${url}/ws`)
  const messages = recordAllWebSocket(socket)
  await new Promise<void>((resolve, reject) => {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>
      if (message.event === 'ready') {
        resolve()
      }
    })
    socket.once('error', reject)
  })
  return {
    socket,
    messages
  }
}

async function createWebThread(socket: WebSocket): Promise<string> {
  const requestId = randomUUID()
  return new Promise<string>((resolve, reject) => {
    const onMessage = (data: RawData) => {
      const message = JSON.parse(data.toString()) as {
        event?: string
        requestId?: string
        thread?: { id?: string }
      }
      if (message.event !== 'thread.created' || message.requestId !== requestId) {
        return
      }
      socket.off('message', onMessage)
      const webThreadId = message.thread?.id
      if (!webThreadId) {
        reject(new Error('created web thread id missing'))
        return
      }
      resolve(webThreadId)
    }
    socket.on('message', onMessage)
    socket.send(JSON.stringify({
      type: 'thread.create',
      requestId
    }))
  })
}

function recordWebSocket(socket: WebSocket): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>
    if (message.event === 'message') {
      messages.push(message)
    }
  })
  return messages
}

function recordAllWebSocket(socket: WebSocket): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>
    if (message.event !== 'ready') {
      messages.push(message)
    }
  })
  return messages
}

async function waitForWebSocketMessages(messages: Array<Record<string, unknown>>, count: number): Promise<void> {
  const startedAt = Date.now()
  while (messages.length < count) {
    if (Date.now() - startedAt > 4000) {
      throw new Error(`websocket message timeout: ${messages.length}/${count}`)
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
  }
}

async function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return
  }
  await new Promise<void>((resolve) => {
    socket.once('close', resolve)
    socket.close()
  })
}

function createThreadRegistry(): ThreadRegistry {
  return new ThreadRegistry(new CodexioMetadata({
    rootPath: testMetadata.rootPath,
    dataPath: join(tmpdir(), `codexio-io-thread-${randomUUID()}`)
  }))
}
