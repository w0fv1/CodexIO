import { createHash } from 'node:crypto'

export type MessageFile = {
  id: string
  mime: string
  name: string
  size: number
  sha256: string
  path: string
  url?: string
}

export type MessageRole = 'user' | 'system' | 'agent'

export type MessageStatus = 'streaming' | 'completed'

export type MessageRevision = string

export type MessageThread = {
  id: string
  name: string
}

export type MessageContent = {
  status: MessageStatus
  role: MessageRole
  text: string
  files?: MessageFile[]
}

export type Message = MessageContent & {
  id: string
  revision: MessageRevision
  occurredAt: number
  sequence: number
  thread: MessageThread
}

export type MessageInput = Omit<Message, 'revision' | 'occurredAt' | 'sequence' | 'status'> & {
  occurredAt?: number
  sequence?: number
  status?: MessageStatus
}

export function createMessage(input: MessageInput): Message {
  const content: MessageContent = {
    status: input.status ?? 'completed',
    role: input.role,
    text: input.text,
    files: input.files
  }
  return {
    id: input.id,
    revision: deriveMessageRevision(content),
    occurredAt: input.occurredAt ?? Date.now(),
    sequence: input.sequence ?? 0,
    thread: input.thread,
    ...content
  }
}

export function deriveMessageId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('base64url')
}

export function deriveMessageRevision(message: MessageContent): MessageRevision {
  const content = {
    status: message.status,
    role: message.role,
    text: message.text,
    files: (message.files ?? []).map((file) => ({
      mime: file.mime,
      name: file.name,
      size: file.size,
      sha256: file.sha256
    }))
  }
  return createHash('sha256').update(JSON.stringify(content)).digest('base64url')
}
