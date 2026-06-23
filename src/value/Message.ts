export type MessageFile = {
  id: string
  mime: string
  name: string
  size: number
  sha256: string
  path: string
  url?: string
}

export type MessageRole = 'user' | 'agent' | 'system'

export const allIoThreadId = 'io_all'

export type Message = {
  role: MessageRole
  ioThreadId: string
  text: string
  createdAt: number
  source?: string
  files?: MessageFile[]
}
