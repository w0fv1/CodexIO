import express from 'express'
import cors from 'cors'
import { AgentRuntime, ChannelAdapter, CodexExecRuntime, CodexioConfig, EchoRuntime, InboundTextMessage, OutboundPolicy, ProcessRuntime, Result, Router, RuntimeManager, RuntimeRegistry, buildAgentEnv } from '@codexio/core'
import { CliChannelAdapter } from './channel/CliChannelAdapter.js'
import { WebChannelAdapter } from './channel/WebChannelAdapter.js'

export type CodexioServer = {
  app: express.Express
  registry: RuntimeRegistry
  web: WebChannelAdapter
  cli: CliChannelAdapter
}

export function createCodexioApp(config: CodexioConfig): CodexioServer {
  const app = express()
  app.use(cors())
  app.use(express.json({
    limit: '1mb'
  }))

  const registry = new RuntimeRegistry()
  const web = new WebChannelAdapter()
  const cli = new CliChannelAdapter()
  const adapters = new Map<string, ChannelAdapter>([
    [
      web.type,
      web
    ],
    [
      cli.type,
      cli
    ]
  ])
  const policy = new OutboundPolicy(config)
  const toolBaseUrl = config.server.publicUrl ?? `http://${config.server.host}:${config.server.port}`
  const runtimes = new Map<string, AgentRuntime>([
    [
      'echo',
      new EchoRuntime({
        onMessage: async (runtimeId, text) => {
          const context = registry.findByRuntime(runtimeId)
          if (!context) {
            throw new Error(`runtime context not found: ${runtimeId}`)
          }
          const adapter = adapters.get(context.channel)
          if (!adapter) {
            throw new Error(`channel adapter not found: ${context.channel}`)
          }
          const checked = policy.check(runtimeId, text)
          if (checked.isFailed) {
            throw new Error(checked.message)
          }
          await adapter.sendText({
            conversationId: context.conversationId,
            text
          })
        }
      })
    ]
  ])
  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (agentName !== 'echo' && agent.enabled) {
      if (agentName === 'codex') {
        runtimes.set(agentName, new CodexExecRuntime({
          agent,
          toolBaseUrl,
          onMessage: async (runtimeId, text) => {
            const context = registry.findByRuntime(runtimeId)
            if (!context) {
              throw new Error(`runtime context not found: ${runtimeId}`)
            }
            const adapter = adapters.get(context.channel)
            if (!adapter) {
              throw new Error(`channel adapter not found: ${context.channel}`)
            }
            const checked = policy.check(runtimeId, text)
            if (checked.isFailed) {
              throw new Error(checked.message)
            }
            await adapter.sendText({
              conversationId: context.conversationId,
              text
            })
          }
        }))
        continue
      }
      runtimes.set(agentName, new ProcessRuntime({
        type: agentName,
        agent,
        onMessage: async (runtimeId, text) => {
          const context = registry.findByRuntime(runtimeId)
          if (!context) {
            throw new Error(`runtime context not found: ${runtimeId}`)
          }
          const adapter = adapters.get(context.channel)
          if (!adapter) {
            throw new Error(`channel adapter not found: ${context.channel}`)
          }
          const checked = policy.check(runtimeId, text)
          if (checked.isFailed) {
            throw new Error(checked.message)
          }
          await adapter.sendText({
            conversationId: context.conversationId,
            text
          })
        }
      }))
    }
  }
  const manager = new RuntimeManager({
    config,
    registry,
    runtimes,
    env: buildAgentEnv(config)
  })
  const router = new Router(config)

  app.get('/', (_request, response) => {
    response.type('html').send(renderWebPage())
  })

  app.get('/api/health', (_request, response) => {
    response.json(Result.success({
      ok: true
    }))
  })

  app.post('/api/messages/inbound', async (request, response) => {
    try {
      const messages = await parseMessages(adapters, request.headers, request.body)
      if (messages.length === 0) {
        response.json(Result.fail('inbound text not found'))
        return
      }
      const contexts = []
      for (const message of messages) {
        const workspaceName = router.selectWorkspace(message)
        contexts.push(await manager.accept(message, workspaceName))
      }
      response.json(Result.success({
        runtimeId: contexts[0].runtimeId
      }))
    } catch (error) {
      response.json(Result.fromError(error))
    }
  })

  app.post('/api/tools/send_message', async (request, response) => {
    try {
      const body = request.body as Record<string, unknown>
      if (typeof body.text !== 'string' || body.text.trim().length === 0) {
        response.json(Result.fail('text is required'))
        return
      }
      let runtimeId = request.header('x-codexio-runtime-id')
      if (!runtimeId && typeof body.runtimeId === 'string') {
        runtimeId = body.runtimeId
      }
      if (!runtimeId) {
        response.json(Result.fail('runtime context not found'))
        return
      }
      const context = registry.findByRuntime(runtimeId)
      if (!context) {
        response.json(Result.fail('runtime context not found'))
        return
      }
      const checked = policy.check(runtimeId, body.text)
      if (checked.isFailed) {
        response.json(Result.fail(checked.message))
        return
      }
      const adapter = adapters.get(context.channel)
      if (!adapter) {
        response.json(Result.fail(`channel adapter not found: ${context.channel}`))
        return
      }
      await adapter.sendText({
        conversationId: context.conversationId,
        text: body.text
      })
      response.json(Result.success({
        sent: true
      }))
    } catch (error) {
      response.json(Result.fromError(error))
    }
  })

  app.post('/api/web/messages', async (request, response) => {
    const body = request.body as Record<string, unknown>
    request.body = {
      ...body,
      channel: 'web'
    }
    try {
      const messages = await web.parseInbound({
        headers: request.headers,
        body: request.body
      })
      if (messages.length === 0) {
        response.json(Result.fail('inbound text not found'))
        return
      }
      const context = await manager.accept(messages[0], router.selectWorkspace(messages[0]))
      response.json(Result.success({
        runtimeId: context.runtimeId
      }))
    } catch (error) {
      response.json(Result.fromError(error))
    }
  })

  app.get('/api/web/messages/:conversationId', (request, response) => {
    response.json(Result.success(web.history(request.params.conversationId)))
  })

  app.get('/api/web/events/:conversationId', (request, response) => {
    response.setHeader('Content-Type', 'text/event-stream')
    response.setHeader('Cache-Control', 'no-cache')
    response.setHeader('Connection', 'keep-alive')
    for (const message of web.history(request.params.conversationId)) {
      response.write(`data: ${JSON.stringify(message)}\n\n`)
    }
    const unsubscribe = web.subscribe(request.params.conversationId, (message) => {
      response.write(`data: ${JSON.stringify(message)}\n\n`)
    })
    request.on('close', unsubscribe)
  })

  return {
    app,
    registry,
    web,
    cli
  }
}

