import { Server as HttpServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
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
import { WebChannelOutput } from '../src/component/channelo/WebChannelOutput.js'
import { FeishuChannelOutput } from '../src/component/channelo/FeishuChannelOutput.js'
import { FeishuWebhookChannelOutput } from '../src/component/channelo/FeishuWebhookChannelOutput.js'
import { EmailChannelOutput } from '../src/component/channelo/EmailChannelOutput.js'
import { NfircoThreadOutput } from '../src/component/channelo/NfircoThreadOutput.js'
import { EventBus } from '../src/component/EventBus.js'
import { AppEvent } from '../src/value/Event.js'
import { IoThreadIdManager } from '../src/component/IoThreadIdManager.js'
import { EchoAgent } from '../src/component/agent/EchoAgent.js'
import { AgentManager } from '../src/component/agent/AgentManager.js'
import { CodexAgent } from '../src/component/agent/CodexAgent.js'
import { CodexClient } from '../src/component/agent/CodexClient.js'
import { CodexMessageStreamer } from '../src/component/agent/CodexMessageStreamer.js'
import { CommandExecutor } from '../src/controller/CommandExecutor.js'

const testToken = 'test-message-token'
const testMetadata = new CodexioMetadata()
const testServerStops = new WeakMap<HttpServer, () => Promise<Result<void>>>()

describe('server', () => {
  it('serves the Codexio web chat page', () => {
    expect(webPageHtml).toContain('Codexio')
    expect(webPageHtml).toContain('id="messages"')
    expect(webPageHtml).toContain('id="form"')
    expect(webPageHtml).toContain('id="threads"')
    expect(webPageHtml).toContain('newWebThreadId')
    expect(webPageHtml).toContain("message.type === 'agent'")
    expect(webPageHtml).not.toContain('snapshot')
    expect(webPageHtml).not.toContain('replaceMessages')
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
    const restoredMessages = restored.messages
    await waitForWebSocketMessages(restoredMessages, 2)
    expect(restoredMessages[0]).toMatchObject({
      event: 'message',
      role: 'user',
      webThreadId: 'web-thread-history',
      ioThreadId: expect.any(String),
      text: 'message'
    })
    expect(restoredMessages[1]).toMatchObject({
      event: 'message',
      role: 'agent',
      webThreadId: 'web-thread-history',
      ioThreadId: expect.any(String),
      text: 'message'
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

  it('reconnects nfirco thread input after the socket closes', async () => {
    const port = await resolveAvailableServerPort('127.0.0.1', 8787)
    const httpServer = new HttpServer()
    const wsServer = new WebSocketServer({
      server: httpServer,
      path: '/api/threadio/ws'
    })
    const sockets: WebSocket[] = []
    let connectionCount = 0
    wsServer.on('connection', (socket) => {
      sockets.push(socket)
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
      '    account: user',
      '    password: pass',
      '    section: section-1',
      'channelo:',
      '  web:',
      '    enabled: true'
    ].join('\n'))
    const input = new NfircoThreadInput(new Configer(new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      configPath
    })))
    ;(input as unknown as { reconnectDelayMs: number }).reconnectDelayMs = 10
    const received: Array<Record<string, unknown>> = []
    await input.start({
      receive: async (inputType, message) => {
        received.push({
          inputType,
          text: message.text,
          platformThreadId: message.platformThreadIds[0]?.id
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
    sockets[1].send(JSON.stringify({
      type: 'thread.message.created',
      eventId: 'event-1',
      threadUuid: 'thread-1',
      section: 'section-1',
      messageUuid: 'message-1',
      text: 'hello'
    }))
    await waitForWebSocketMessages(received, 1)
    expect(received).toEqual([
      {
        inputType: 'nfirco',
        text: 'hello',
        platformThreadId: 'thread-1'
      }
    ])
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
  const ioThreadIdManager = new IoThreadIdManager()
  const webHub = new WebChannelHub(fileStore)
  const webInput = new WebChannelInput(configer, webHub)
  const webOutput = new WebChannelOutput(configer, webHub, ioThreadIdManager)
  const feishuInput = new FeishuChannelInput(configer)
  const feishuOutput = new FeishuChannelOutput(configer, ioThreadIdManager)
  const emailInput = new EmailChannelInput(configer)
  const emailOutput = new EmailChannelOutput(configer)
  const nfircoInput = new NfircoThreadInput(configer)
  const nfircoOutput = new NfircoThreadOutput(configer, ioThreadIdManager)
  const outputManager = new ChannelOutputManager(
    configer,
    eventBus,
    ioThreadIdManager,
    webOutput,
    feishuOutput,
    new FeishuWebhookChannelOutput(configer),
    emailOutput,
    nfircoOutput
  )
  const codexClient = new CodexClient(configer, metadata)
  const codexAgent = new CodexAgent(configer, eventBus, ioThreadIdManager, codexClient, new CodexMessageStreamer(eventBus))
  const echoAgent = new EchoAgent(eventBus)
  const agentManager = new AgentManager(configer, eventBus, codexAgent, echoAgent)
  const inputManager = new ChannelInputManager(configer, eventBus, ioThreadIdManager, new CommandExecutor(eventBus), webInput, feishuInput, emailInput, nfircoInput)
  const apiController = new CodexioApiController(configer, outputManager, fileStore, webHub, eventBus)
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
  const messages = recordWebSocket(socket)
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
