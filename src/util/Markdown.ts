import { marked } from 'marked'
import sanitizeHtml from 'sanitize-html'

type MarkdownFileReference = {
  label: string
  path: string
}

export type MarkdownAttachmentReference = MarkdownFileReference & {
  image: boolean
}

type MarkdownFileReferenceParseResult = {
  text: string
  files: MarkdownFileReference[]
}

export type MarkdownAttachmentReferenceParseResult = {
  text: string
  files: MarkdownAttachmentReference[]
}

export function renderMarkdownHtml(markdown: string): string {
  const raw = marked.parse(markdown, {
    async: false,
    breaks: true,
    gfm: true
  }) as string
  return sanitizeHtml(raw.replace(/\r?\n$/, ''), {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'h1',
      'h2',
      'h3',
      'pre',
      'code',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td'
    ],
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      code: [
        'class'
      ]
    }
  })
}

export function shouldRenderMarkdown(text: string): boolean {
  return [
    '**',
    '__',
    '`',
    '# ',
    '## ',
    '- ',
    '* ',
    '1. ',
    '[',
    '|',
    '>'
  ].some((marker) => text.includes(marker))
}

function parseMarkdownFileReferences(markdown: string): MarkdownFileReferenceParseResult {
  const result = parseMarkdownAttachmentReferences(markdown)
  return {
    text: result.text,
    files: result.files.filter((file) => !file.image).map((file) => ({
      label: file.label,
      path: file.path
    }))
  }
}

export function parseMarkdownAttachmentReferences(markdown: string): MarkdownAttachmentReferenceParseResult {
  const files: MarkdownAttachmentReference[] = []
  const parts: string[] = []
  let lastIndex = 0
  let index = 0
  while (index < markdown.length) {
    const match = readMarkdownLink(markdown, index)
    if (!match) {
      index += 1
      continue
    }
    index = match.end
    const path = normalizeMarkdownLinkTarget(match.target)
    if (!isFileReferencePath(path)) {
      continue
    }
    parts.push(markdown.slice(lastIndex, match.start))
    parts.push(formatInlineCode(path))
    files.push({
      label: match.label.trim(),
      path,
      image: match.image
    })
    lastIndex = match.end
  }
  parts.push(markdown.slice(lastIndex))
  return {
    text: cleanMarkdownReferenceText(parts.join('')),
    files
  }
}

function readMarkdownLink(text: string, start: number): { start: number, end: number, label: string, target: string, image: boolean } | undefined {
  let image = false
  let linkStart = start
  if (text[start] === '!' && text[start + 1] === '[') {
    image = true
    linkStart = start + 1
  }
  if (text[linkStart] !== '[' || (!image && text[linkStart - 1] === '!')) {
    return undefined
  }
  const labelEnd = text.indexOf(']', linkStart + 1)
  if (labelEnd < 0 || text[labelEnd + 1] !== '(') {
    return undefined
  }
  const targetStart = labelEnd + 2
  let index = targetStart
  while (index < text.length) {
    const current = text[index]
    if (current === '\r' || current === '\n') {
      return undefined
    }
    if (current === ')' && isMarkdownLinkTargetEnd(text, index)) {
      return {
        start,
        end: index + 1,
        label: text.slice(linkStart + 1, labelEnd),
        target: text.slice(targetStart, index),
        image
      }
    }
    index += 1
  }
  return undefined
}

function isMarkdownLinkTargetEnd(text: string, index: number): boolean {
  const next = text[index + 1]
  return next === undefined || /\s|[，。！？,.!?:;；、]/.test(next)
}

function normalizeMarkdownLinkTarget(target: string): string {
  let value = target.trim()
  const titleIndex = value.search(/\s+"/)
  if (titleIndex > 0) {
    value = value.slice(0, titleIndex).trim()
  }
  if (value.startsWith('<') && value.endsWith('>')) {
    value = value.slice(1, -1).trim()
  }
  try {
    return decodeURI(value)
  } catch {
    return value
  }
}

function isFileReferencePath(path: string): boolean {
  return /^https?:\/\//i.test(path)
    || path.startsWith('/api/files/')
    || /^[A-Za-z]:[\\/]/.test(path)
    || path.startsWith('/')
    || path.startsWith('./')
    || path.startsWith('../')
}

function cleanMarkdownReferenceText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function formatInlineCode(text: string): string {
  return `\`${text.replaceAll('`', '\\`')}\``
}
