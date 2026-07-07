import { IncomingHttpHeaders, Server as HttpServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import * as Lark from '@larksuiteoapi/node-sdk'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { resolveAvailableServerPort } from '../src/util/Network.js'
import { webPageHtml } from '../src/controller/channeli/WebPage.js'
import { Configer } from '../src/component/Configer.js'
import { Result } from '../src/value/Result.js'
import { ChannelInputManager } from '../src/controller/channeli/ChannelInputManager.js'
import { ChannelOutputManager } from '../src/component/channelo/ChannelOutputManager.js'
import { CodexioApiController } from '../src/controller/CodexioApiController.js'
import { FileStore } from '../src/component/FileStore.js'
import { WebChannelInput } from '../src/controller/channeli/WebChannelInput.js'
import { FeishuChannelInput } from '../src/controller/channeli/FeishuChannelInput.js'
import { EmailChannelInput } from '../src/controller/channeli/EmailChannelInput.js'
import { NfircoThreadInput } from '../src/controller/channeli/NfircoThreadInput.js'
import { WebChannelHub } from '../src/component/channel/WebChannelHub.js'
import { WebThreadManager } from '../src/component/channel/WebThreadManager.js'
import { WebChannelOutput } from '../src/component/channelo/WebChannelOutput.js'
import { FeishuChannelOutput } from '../src/component/channelo/FeishuChannelOutput.js'
import { FeishuWebhookChannelOutput } from '../src/component/channelo/FeishuWebhookChannelOutput.js'
import { EmailChannelOutput } from '../src/component/channelo/EmailChannelOutput.js'
import { NfircoThreadOutput } from '../src/component/channelo/NfircoThreadOutput.js'
import { EventBus } from '../src/component/EventBus.js'
import { AppEvent } from '../src/value/Event.js'
import { IoThreadIdManager } from '../src/component/IoThreadIdManager.js'
import { ThreadWorkspaceResolver } from '../src/component/ThreadWorkspaceResolver.js'
import { EchoAgent } from '../src/component/agent/EchoAgent.js'
import { AgentManager } from '../src/component/agent/AgentManager.js'
import { CodexAgent } from '../src/component/agent/CodexAgent.js'
import { CodexClient } from '../src/component/agent/CodexClient.js'
import { CodexMessageStreamer } from '../src/component/agent/CodexMessageStreamer.js'
import { CommandExecutor } from '../src/controller/CommandExecutor.js'

const testToken = 'test-message-token'
const testMetadata = new CodexioMetadata()
const testServerStops = new WeakMap<HttpServer, () => Promise<Result<void>>>()
const nfircoAuthorization = `Basic ${Buffer.from('用户+Book:pass+密码', 'utf8').toString('base64')}`
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

class TestFeishuChannelInput extends FeishuChannelInput {
  readonly clients: FakeFeishuWsClient[] = []

  protected override createWsClient(options: FeishuWsClientOptions): Lark.WSClient {
    const client = new FakeFeishuWsClient(options)
    this.clients.push(client)
    return client as unknown as Lark.WSClient
  }
}

describe('server', () => {
  it('serves the Codexio web chat page', () => {
    expect(webPageHtml).toContain('Codexio')
    expect(webPageHtml).toContain('id="messages"')
    expect(webPageHtml).toContain('id="form"')
    expect(webPageHtml).toContain('id="threads"')
    expect(webPageHtml).toContain('newWebThreadId')
    expect(webPageHtml).toContain("message.type === 'agent'")
    expect(webPageHtml).toContain('replaceHistory')
    expect(webPageHtml).toContain('replaceThreads')
    expect(webPageHtml).toContain("fetch('/version')")
    expect(webPageHtml).toContain("'v' + version")
  })

  it('returns all described config fields to the config page', async () => {
    const { baseUrl, listener } = await startTestServer()
    const response = await fetch(`${baseUrl}/api/config`)
    const result = await response.json() as {
      isFailed: boolean
      data: {
        config: Record<string, unknown>
        descriptor: Array<{
          path: string
        }>
      }
    }
    expect(result.isFailed).toBe(false)
    expect(Object.keys(result.data.config).sort()).toEqual([
      'agents',
      'channeli',
      'channelo',
      'proxy',
      'server',
      'workspace'
    ])
    for (const field of result.data.descriptor) {
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
    socket.send(JSON.stringify({
      webThreadId: 'web-thread',
      text: 'hello'
    }))
    await waitForWebSocketMessages(messages, 2)
    expect(messages[0]).toMatchObject({
      event: 'message',
      role: 'user',
      webThreadId: 'web-thread',
      ioThreadId: expect.any(String),
      text: 'hello'
    })
    expect(messages[1]).toMatchObject({
      event: 'message',
      role: 'agent',
      webThreadId: 'web-thread',
      ioThreadId: expect.any(String),
      text: 'hello'
    })
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('restores conversation history on a new web connection', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    socket.send(JSON.stringify({
      webThreadId: 'web-thread-history',
      text: 'message'
    }))
    await waitForWebSocketMessages(messages, 2)
    const restored = await openRecordedWebSocket(baseUrl)
    await waitForWebSocketMessages(restored.messages, 1)
    expect(restored.messages[0]).toMatchObject({
      event: 'history',
      threads: [
        {
          id: 'web-thread-history',
          ioThreadId: expect.any(String),
          title: 'message'
        }
      ],
      messages: [
        {
          event: 'message',
          role: 'user',
          webThreadId: 'web-thread-history',
          ioThreadId: expect.any(String),
          text: 'message'
        },
        {
          event: 'message',
          role: 'agent',
          webThreadId: 'web-thread-history',
          ioThreadId: expect.any(String),
          text: 'message'
        }
      ]
    })
    await closeWebSocket(restored.socket)
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('broadcasts web user input and echo output', async () => {
    const { baseUrl, listener } = await startTestServer()
    const first = await openWebSocket(baseUrl)
    const second = await openWebSocket(baseUrl)
    const firstMessages = recordWebSocket(first)
    const secondMessages = recordWebSocket(second)
    first.send(JSON.stringify({
      webThreadId: 'web-thread-shared',
      text: 'shared input'
    }))
    await waitForWebSocketMessages(firstMessages, 2)
    await waitForWebSocketMessages(secondMessages, 2)
    expect(firstMessages[0]).toMatchObject({
      event: 'message',
      role: 'user',
      webThreadId: 'web-thread-shared',
      ioThreadId: expect.any(String),
      text: 'shared input'
    })
    expect(secondMessages[0]).toMatchObject({
      event: 'message',
      role: 'user',
      webThreadId: 'web-thread-shared',
      ioThreadId: expect.any(String),
      text: 'shared input'
    })
    expect(firstMessages[1]).toMatchObject({
      event: 'message',
      role: 'agent',
      webThreadId: 'web-thread-shared',
      ioThreadId: expect.any(String),
      text: 'shared input'
    })
    expect(secondMessages[1]).toMatchObject({
      event: 'message',
      role: 'agent',
      webThreadId: 'web-thread-shared',
      ioThreadId: expect.any(String),
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
    const input = new TestFeishuChannelInput(new Configer(metadata))
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

  it('reconnects nfirco thread input after the socket closes', async () => {
    const port = await resolveAvailableServerPort('127.0.0.1', 8787)
    const httpServer = new HttpServer((request, response) => {
      if (request.url === '/asset/readme.txt') {
        response.setHeader('Content-Type', 'text/plain')
        response.end('attachment body')
        return
      }
      response.statusCode = 404
      response.end()
    })
    const wsServer = new WebSocketServer({
      server: httpServer,
      path: '/api/threadio/ws'
    })
    const sockets: WebSocket[] = []
    const connectionHeaders: IncomingHttpHeaders[] = []
    let connectionCount = 0
    wsServer.on('connection', (socket, request) => {
      sockets.push(socket)
      connectionHeaders.push(request.headers)
      connectionCount += 1
      const currentConnection = connectionCount
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>
        if (message.type === 'thread.section.subscribe') {
          socket.send(JSON.stringify({
            type: 'thread.section.subscribed',
            section: message.section
          }))
          if (currentConnection === 1) {
            setTimeout(() => {
              socket.close()
            }, 10)
          }
        }
      })
    })
    httpServer.listen(port, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      httpServer.once('listening', resolve)
      httpServer.once('error', reject)
    })
    const dir = await mkdtemp(join(tmpdir(), 'codexio-nfirco-input-'))
    const configPath = join(dir, 'config.yaml')
    await writeFile(configPath, [
      'server:',
      '  host: 127.0.0.1',
      'channeli:',
      '  nfirco:',
      '    enabled: true',
      `    baseUrl: http://127.0.0.1:${port}`,
      '    account: 用户+Book',
      '    password: pass+密码',
      '    section: section-1',
      'channelo:',
      '  web:',
      '    enabled: true'
    ].join('\n'))
    const metadata = new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      configPath
    })
    const input = new NfircoThreadInput(new Configer(metadata), new FileStore(metadata))
    ;(input as unknown as { reconnectDelayMs: number }).reconnectDelayMs = 10
    const received: Array<Record<string, unknown>> = []
    await input.start({
      receive: async (source, message) => {
        received.push({
          source,
          text: message.text,
          channelThreadId: message.channelThreadId.id,
          files: (message.files ?? []).map((file) => ({
            name: file.name,
            mime: file.mime,
            path: file.path
          }))
        })
        return Result.success({
          ioThreadId: 'io-thread'
        })
      }
    })
    const startedAt = Date.now()
    while (connectionCount < 2) {
      if (Date.now() - startedAt > 4000) {
        throw new Error(`nfirco reconnect timeout: ${connectionCount}`)
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 5)
      })
    }
    expect(connectionHeaders[0].authorization).toBe(nfircoAuthorization)
    sockets[1].send(JSON.stringify({
      type: 'thread.message.created',
      eventId: 'event-1',
      threadUuid: 'thread-1',
      section: 'section-1',
      messageUuid: 'message-1',
      text: 'hello',
      files: [
        {
          id: 1,
          originalFilename: 'readme.txt',
          mimeType: 'text/plain',
          size: 15,
          url: `http://127.0.0.1:${port}/asset/readme.txt`
        }
      ]
    }))
    sockets[1].send(JSON.stringify({
      type: 'thread.created',
      eventId: 'thread-2',
      threadUuid: 'thread-2',
      section: 'section-1',
      text: 'thread body'
    }))
    await waitForWebSocketMessages(received, 2)
    expect(received).toEqual([
      {
        source: 'nfirco',
        text: 'hello',
        channelThreadId: 'thread-1',
        files: [
          {
            name: 'readme.txt',
            mime: 'text/plain',
            path: expect.any(String)
          }
        ]
      },
      {
        source: 'nfirco',
        text: 'thread body',
        channelThreadId: 'thread-2',
        files: []
      }
    ])
    const firstFiles = received[0].files as Array<{ path: string }>
    expect(await readFile(firstFiles[0].path, 'utf8')).toBe('attachment body')
    await input.stop()
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.close()
      }
    }
    await new Promise<void>((resolve) => {
      wsServer.close(() => resolve())
    })
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve())
    })
  })

  it('uploads nfirco output files before sending thread messages', async () => {
    const port = await resolveAvailableServerPort('127.0.0.1', 8787)
    let uploadedBody = ''
    let messageBody: Record<string, unknown> | undefined
    let uploadHeaders: IncomingHttpHeaders | undefined
    let messageHeaders: IncomingHttpHeaders | undefined
    const httpServer = new HttpServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/threadio/file/upload-url') {
        uploadHeaders = request.headers
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({
          code: '1',
          data: {
            id: 66,
            filename: 'agent.png',
            originalFilename: 'agent.png',
            size: 10,
            uploadUrl: `http://127.0.0.1:${port}/upload/66`,
            downloadUrl: `http://127.0.0.1:${port}/download/66`
          }
        }))
        return
      }
      if (request.method === 'PUT' && request.url === '/upload/66') {
        request.on('data', (chunk) => {
          uploadedBody += chunk.toString()
        })
        request.on('end', () => {
          response.statusCode = 200
          response.end()
        })
        return
      }
      if (request.method === 'POST' && request.url === '/api/threadio/thread/thread-1/message') {
        messageHeaders = request.headers
        let body = ''
        request.on('data', (chunk) => {
          body += chunk.toString()
        })
        request.on('end', () => {
          messageBody = JSON.parse(body) as Record<string, unknown>
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify({
            code: '1',
            data: {}
          }))
        })
        return
      }
      response.statusCode = 404
      response.end()
    })
    httpServer.listen(port, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      httpServer.once('listening', resolve)
      httpServer.once('error', reject)
    })
    const dir = await mkdtemp(join(tmpdir(), 'codexio-nfirco-output-'))
    const configPath = join(dir, 'config.yaml')
    await writeFile(configPath, [
      'workspace:',
      `  path: ${JSON.stringify(dir)}`,
      'channelo:',
      '  nfirco:',
      '    enabled: true',
      `    baseUrl: http://127.0.0.1:${port}`,
      '    account: 用户+Book',
      '    password: pass+密码'
    ].join('\n'))
    const metadata = new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      configPath
    })
    const fileStore = new FileStore(metadata)
    const file = await fileStore.importBuffer({
      buffer: Buffer.from('image-body'),
      name: 'agent.png',
      mime: 'image/png'
    })
    const ioThreadIdManager = createIoThreadIdManager()
    ioThreadIdManager.bind('io-thread', {
      source: 'nfirco',
      id: 'thread-1'
    })
    const output = new NfircoThreadOutput(new Configer(metadata), ioThreadIdManager)
    expect(await output.start()).toBe(true)
    const result = await output.send({
      ioThreadId: 'io-thread',
      role: 'agent',
      text: '看图',
      files: [
        file
      ]
    }, {
      source: 'nfirco'
    })
    expect(result.isFailed).toBe(false)
    expect(uploadedBody).toBe('image-body')
    expect(uploadHeaders?.authorization).toBe(nfircoAuthorization)
    expect(messageHeaders?.authorization).toBe(nfircoAuthorization)
    expect(messageBody).toMatchObject({
      text: '看图',
      fileIds: [],
      imageIds: [
        66
      ]
    })
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve())
    })
  })
})

