import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { Server as HttpServer } from 'node:http'
import { ConfigSchema } from './ConfigService.js'
import { createCodexioApp } from './index.js'
import { webPageHtml } from './channel/WebPage.js'

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
    socket.send(JSON.stringify({
      text: 'hello'
    }))
    const message = await readWebSocketMessage(socket)
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
    socket.send(JSON.stringify({
      text: 'first'
    }))
    await readWebSocketMessage(socket)
    socket.send(JSON.stringify({
      text: '/$ clear'
    }))
    const clear = await readWebSocketMessage(socket)
    socket.send(JSON.stringify({
      text: 'second'
    }))
    const second = await readWebSocketMessage(socket)
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
    }
    expect(result.isFailed).toBe(false)
    await closeTestServer(listener)
  })

  it('starts only configured channels', async () => {
    const config = ConfigSchema.parse({
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
        cli: {
          enabled: true
        }
      },
      workspace: {
        path: '.'
      }
    })
    const server = createCodexioApp(config)
    const ready = await server.ready
    expect(ready.isFailed).toBe(false)
    const listener = server.listen(0)
    await new Promise<void>((resolve) => listener.once('listening', resolve))
    const address = listener.address()
    if (!address || typeof address === 'string') {
      throw new Error('server address not found')
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/`)
    expect(response.status).toBe(404)
    await closeTestServer(listener)
  })

  it('rejects ambiguous enabled agents', async () => {
    const config = ConfigSchema.parse({
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
    const ready = await server.ready
    expect(ready.isFailed).toBe(true)
    expect(ready.message).toBe('only one agent can be enabled')
  })
})

async function startTestServer(): Promise<{
  baseUrl: string
  listener: HttpServer
}> {
  const config = ConfigSchema.parse({
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
  const ready = await server.ready
  if (ready.isFailed) {
    throw new Error(ready.message)
  }
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
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

async function readWebSocketMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  const data = await new Promise<WebSocket.RawData>((resolve, reject) => {
    socket.once('message', resolve)
    socket.once('error', reject)
  })
  return JSON.parse(data.toString()) as Record<string, unknown>
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
