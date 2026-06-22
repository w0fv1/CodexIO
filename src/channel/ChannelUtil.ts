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

export type FeishuImage = {
  imageKey: string
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

export function createFeishuMessagePayload(message: ChannelMessage, images: FeishuImage[] = []): FeishuMessagePayload {
  const text = normalizeChannelMessageText({
    ...message,
    files: undefined
  })
  const content: Array<Array<Record<string, string>>> = []
  if (text.trim().length > 0) {
    content.push([
      {
        tag: 'md',
        text
      }
    ])
  }
  for (const image of images) {
    content.push([
      {
        tag: 'img',
        image_key: image.imageKey
      }
    ])
  }
  const suffix = roleSuffix(message)
  if (suffix && content.length > 0) {
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
  let text = message.text
  if (text.trim().length === 0 && message.files && message.files.length > 0) {
    text = `已收到文件：${message.files.map((file) => file.name).join('、')}`
  }
  return formatTextWithRoleSuffix({
    ...message,
    text,
    files: undefined
  })
}
