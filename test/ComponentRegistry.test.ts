import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ComponentRegistry } from '../src/ComponentRegistry.js'
import { Configer } from '../src/component/Configer.js'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { CodeioApp } from '../src/CodeioApp.js'
import { ChannelManager } from '../src/channel/ChannelManager.js'
import { AgentManager } from '../src/agent/AgentManager.js'
import { FileStore } from '../src/component/FileStore.js'
import { CommandExecutor } from '../src/controller/CommandExecutor.js'
import { CodexAgent } from '../src/agent/CodexAgent.js'
import { ClaudeAgent } from '../src/agent/ClaudeAgent.js'
import { SupervisorClient } from '../src/component/ServerLifecycle.js'

const testMetadata = new CodexioMetadata()

describe('component registry', () => {
  it('keeps root components singleton scoped', () => {
    const registry = new ComponentRegistry()

    expect(registry.resolve(CodexioMetadata)).toBe(registry.resolve(CodexioMetadata))
    expect(registry.resolve(CodeioApp)).toBe(registry.resolve(CodeioApp))
  })

  it('replaces server scoped components with configured runtime values', async () => {
    const registry = new ComponentRegistry()
    const configer = await createTestConfiger()

    await registry.registerServer({
      configer
    })

    expect(registry.resolve(Configer)).toBe(configer)
    expect(registry.resolve(SupervisorClient)).toBe(registry.resolve(SupervisorClient))
    expect(registry.resolve(CodexAgent)).toBe(registry.resolve(CodexAgent))
    expect(registry.resolve(ClaudeAgent)).toBe(registry.resolve(ClaudeAgent))
    expect(registry.resolve(ChannelManager)).toBe(registry.resolve(ChannelManager))
    expect(registry.resolve(AgentManager)).toBe(registry.resolve(AgentManager))
    expect(registry.resolve(FileStore)).toBe(registry.resolve(FileStore))
    expect(registry.resolve(CommandExecutor)).toBe(registry.resolve(CommandExecutor))
  })
})

async function createTestConfiger(): Promise<Configer> {
  const dir = await mkdtemp(join(tmpdir(), 'codexio-registry-'))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  const configPath = join(dir, 'config.yaml')
  await writeFile(configPath, [
    'server:',
    '  token: test-token',
    'agents:',
    '  codex:',
    '    enabled: false',
    '  claude:',
    '    enabled: true',
  'channels:',
  '  web:',
  '    enabled: true',
  '    host: 127.0.0.1',
  '    port: 19888',
    'workspace:',
    `  path: ${workspace}`
  ].join('\n'), 'utf8')
  return new Configer(new CodexioMetadata({
    rootPath: testMetadata.rootPath,
    configPath
  }))
}
