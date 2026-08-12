export function isCodexAuthenticationInvalidated(error: unknown): boolean {
  const values = collectValues(error).join('\n').toLowerCase()
  return [
    'refresh_token_invalidated',
    'token_invalidated',
    'refresh token was revoked',
    'authentication token has been invalidated',
    'session has ended',
    'please log out and sign in again',
    'please try signing in again'
  ].some((value) => values.includes(value))
}

function collectValues(value: unknown): string[] {
  if (!value) {
    return []
  }
  if (typeof value === 'string') {
    return [value]
  }
  if (value instanceof Error) {
    return [
      value.name,
      value.message,
      value.stack ?? ''
    ].filter((item) => item.length > 0)
  }
  if (typeof value !== 'object') {
    return [String(value)]
  }
  return Object.values(value as Record<string, unknown>).flatMap((item) => collectValues(item))
}
