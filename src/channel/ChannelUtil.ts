import { ChannelMessage } from './Channel.js'
import { formatTextWithRoleSuffix, normalizeChannelMessageText, roleSuffix } from './ChannelMessageFormat.js'

export type EmailMessagePayload = {
  subject: string
  text: string
}

export type EmailAddress = {
  name?: string
  address: string
}

export type FeishuMessagePayload = {
  msgType: string
  content: string
}

export function createEmailSender(from: string | undefined, user: string | undefined): string | EmailAddress | undefined {
  const trimmedFrom = from?.trim()
  const trimmedUser = user?.trim()
  if (trimmedFrom && trimmedFrom.includes('@')) {
    return trimmedFrom
  }
  if (trimmedFrom && trimmedUser && trimmedUser.includes('@')) {
    return {
      name: trimmedFrom,
      address: trimmedUser
    }
  }
  if (trimmedUser) {
    return trimmedUser
  }
  return trimmedFrom
}

export function isAllowedEmailSender(from: string[], user: string | undefined): boolean {
  const trimmedUser = user?.trim().toLowerCase()
  if (!trimmedUser) {
    return false
  }
  return from.some((item) => item.trim().toLowerCase() === trimmedUser)
}

export function createEmailMessagePayload(message: ChannelMessage): EmailMessagePayload {
  const text = formatTextWithRoleSuffix(message)
  if (message.role === 'agent') {
    return {
      subject: 'Agent',
      text
    }
  }
  if (message.role === 'user') {
    return {
      subject: 'User',
      text
    }
  }
  return {
    subject: 'System',
    text
  }
}

export function createFeishuMessagePayload(message: ChannelMessage): FeishuMessagePayload {
  const text = normalizeChannelMessageText(message)
  const content: Array<Array<Record<string, string>>> = [
    [
      {
        tag: 'md',
        text
      }
    ]
  ]
  const suffix = roleSuffix(message)
  if (suffix) {
    content.push([
      {
        tag: 'text',
        text: suffix
      }
    ])
  }
  return {
    msgType: 'post',
    content: JSON.stringify({
      zh_cn: {
        content
      }
    })
  }
}

export function createFeishuWebhookText(message: ChannelMessage): string {
  return formatTextWithRoleSuffix(message)
}
