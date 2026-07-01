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

export type Message = {
  role: MessageRole
  ioThreadId: string
  text: string
  files?: MessageFile[]
}