async function parseMessages(adapters: Map<string, ChannelAdapter>, headers: Record<string, string | string[] | undefined>, body: unknown): Promise<InboundTextMessage[]> {
  if (!body || typeof body !== 'object') {
    return []
  }
  const record = body as Record<string, unknown>
  if (typeof record.channel !== 'string') {
    return []
  }
  const adapter = adapters.get(record.channel)
  if (!adapter) {
    throw new Error(`channel adapter not found: ${record.channel}`)
  }
  return adapter.parseInbound({
    headers,
    body
  })
}

function renderWebPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Codexio</title>
  <style>
    body{margin:0;font-family:Arial,"Microsoft YaHei",sans-serif;background:#f6f7f9;color:#16181d}
    main{height:100vh;display:grid;grid-template-rows:auto 1fr auto;max-width:920px;margin:0 auto;background:#fff}
    header{padding:18px 22px;border-bottom:1px solid #e4e7ec;display:flex;justify-content:space-between;align-items:center}
    h1{font-size:20px;margin:0;font-weight:700}
    #status{font-size:13px;color:#667085}
    #messages{padding:18px 22px;overflow:auto;display:flex;flex-direction:column;gap:12px}
    .message{max-width:78%;padding:10px 12px;border-radius:8px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
    .user{align-self:flex-end;background:#185abc;color:#fff}
    .agent{align-self:flex-start;background:#eef2f7;color:#101828}
    form{display:grid;grid-template-columns:1fr auto;gap:10px;padding:14px 22px;border-top:1px solid #e4e7ec}
    textarea{resize:none;min-height:48px;max-height:160px;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}
    button{border:0;border-radius:8px;background:#185abc;color:#fff;padding:0 18px;font-weight:700;cursor:pointer}
    button:disabled{background:#98a2b3;cursor:default}
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Codexio</h1>
      <div id="status">web adapter</div>
    </header>
    <section id="messages"></section>
    <form id="form">
      <textarea id="text" placeholder="输入文本" required></textarea>
      <button id="send" type="submit">发送</button>
    </form>
  </main>
  <script>
    const conversationId = 'browser'
    const messages = document.querySelector('#messages')
    const form = document.querySelector('#form')
    const text = document.querySelector('#text')
    const send = document.querySelector('#send')
    const status = document.querySelector('#status')
    let runtimeId = ''
    function append(className, value) {
      const element = document.createElement('div')
      element.className = 'message ' + className
      element.textContent = value
      messages.appendChild(element)
      messages.scrollTop = messages.scrollHeight
    }
    const events = new EventSource('/api/web/events/' + conversationId)
    events.onmessage = (event) => {
      const message = JSON.parse(event.data)
      append('agent', message.text)
    }
    events.onopen = () => {
      status.textContent = 'web adapter connected'
    }
    events.onerror = () => {
      status.textContent = 'web adapter reconnecting'
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const value = text.value.trim()
      if (!value) {
        return
      }
      append('user', value)
      text.value = ''
      send.disabled = true
      const response = await fetch('/api/web/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          conversationId,
          text: value
        })
      })
      const result = await response.json()
      if (result.data && result.data.runtimeId) {
        runtimeId = result.data.runtimeId
      }
      if (result.isFailed) {
        append('agent', result.message)
      }
      send.disabled = false
      text.focus()
    })
  </script>
</body>
</html>`
}
