import { ChannelMessage } from './Channel.js'

export function normalizeChannelMessageText(message: ChannelMessage): string {
  if (message.role === 'system' && message.text === 'clear') {
    return '已开始新对话'
  }
  return message.text
}

export function formatTextWithRoleSuffix(message: ChannelMessage): string {
  const text = normalizeChannelMessageText(message)
  if (message.role === 'user') {
    return `${text}\n\nUser`
  }
  if (message.role === 'system') {
    return `${text}\n\nSystem`
  }
  return text
}

export function roleSuffix(message: ChannelMessage): string | undefined {
  if (message.role === 'user') {
    return 'User'
  }
  if (message.role === 'system') {
    return 'System'
  }
  return undefined
}
