export function renderConfigTemplate(template: string, config: unknown): string {
  return template.replace(/\$\{([A-Za-z0-9_.]+)\}/g, (reference, path: string) => {
    const value = path.split('.').reduce<unknown>((current, key) => {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        return undefined
      }
      return (current as Record<string, unknown>)[key]
    }, config)
    return value === undefined ? reference : String(value)
  })
}
