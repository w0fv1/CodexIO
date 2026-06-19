import { marked } from 'marked'
import sanitizeHtml from 'sanitize-html'

export function renderMarkdownHtml(markdown: string): string {
  const raw = marked.parse(markdown, {
    async: false,
    breaks: true,
    gfm: true
  }) as string
  return sanitizeHtml(raw, {
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