async function startTestServer(): Promise<{
  baseUrl: string
  listener: HttpServer
}> {
  const port = await resolveAvailableServerPort('127.0.0.1', 8787)
  const dir = await mkdtemp(join(tmpdir(), 'codexio-app-'))
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
  const ioThreadIdManager = createIoThreadIdManager()
  const workspaceResolver = new ThreadWorkspaceResolver(configer, metadata)
  const codexClient = new CodexClient(configer, metadata, workspaceResolver)
  const webThreadManager = new WebThreadManager(ioThreadIdManager)
  const webHub = new WebChannelHub(fileStore, webThreadManager)
  const webInput = new WebChannelInput(configer, webHub)
  const webOutput = new WebChannelOutput(configer, webHub)
  const feishuInput = new FeishuChannelInput(configer)
  const feishuOutput = new FeishuChannelOutput(configer, ioThreadIdManager)
  const emailInput = new EmailChannelInput(configer)
  const emailOutput = new EmailChannelOutput(configer)
  const nfircoInput = new NfircoThreadInput(configer, fileStore)
  const nfircoOutput = new NfircoThreadOutput(configer, ioThreadIdManager)
  const outputManager = new ChannelOutputManager(
    configer,
    fileStore,
    eventBus,
    ioThreadIdManager,
    webOutput,
    feishuOutput,
    new FeishuWebhookChannelOutput(configer),
    emailOutput,
    nfircoOutput,
    workspaceResolver
  )
  const codexAgent = new CodexAgent(configer, eventBus, ioThreadIdManager, codexClient, new CodexMessageStreamer(eventBus))
  const echoAgent = new EchoAgent(eventBus)
  const agentManager = new AgentManager(configer, eventBus, codexAgent, echoAgent, workspaceResolver)
  const inputManager = new ChannelInputManager(configer, eventBus, ioThreadIdManager, new CommandExecutor(eventBus), webInput, feishuInput, emailInput, nfircoInput)
  const apiController = new CodexioApiController(configer, outputManager, fileStore, webHub, eventBus, metadata)
  await outputManager.start()
  await agentManager.start()
  await inputManager.start()
  const stop = async () => {
    await ignoreStopFailure(apiController.stop())
    await ignoreStopFailure(inputManager.stop())
    await ignoreStopFailure(agentManager.stop())
    await ignoreStopFailure(outputManager.stop())
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

function createIoThreadIdManager(): IoThreadIdManager {
  return new IoThreadIdManager(new CodexioMetadata({
    rootPath: testMetadata.rootPath,
    dataPath: join(tmpdir(), `codexio-io-thread-${randomUUID()}`)
  }))
}
