import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { inject, injectable } from 'inversify'
import { MessageThread } from '../value/Message.js'
import { CodexioMetadata } from './CodexioMetadata.js'
import { Logger } from './Logger.js'

export type IoThreadSource = 'web' | 'feishu' | 'email' | 'userver'

export type ChannelThreadId = {
  source: IoThreadSource
  id: string
}

export type WebThreadIdentity = {
  id: string
  thread: MessageThread
  createdAt: number
  updatedAt: number
}

export type FeishuRoute = {
  state: 'unbound' | 'retired'
} | {
  state: 'active'
  threadId?: string
}

type ThreadRegistryEventMap = {
  changed: () => void
  renamed: (thread: MessageThread) => void
}

type ConversationRow = {
  io_thread_id: string
  web_thread_id: string
  name: string
  created_at: number
  updated_at: number
  last_active_at: number
}

type ChannelBindingRow = {
  source: Exclude<IoThreadSource, 'web'>
  scope_id: string
  external_thread_id: string
  state: 'active' | 'retired'
}

type NormalizedChannelIdentity = {
  source: IoThreadSource
  scopeId: string
  externalThreadId: string
}

const schemaVersion = 3

@injectable()
export class ThreadRegistry {
  private readonly events = new EventEmitter()
  private readonly statePath: string
  private database?: DatabaseSync
  private selectConversationById?: StatementSync
  private selectConversationByWebId?: StatementSync
  private selectConversationByChannel?: StatementSync

  constructor(@inject(CodexioMetadata) metadata: CodexioMetadata) {
    this.statePath = metadata.threadIdentityStatePath
  }

  on<K extends keyof ThreadRegistryEventMap>(event: K, listener: ThreadRegistryEventMap[K]): () => void {
    this.events.on(event, listener)
    return () => this.events.off(event, listener)
  }

  async init(): Promise<void> {
    this.ensureDatabase()
  }

  async close(): Promise<void> {
    if (!this.database) {
      return
    }
    this.database.close()
    this.database = undefined
    this.selectConversationById = undefined
    this.selectConversationByWebId = undefined
    this.selectConversationByChannel = undefined
  }

