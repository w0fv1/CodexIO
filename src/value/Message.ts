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

export type MessageThread = {
  id: string
  name: string
}

export type Message = {
  id: string
  occurredAt: number
  thread: MessageThread
  role: MessageRole
  text: string
  files?: MessageFile[]
}

export type MessageInput = Omit<Message, 'occurredAt'> & {
  occurredAt?: number
}

export function createMessage(input: MessageInput): Message {
  return {
    id: input.id,
    occurredAt: input.occurredAt ?? Date.now(),
    thread: input.thread,
    role: input.role,
    text: input.text,
    files: input.files
  }
}

export function deriveMessageId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('base64url')
}
