import { marked } from 'marked'
import sanitizeHtml from 'sanitize-html'

export function renderMarkdownHtml(markdown: string): string {
  const html = marked.parse(markdown, {
    async: false,
    gfm: true,
    breaks: true
  })
  return sanitizeHtml(html, {
    allowedTags: [
      'a',
      'blockquote',
      'br',
      'code',
      'del',
      'em',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'hr',
      'li',
      'ol',
      'p',
      'pre',
      'strong',
      'table',
      'tbody',
      'td',
      'th',
      'thead',
      'tr',
      'ul'
    ],
    allowedAttributes: {
      a: [
        'href',
        'title'
      ]
    },
    allowedSchemes: [
      'http',
      'https',
      'mailto'
    ]
  })
}

export function shouldRenderMarkdown(text: string): boolean {
  return /[*_`#>\-]|\n|https?:\/\/|\|/.test(text)
}
