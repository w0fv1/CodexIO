import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { Server as HttpServer } from 'node:http'
import { ConfigSchema } from './ConfigService.js'
import { createCodexioApp } from './index.js'
import { webPageHtml } from './channel/WebPage.js'

const testMessageToken = 'test-message-token'

describe('server', () => {
  it('serves a compact Codexio web chat page', () => {
    expect(webPageHtml).toContain('<span>Codexio</span>')
    expect(webPageHtml).toContain('id="messages"')
    expect(webPageHtml).toContain('id="form"')
    expect(webPageHtml).not.toContain('让 coding agent 通过统一通道工作')
    expect(webPageHtml).not.toContain('Codex CLI')
  })

  it('receives web text', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    socket.send(JSON.stringify({
      text: 'hello'
    }))
    await waitForWebSocketMessages(messages, 1)
    const message = messages[0]
    expect(message).toMatchObject({
      type: 'agent',
      text: 'echo: hello'
    })
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('clears the active agent conversation', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    socket.send(JSON.stringify({
      text: 'first'
    }))
    await waitForWebSocketMessages(messages, 1)
    socket.send(JSON.stringify({
      text: '/$ clear'
    }))
    await waitForWebSocketMessages(messages, 2)
    const clear = messages[1]
    socket.send(JSON.stringify({
      text: 'second'
    }))
    await waitForWebSocketMessages(messages, 3)
    const second = messages[2]
    expect(clear).toMatchObject({
      type: 'clear'
    })
    expect(second).toMatchObject({
      type: 'agent',
      text: 'echo: second'
    })
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('does not expose web history as external API', async () => {
    const { baseUrl, listener } = await startTestServer()
    const messages = await fetch(`${baseUrl}/api/web/messages`)
    const events = await fetch(`${baseUrl}/api/web/events`)
    expect(messages.status).toBe(404)
    expect(events.status).toBe(404)
    await closeTestServer(listener)
  })

  it('accepts agent output through the configured default channel', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    const response = await fetch(`${baseUrl}/api/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testMessageToken}`
      },
      body: JSON.stringify({
        text: 'agent output'
      })
    })
    const result = await response.json() as {
      isFailed: boolean
    }
    await waitForWebSocketMessages(messages, 1)
    const message = messages[0]
    expect(result.isFailed).toBe(false)
    expect(message).toMatchObject({
      type: 'agent',
      text: 'agent output'
    })
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('rejects unauthenticated agent output', async () => {
    const { baseUrl, listener } = await startTestServer()
    const response = await fetch(`${baseUrl}/api/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: 'agent output'
      })
    })
    const result = await response.json() as {
      isFailed: boolean
      message: string
    }
    expect(response.status).toBe(401)
    expect(result.isFailed).toBe(true)
    expect(result.message).toBe('unauthorized')
    await closeTestServer(listener)
  })

  it('broadcasts agent output to every web connection', async () => {
    const { baseUrl, listener } = await startTestServer()
    const first = await openWebSocket(baseUrl)
    const second = await openWebSocket(baseUrl)
    const firstMessages = recordWebSocket(first)
    const secondMessages = recordWebSocket(second)
    const response = await fetch(`${baseUrl}/api/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testMessageToken}`
      },
      body: JSON.stringify({
        text: 'broadcast output'
      })
    })
    const result = await response.json() as {
      isFailed: boolean
    }
    await waitForWebSocketMessages(firstMessages, 1)
    await waitForWebSocketMessages(secondMessages, 1)
    const firstMessage = firstMessages[0]
    const secondMessage = secondMessages[0]
    expect(result.isFailed).toBe(false)
    expect(firstMessage).toMatchObject({
      type: 'agent',
      text: 'broadcast output'
    })
    expect(secondMessage).toMatchObject({
      type: 'agent',
      text: 'broadcast output'
    })
    await closeWebSocket(first)
    await closeWebSocket(second)
    await closeTestServer(listener)
  })

  it('restores latest adapter manager messages in web channel', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    for (let index = 1; index <= 12; index += 1) {
      socket.send(JSON.stringify({
        text: `message ${index}`
      }))
      await waitForWebSocketMessages(messages, index)
    }
    const restored: Array<Record<string, unknown>> = []
    const restoredUrl = baseUrl.replace('http://', 'ws://').replace('https://', 'wss://')
    const restoredSocket = new WebSocket(`${restoredUrl}/ws`)
    await new Promise<void>((resolve, reject) => {
      restoredSocket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>
        if (message.type !== 'ready') {
          restored.push(message)
        }
        if (restored.length === 20) {
          resolve()
        }
      })
      restoredSocket.once('error', reject)
    })
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
    expect(restored).toHaveLength(20)
    expect(restored[0]).toMatchObject({
      type: 'human',
      text: 'message 3'
    })
    expect(restored[1]).toMatchObject({
      type: 'agent',
      text: 'echo: message 3'
    })
    expect(restored[19]).toMatchObject({
      type: 'agent',
      text: 'echo: message 12'
    })
    await closeWebSocket(restoredSocket)
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('does not expose legacy inbound API', async () => {
    const { baseUrl, listener } = await startTestServer()
    const response = await fetch(`${baseUrl}/api/messages/inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        channel: 'cli',
        text: 'hello'
      })
    })
    expect(response.status).toBe(404)
    await closeTestServer(listener)
  })

  it('starts host before reporting agent startup failure', async () => {
    const config = ConfigSchema.parse({
      server: {
        messageToken: testMessageToken
      },
      agents: {
        codex: {
          enabled: true
        },
        claude: {
          enabled: true
        }
      },
      channels: {
        web: {
          enabled: true
        }
      },
      workspace: {
        path: '.'
      }
    })
    const server = createCodexioApp(config)
    const listener = server.listen(0)
    await new Promise<void>((resolve) => listener.once('listening', resolve))
    const address = listener.address()
    if (!address || typeof address === 'string') {
      throw new Error('server address not found')
    }
    let status: {
      isFailed: boolean
      data: {
        status: string
        message: string
      }
    } | undefined
    const startedAt = Date.now()
    while (status?.data.status !== 'failed') {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/status`)
      status = await response.json() as {
        isFailed: boolean
        data: {
          status: string
          message: string
        }
      }
      if (Date.now() - startedAt > 4000) {
        throw new Error('agent status timeout')
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 5)
      })
    }
    expect(status.isFailed).toBe(false)
    expect(status.data.message).toBe('only one agent can be enabled')
    await closeTestServer(listener)
  })
})

async function startTestServer(): Promise<{
  baseUrl: string
  listener: HttpServer
}> {
  const config = ConfigSchema.parse({
    server: {
      messageToken: testMessageToken
    },
    agents: {
      codex: {
        enabled: false
      },
      claude: {
        enabled: false
      },
      echo: {
        enabled: true
      }
    },
    channels: {
      web: {
        enabled: true
      }
    },
    workspace: {
      path: '.'
    }
  })
  const server = createCodexioApp(config)
  const listener = server.listen(0)
  await new Promise<void>((resolve) => listener.once('listening', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') {
    throw new Error('server address not found')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    listener
  }
}

async function openWebSocket(baseUrl: string): Promise<WebSocket> {
  const url = baseUrl.replace('http://', 'ws://').replace('https://', 'wss://')
  const socket = new WebSocket(`${url}/ws`)
  await new Promise<void>((resolve, reject) => {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>
      if (message.type === 'ready') {
        resolve()
      }
    })
    socket.once('error', reject)
  })
  return socket
}

function recordWebSocket(socket: WebSocket): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>
    if (message.type !== 'ready') {
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

async function closeTestServer(listener: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}
