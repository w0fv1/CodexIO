import { z } from 'zod'

const FeishuTextContentSchema = z.object({
  text: z.string()
})

const FeishuPostElementSchema = z.object({
  tag: z.string()
}).passthrough()

const FeishuPostContentSchema = z.object({
  content: z.array(z.array(FeishuPostElementSchema))
}).passthrough()

const FeishuLocalizedPostContentSchema = z.record(z.string(), FeishuPostContentSchema)

const FeishuResourceContentSchema = z.object({
  image_key: z.string().optional(),
  file_key: z.string().optional(),
  file_name: z.string().optional()
})

export type FeishuMention = {
  key: string
}

export type FeishuChatType = 'p2p' | 'group' | string

export type FeishuMessageTextParseResult =
  | {
    success: true
    text: string
  }
  | {
    success: false
    reason: 'unsupported' | 'invalid' | 'empty'
  }

export type FeishuMessageResource = {
  key: string
  name: string
  type: 'image' | 'file'
}

export type FeishuMessageParseResult =
  | {
    success: true
    text: string
    resources: FeishuMessageResource[]
  }
  | {
    success: false
    reason: 'unsupported' | 'invalid' | 'empty'
  }

export function parseFeishuMessage(messageType: string, content: string, mentions: FeishuMention[] = []): FeishuMessageParseResult {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return {
      success: false,
      reason: 'invalid'
    }
  }
  let text = ''
  const resources: FeishuMessageResource[] = []
  if (messageType === 'text') {
    const parsed = parseTextContent(value)
    if (parsed === undefined) {
      return { success: false, reason: 'invalid' }
    }
    text = parsed
  } else if (messageType === 'post') {
    const parsed = parsePost(value)
    if (!parsed) {
      return { success: false, reason: 'invalid' }
    }
    text = parsed.text
    resources.push(...parsed.resources)
  } else if (['image', 'file', 'audio', 'media'].includes(messageType)) {
    const parsed = FeishuResourceContentSchema.safeParse(value)
    if (!parsed.success) {
      return { success: false, reason: 'invalid' }
    }
    const key = messageType === 'image' ? parsed.data.image_key : parsed.data.file_key
    if (!key) {
      return { success: false, reason: 'invalid' }
    }
    resources.push({
      key,
      name: parsed.data.file_name?.trim() || `${key}${messageType === 'image' ? '.image' : ''}`,
      type: messageType === 'image' ? 'image' : 'file'
    })
  } else {
    return { success: false, reason: 'unsupported' }
  }
  for (const mention of mentions) {
    text = text.replaceAll(mention.key, '')
  }
  text = text.trim()
  if (text.length === 0 && resources.length === 0) {
    return { success: false, reason: 'empty' }
  }
  return {
    success: true,
    text,
    resources
  }
}

export function parseFeishuMessageText(messageType: string, content: string, mentions: FeishuMention[] = []): FeishuMessageTextParseResult {
  const parsed = parseFeishuMessage(messageType, content, mentions)
  if (!parsed.success) {
    return parsed
  }
  if (parsed.text.length === 0) {
    return { success: false, reason: 'empty' }
  }
  return {
    success: true,
    text: parsed.text
  }
}

export function shouldReceiveFeishuMessage(chatType: FeishuChatType | undefined, mentions: FeishuMention[] | undefined, requireAite: boolean): boolean {
  if (!requireAite) {
    return true
  }
  if (chatType === 'p2p') {
    return true
  }
  if (chatType !== 'group') {
    return true
  }
  return Boolean(mentions?.some((mention) => mention.key.trim().length > 0))
}

export function shouldReceiveFeishuSender(openId: string | undefined, allowedOpenIds: string[]): boolean {
  const allowed = new Set(allowedOpenIds.map((item) => item.trim()).filter((item) => item.length > 0))
  if (allowed.size === 0) {
    return true
  }
  return Boolean(openId && allowed.has(openId.trim()))
}

function parseTextContent(value: unknown): string | undefined {
  const content = FeishuTextContentSchema.safeParse(value)
  return content.success ? content.data.text : undefined
}

function parsePostContent(value: unknown): string | undefined {
  return parsePost(value)?.text
}

function parsePost(value: unknown): { text: string, resources: FeishuMessageResource[] } | undefined {
  const direct = FeishuPostContentSchema.safeParse(value)
  if (direct.success) {
    return extractPost(direct.data.content)
  }
  const localized = FeishuLocalizedPostContentSchema.safeParse(value)
  if (!localized.success) {
    return undefined
  }
  const preferred = localized.data.zh_cn ?? localized.data.en_us ?? localized.data.ja_jp ?? Object.values(localized.data)[0]
  return preferred ? extractPost(preferred.content) : undefined
}

function extractPost(content: Array<Array<Record<string, unknown>>>): { text: string, resources: FeishuMessageResource[] } {
  const resources = content.flatMap((line) => line.flatMap((element) => {
    if (element.tag !== 'img' || typeof element.image_key !== 'string') {
      return []
    }
    return [{
      key: element.image_key,
      name: `${element.image_key}.image`,
      type: 'image' as const
    }]
  }))
  return {
    text: content.map((line) => line.map(extractPostElementText).join('')).join('\n'),
    resources
  }
}

function extractPostElementText(element: Record<string, unknown>): string {
  if (element.tag === 'at') {
    return ''
  }
  if (typeof element.text === 'string') {
    return element.text
  }
  return ''
}
