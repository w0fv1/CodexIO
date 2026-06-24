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

export type FeishuMention = {
  key: string
}

export type FeishuMessageTextParseResult =
  | {
    success: true
    text: string
  }
  | {
    success: false
    reason: 'unsupported' | 'invalid' | 'empty'
  }

export function parseFeishuMessageText(messageType: string, content: string, mentions: FeishuMention[] = []): FeishuMessageTextParseResult {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return {
      success: false,
      reason: 'invalid'
    }
  }
  const parsedText = messageType === 'text' ? parseTextContent(value) : messageType === 'post' ? parsePostContent(value) : undefined
  if (parsedText === undefined) {
    return {
      success: false,
      reason: messageType === 'text' || messageType === 'post' ? 'invalid' : 'unsupported'
    }
  }
  let text = parsedText
  for (const mention of mentions) {
    text = text.replaceAll(mention.key, '')
  }
  text = text.trim()
  if (text.length === 0) {
    return {
      success: false,
      reason: 'empty'
    }
  }
  return {
    success: true,
    text
  }
}

function parseTextContent(value: unknown): string | undefined {
  const content = FeishuTextContentSchema.safeParse(value)
  return content.success ? content.data.text : undefined
}

function parsePostContent(value: unknown): string | undefined {
  const direct = FeishuPostContentSchema.safeParse(value)
  if (direct.success) {
    return extractPostText(direct.data.content)
  }
  const localized = FeishuLocalizedPostContentSchema.safeParse(value)
  if (!localized.success) {
    return undefined
  }
  const preferred = localized.data.zh_cn ?? localized.data.en_us ?? localized.data.ja_jp ?? Object.values(localized.data)[0]
  return preferred ? extractPostText(preferred.content) : undefined
}

function extractPostText(content: Array<Array<Record<string, unknown>>>): string {
  return content.map((line) => line.map(extractPostElementText).join('')).join('\n')
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