  createWebThread(preferredName?: string): WebThreadIdentity {
    const webThreadId = randomUUID()
    const thread = this.resolve({
      source: 'web',
      id: webThreadId
    }, preferredName)
    const row = this.findById(thread.id)
    if (!row) {
      throw new Error(`created thread not found: ${thread.id}`)
    }
    return {
      id: webThreadId,
      thread,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  resolve(channelThreadId: ChannelThreadId, firstMessage?: string): MessageThread {
    const identity = normalizeChannelIdentity(channelThreadId)
    const existing = this.findByChannel(identity)
    if (existing) {
      if (firstMessage !== undefined) this.setFirstMessage(existing.io_thread_id, firstMessage)
      this.touch(existing.io_thread_id)
      const value = this.requireThread(existing.io_thread_id)
      Logger.info('thread registry resolved channel thread', {
        resolution: 'existing',
        channelSource: identity.source,
        channelThreadId: channelThreadId.id,
        ioThreadId: value.id,
        bindings: this.getChannelThreadIds(value.id)
      })
      return value
    }
    const ioThreadId = randomUUID()
    const webThreadId = identity.source === 'web' ? identity.externalThreadId : randomUUID()
    const name = normalizeThreadName(firstMessage)
    const now = Date.now()
    this.transaction(() => {
      this.requireDatabase().prepare(`
        INSERT INTO conversation (
          io_thread_id,
          web_thread_id,
          name,
          created_at,
          updated_at,
          last_active_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(ioThreadId, webThreadId, name, now, now, now)
      if (firstMessage !== undefined) this.requireDatabase().prepare('UPDATE conversation SET title_initialized=1 WHERE io_thread_id=?').run(ioThreadId)
      if (identity.source !== 'web') {
        this.insertChannelBinding(ioThreadId, identity)
      }
    })
    const thread = { id: ioThreadId, name }
    this.events.emit('changed')
    Logger.info('thread registry resolved channel thread', {
      resolution: 'created',
      channelSource: identity.source,
      channelThreadId: channelThreadId.id,
      ioThreadId,
      bindings: this.getChannelThreadIds(ioThreadId)
    })
    return thread
  }

  ensure(id: string, preferredName?: string): MessageThread {
    const normalizedId = normalizeRequired(id, 'thread id')
    const existing = this.findById(normalizedId)
    if (existing) {
      this.touch(normalizedId)
      return toMessageThread(existing)
    }
    const now = Date.now()
    const name = normalizeThreadName(preferredName)
    this.requireDatabase().prepare(`
      INSERT INTO conversation (
        io_thread_id,
        web_thread_id,
        name,
        created_at,
        updated_at,
        last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(normalizedId, randomUUID(), name, now, now, now)
    this.events.emit('changed')
    return { id: normalizedId, name }
  }

  get(id: string): MessageThread | undefined {
    const normalizedId = id.trim()
    if (!normalizedId) {
      return undefined
    }
    const row = this.findById(normalizedId)
    return row ? toMessageThread(row) : undefined
  }

  getLastActive(): MessageThread | undefined {
    const row = this.requireDatabase().prepare(`
      SELECT *
      FROM conversation
      ORDER BY last_active_at DESC, created_at DESC, io_thread_id ASC
      LIMIT 1
    `).get() as ConversationRow | undefined
    return row ? toMessageThread(row) : undefined
  }

  getWebThreadId(ioThreadId: string): string | undefined {
    return this.findById(ioThreadId.trim())?.web_thread_id
  }

  listWebThreads(): WebThreadIdentity[] {
    const rows = this.requireDatabase().prepare(`
      SELECT *
      FROM conversation
      ORDER BY last_active_at DESC, created_at DESC, io_thread_id ASC
    `).all() as unknown as ConversationRow[]
    return rows.map((row) => ({
      id: row.web_thread_id,
      thread: toMessageThread(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  getChannelThreadIds(threadId: string): ChannelThreadId[] {
    const row = this.findById(threadId.trim())
    if (!row) {
      return []
    }
    const bindings: ChannelThreadId[] = []
    const rows = this.requireDatabase().prepare(`
      SELECT source, scope_id, external_thread_id, state
      FROM channel_binding
      WHERE io_thread_id = ? AND state = 'active'
      ORDER BY id ASC
    `).all(row.io_thread_id) as unknown as ChannelBindingRow[]
    for (const binding of rows) {
      bindings.push(toChannelThreadId(binding))
    }
    return bindings
  }

  bind(threadId: string, channelThreadId: ChannelThreadId): void {
    const thread = this.ensure(threadId)
    const identity = normalizeChannelIdentity(channelThreadId)
    if (identity.source === 'web') {
      this.bindWebThread(thread.id, identity.externalThreadId)
      return
    }
    const owner = this.findByChannel(identity)
    if (owner && owner.io_thread_id !== thread.id) {
      throw new Error('thread key already bound')
    }
    const existing = this.requireDatabase().prepare(`
      SELECT source, scope_id, external_thread_id, state
      FROM channel_binding
      WHERE io_thread_id = ? AND source = ?
      ORDER BY state = 'active' DESC, id DESC
      LIMIT 1
    `).get(thread.id, identity.source) as ChannelBindingRow | undefined
    if (existing) {
      if (existing.state === 'active'
        && existing.scope_id === identity.scopeId
        && existing.external_thread_id === identity.externalThreadId) {
        this.touch(thread.id)
        return
      }
      throw new Error('thread source already bound')
    }
    this.insertChannelBinding(thread.id, identity)
    this.touch(thread.id)
    this.events.emit('changed')
  }

  bindAgentThread(ioThreadId: string, agentType: string, agentScope: string, agentThreadId: string): void {
    const thread = this.ensure(ioThreadId)
    const type = normalizeRequired(agentType, 'agent type')
    const scope = normalizeRequired(agentScope, 'agent scope')
    const externalId = normalizeRequired(agentThreadId, 'agent thread id')
    const owner = this.requireDatabase().prepare(`
      SELECT io_thread_id
      FROM agent_binding
      WHERE agent_type = ? AND agent_scope = ? AND agent_thread_id = ?
    `).get(type, scope, externalId) as { io_thread_id: string } | undefined
    if (owner && owner.io_thread_id !== thread.id) {
      throw new Error('agent thread already bound')
    }
    const existing = this.requireDatabase().prepare(`
      SELECT agent_thread_id
      FROM agent_binding
      WHERE io_thread_id = ? AND agent_type = ? AND agent_scope = ?
    `).get(thread.id, type, scope) as { agent_thread_id: string } | undefined
    if (existing) {
      if (existing.agent_thread_id === externalId) {
        return
      }
      throw new Error('IO thread already bound to another agent thread')
    }
    const now = Date.now()
    this.requireDatabase().prepare(`
      INSERT INTO agent_binding (
        io_thread_id,
        agent_type,
        agent_scope,
        agent_thread_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(thread.id, type, scope, externalId, now, now)
  }

  getAgentThreadId(ioThreadId: string, agentType: string, agentScope: string): string | undefined {
    const row = this.requireDatabase().prepare(`
      SELECT agent_thread_id
      FROM agent_binding
      WHERE io_thread_id = ? AND agent_type = ? AND agent_scope = ?
    `).get(ioThreadId.trim(), agentType.trim(), agentScope.trim()) as { agent_thread_id: string } | undefined
    return row?.agent_thread_id
  }

  getIoThreadIdByAgentThread(agentType: string, agentScope: string, agentThreadId: string): string | undefined {
    const row = this.requireDatabase().prepare(`
      SELECT io_thread_id
      FROM agent_binding
      WHERE agent_type = ? AND agent_scope = ? AND agent_thread_id = ?
    `).get(agentType.trim(), agentScope.trim(), agentThreadId.trim()) as { io_thread_id: string } | undefined
    return row?.io_thread_id
  }

  reconcileFeishuChat(chatId: string): void {
    const normalizedChatId = chatId.trim()
    const now = Date.now()
    const result = this.requireDatabase().prepare(`
      UPDATE channel_binding
      SET state = 'retired', retired_at = ?
      WHERE source = 'feishu' AND state = 'active' AND scope_id <> ?
    `).run(now, normalizedChatId)
    if (result.changes > 0) {
      this.events.emit('changed')
      Logger.info('thread registry retired Feishu bindings', {
        currentChatId: normalizedChatId,
        retired: result.changes
      })
    }
  }

  getFeishuRoute(ioThreadId: string, currentChatId: string): FeishuRoute {
    const rows = this.requireDatabase().prepare(`
      SELECT source, scope_id, external_thread_id, state
      FROM channel_binding
      WHERE io_thread_id = ? AND source = 'feishu'
      ORDER BY state = 'active' DESC, id DESC
    `).all(ioThreadId.trim()) as unknown as ChannelBindingRow[]
    if (rows.length === 0) {
      return { state: 'unbound' }
    }
    const active = rows.find((row) => row.state === 'active' && row.scope_id === currentChatId.trim())
    if (!active) {
      return { state: 'retired' }
    }
    return active.external_thread_id === 'chat'
      ? { state: 'active' }
      : { state: 'active', threadId: active.external_thread_id }
  }

  private setFirstMessage(threadId: string, name: string): MessageThread {
    const thread = this.ensure(threadId)
    const normalizedName = normalizeThreadName(name)
    const now = Date.now()
    const result = this.requireDatabase().prepare(`
      UPDATE conversation
      SET name = ?, updated_at = ?, title_initialized = 1
      WHERE io_thread_id = ? AND title_initialized = 0
    `).run(normalizedName, now, thread.id)
    if (!result.changes) return thread
    const value = { id: thread.id, name: normalizedName }
    this.events.emit('renamed', value)
    this.events.emit('changed')
    return value
  }

  async flush(): Promise<void> {
    this.requireDatabase().exec('PRAGMA wal_checkpoint(FULL)')
  }

  private ensureDatabase(): void {
    if (this.database) {
      return
    }
    mkdirSync(dirname(this.statePath), { recursive: true })
    const database = new DatabaseSync(this.statePath)
    try {
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA synchronous = FULL')
      database.exec('PRAGMA foreign_keys = ON')
      database.exec('PRAGMA busy_timeout = 5000')
      const version = database.prepare('PRAGMA user_version').get() as { user_version: number }
      if (version.user_version > schemaVersion) {
        throw new Error(`thread identity schema ${version.user_version} is newer than supported ${schemaVersion}`)
      }
      if (version.user_version === 0) {
        database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE conversation (
          io_thread_id TEXT PRIMARY KEY,
          web_thread_id TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_active_at INTEGER NOT NULL
        );
        CREATE TABLE channel_binding (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          io_thread_id TEXT NOT NULL REFERENCES conversation(io_thread_id) ON DELETE CASCADE,
          source TEXT NOT NULL CHECK (source IN ('feishu', 'email', 'userver')),
          scope_id TEXT NOT NULL,
          external_thread_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
          created_at INTEGER NOT NULL,
          retired_at INTEGER,
          UNIQUE(source, scope_id, external_thread_id)
        );
        CREATE UNIQUE INDEX channel_binding_active_source
          ON channel_binding(io_thread_id, source)
          WHERE state = 'active';
        CREATE TABLE agent_binding (
          io_thread_id TEXT NOT NULL REFERENCES conversation(io_thread_id) ON DELETE CASCADE,
          agent_type TEXT NOT NULL,
          agent_scope TEXT NOT NULL,
          agent_thread_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(io_thread_id, agent_type, agent_scope),
          UNIQUE(agent_type, agent_scope, agent_thread_id)
        );
        PRAGMA user_version = 1;
        COMMIT;
      `)
      }
      if (version.user_version === 1) {
        database.exec(`
          BEGIN IMMEDIATE;
          DROP INDEX channel_binding_active_source;
          ALTER TABLE channel_binding RENAME TO old_channel_binding;
          CREATE TABLE channel_binding (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            io_thread_id TEXT NOT NULL REFERENCES conversation(io_thread_id) ON DELETE CASCADE,
            source TEXT NOT NULL CHECK (source IN ('feishu', 'email', 'userver')),
            scope_id TEXT NOT NULL, external_thread_id TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
            created_at INTEGER NOT NULL, retired_at INTEGER,
            UNIQUE(source, scope_id, external_thread_id)
          );
          INSERT INTO channel_binding SELECT * FROM old_channel_binding WHERE source IN ('feishu', 'email');
          DROP TABLE old_channel_binding;
          CREATE UNIQUE INDEX channel_binding_active_source ON channel_binding(io_thread_id, source) WHERE state='active';
          PRAGMA user_version = 2;
          COMMIT;
        `)
      }
      if (version.user_version < 3) {
        database.exec(`
          BEGIN IMMEDIATE;
          ALTER TABLE conversation ADD COLUMN title_initialized INTEGER NOT NULL DEFAULT 0;
          UPDATE conversation SET title_initialized=1 WHERE name <> '新对话';
          PRAGMA user_version=3;
          COMMIT;
        `)
      }
      database.exec('CREATE TABLE IF NOT EXISTS thread_checkpoint (subscription TEXT PRIMARY KEY, cursor INTEGER NOT NULL)')
      this.database = database
      this.selectConversationById = database.prepare('SELECT * FROM conversation WHERE io_thread_id = ?')
      this.selectConversationByWebId = database.prepare('SELECT * FROM conversation WHERE web_thread_id = ?')
      this.selectConversationByChannel = database.prepare(`
      SELECT conversation.*
      FROM channel_binding
      INNER JOIN conversation ON conversation.io_thread_id = channel_binding.io_thread_id
      WHERE channel_binding.source = ?
        AND channel_binding.scope_id = ?
        AND channel_binding.external_thread_id = ?
        AND channel_binding.state = 'active'
    `)
    } catch (error) {
      database.close()
      throw error
    }
  }

  checkpoint(subscription: string): { load(): number; save(cursor: number): void } {
    return {
      load: () => (this.requireDatabase().prepare('SELECT cursor FROM thread_checkpoint WHERE subscription=?').get(subscription) as { cursor: number } | undefined)?.cursor ?? 0,
      save: cursor => { this.requireDatabase().prepare('INSERT INTO thread_checkpoint(subscription, cursor) VALUES (?, ?) ON CONFLICT(subscription) DO UPDATE SET cursor=excluded.cursor').run(subscription, cursor) }
    }
  }

  private requireDatabase(): DatabaseSync {
    this.ensureDatabase()
    return this.database as DatabaseSync
  }

  private findById(id: string): ConversationRow | undefined {
    this.ensureDatabase()
    return this.selectConversationById?.get(id) as ConversationRow | undefined
  }

  private findByChannel(identity: NormalizedChannelIdentity): ConversationRow | undefined {
    this.ensureDatabase()
    if (identity.source === 'web') {
      return this.selectConversationByWebId?.get(identity.externalThreadId) as ConversationRow | undefined
    }
    return this.selectConversationByChannel?.get(
      identity.source,
      identity.scopeId,
      identity.externalThreadId
    ) as ConversationRow | undefined
  }

  private requireThread(id: string): MessageThread {
    const thread = this.get(id)
    if (!thread) {
      throw new Error(`thread not found: ${id}`)
    }
    return thread
  }

  private bindWebThread(ioThreadId: string, webThreadId: string): void {
    const row = this.findById(ioThreadId)
    if (!row) {
      throw new Error(`thread not found: ${ioThreadId}`)
    }
    if (row.web_thread_id === webThreadId) {
      this.touch(ioThreadId)
      return
    }
    const owner = this.selectConversationByWebId?.get(webThreadId) as ConversationRow | undefined
    if (owner && owner.io_thread_id !== ioThreadId) {
      throw new Error('thread key already bound')
    }
    this.requireDatabase().prepare(`
      UPDATE conversation
      SET web_thread_id = ?, updated_at = ?, last_active_at = ?
      WHERE io_thread_id = ?
    `).run(webThreadId, Date.now(), Date.now(), ioThreadId)
    this.events.emit('changed')
  }

  private insertChannelBinding(ioThreadId: string, identity: NormalizedChannelIdentity): void {
    if (identity.source === 'web') {
      throw new Error('web identity belongs to conversation')
    }
    this.requireDatabase().prepare(`
      INSERT INTO channel_binding (
        io_thread_id,
        source,
        scope_id,
        external_thread_id,
        state,
        created_at
      ) VALUES (?, ?, ?, ?, 'active', ?)
    `).run(ioThreadId, identity.source, identity.scopeId, identity.externalThreadId, Date.now())
  }

  private touch(ioThreadId: string): void {
    const now = Date.now()
    this.requireDatabase().prepare(`
      UPDATE conversation
      SET updated_at = ?, last_active_at = ?
      WHERE io_thread_id = ?
    `).run(now, now, ioThreadId)
    this.events.emit('changed')
  }

  private transaction<T>(operation: () => T): T {
    const database = this.requireDatabase()
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
}

export function normalizeThreadName(value?: string): string {
  const normalized = value?.replace(/\s+/g, ' ').trim() ?? ''
  return normalized ? Array.from(normalized).slice(0, 12).join('') : '新对话'
}

function normalizeChannelIdentity(value: ChannelThreadId): NormalizedChannelIdentity {
  const id = normalizeRequired(value.id, 'thread key')
  if (value.source === 'feishu') {
    const marker = ':thread:'
    const index = id.indexOf(marker)
    if (index > 0 && index + marker.length < id.length) {
      return {
        source: value.source,
        scopeId: id.slice(0, index),
        externalThreadId: id.slice(index + marker.length)
      }
    }
    const chatSuffix = ':chat'
    if (id.endsWith(chatSuffix) && id.length > chatSuffix.length) {
      return {
        source: value.source,
        scopeId: id.slice(0, -chatSuffix.length),
        externalThreadId: 'chat'
      }
    }
    throw new Error('invalid Feishu thread identity')
  }
  return {
    source: value.source,
    scopeId: '',
    externalThreadId: id
  }
}

function toChannelThreadId(row: ChannelBindingRow): ChannelThreadId {
  if (row.source === 'feishu') {
    return {
      source: row.source,
      id: row.external_thread_id === 'chat'
        ? `${row.scope_id}:chat`
        : `${row.scope_id}:thread:${row.external_thread_id}`
    }
  }
  return {
    source: row.source,
    id: row.external_thread_id
  }
}

function normalizeRequired(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`${label} is required`)
  }
  return normalized
}

function toMessageThread(row: ConversationRow): MessageThread {
  return {
    id: row.io_thread_id,
    name: row.name
  }
}
