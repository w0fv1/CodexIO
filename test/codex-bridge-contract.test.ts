import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Configer } from '../src/component/Configer.js'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { ThreadWorkspaceResolver } from '../src/component/ThreadWorkspaceResolver.js'
import { CodexClient, CodexClientMessage } from '../src/component/agent/codex/CodexClient.js'
import { createDefaultConfig } from '../src/value/ConfigDefinition.js'

function client() {
  const defaults = createDefaultConfig()
  defaults.app.workspace.perIoThread = true
  const config = { get: async (path: string) => path.split('.').reduce((value: any, key) => value[key], defaults) } as Configer
  const metadata = new CodexioMetadata({ dataPath: join(tmpdir(), `codexio-contract-${randomUUID()}`) })
  return new CodexClient(config, metadata, new ThreadWorkspaceResolver(config, metadata))
}

describe('Codex bridge contract', () => {
  it('uses the same effective execution configuration for creation and resume', async () => {
    const first = client()
    const second = client()
    const requests: { method: string, params: any }[] = []
    for (const instance of [first, second]) instance['request'] = async (method, params) => {
      requests.push({ method, params })
      return method === 'turn/start' ? { turn: { id: 'turn' } } : { thread: { id: 'codex-thread', status: { type: 'idle' } } }
    }
    const input = { thread: { id: 'local-thread', name: 'Task' }, text: 'continue', mcpServers: { site: { url: 'http://localhost/mcp', required: true } } }
    expect((await first.send(input)).isFailed).toBe(false)
    expect((await second.send({ ...input, threadId: 'codex-thread' })).isFailed).toBe(false)
    const start = requests.find(r => r.method === 'thread/start')!.params
    const resume = requests.find(r => r.method === 'thread/resume')!.params
    for (const key of ['model', 'approvalPolicy', 'sandbox', 'developerInstructions', 'config']) expect(resume[key]).toEqual(start[key])
    expect(resume.cwd).toContain('local-thread')
    expect(resume.sandbox).toBe('danger-full-access')
    expect(resume.excludeTurns).toBe(true)
  })

  it.each(['failed', 'interrupted'])('forwards a %s turn as failure rather than completion', status => {
    const instance = client()
    const messages: CodexClientMessage[] = []
    instance.on('message', message => messages.push(message))
    instance['handleNotification']('turn/completed', { threadId: 'thread', turn: { id: 'turn', status, error: { message: 'execution blocked' }, items: [] } })
    expect(messages).toContainEqual(expect.objectContaining({ status: 'failed', text: 'execution blocked' }))
    expect(messages.some(m => m.status === 'turnCompleted')).toBe(false)
  })
})
