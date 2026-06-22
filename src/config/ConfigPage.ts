export const configPageHtml = String.raw`
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codexio Config</title>
  <script src="https://unpkg.com/@tailwindcss/browser@4"></script>
</head>
<body class="min-h-screen bg-slate-950 text-slate-100">
  <main class="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-5 py-6">
    <header class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
      <div>
        <h1 class="text-xl font-semibold">Codexio Config</h1>
        <p class="mt-1 text-sm text-slate-400">配置保存后会直接写入 config.yaml，并立即应用可热更新的部分。</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <input id="importFile" type="file" accept=".yaml,.yml,text/yaml,text/plain" class="hidden">
        <button id="importConfig" type="button" class="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-900">导入配置</button>
        <button id="exportConfig" type="button" class="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-900">导出配置</button>
        <a href="/" class="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-900">返回会话</a>
      </div>
    </header>
    <section id="status" class="hidden rounded-md border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-slate-300"></section>
    <form id="form" class="grid gap-5"></form>
    <footer class="sticky bottom-0 -mx-5 border-t border-slate-800 bg-slate-950/95 px-5 py-4 backdrop-blur">
      <div class="mx-auto flex max-w-6xl items-center justify-between gap-3">
        <span id="dirty" class="text-sm text-slate-500">没有未保存修改</span>
        <button id="save" type="button" class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40" disabled>保存</button>
      </div>
    </footer>
  </main>
  <script>
    const form = document.getElementById('form')
    const save = document.getElementById('save')
    const dirty = document.getElementById('dirty')
    const status = document.getElementById('status')
    const importConfig = document.getElementById('importConfig')
    const exportConfig = document.getElementById('exportConfig')
    const importFile = document.getElementById('importFile')
    let config = {}
    let descriptors = []
    let actions = []
    let values = {}

    const getValue = (object, path) => path.split('.').reduce((current, key) => current == null ? undefined : current[key], object)
    const setValue = (object, path, value) => {
      const keys = path.split('.')
      let current = object
      for (const key of keys.slice(0, -1)) {
        current[key] = current[key] && typeof current[key] === 'object' ? current[key] : {}
        current = current[key]
      }
      current[keys[keys.length - 1]] = value
    }
    const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right)
    const showStatus = (message, tone = 'info') => {
      status.className = 'rounded-md border px-4 py-3 text-sm ' + (tone === 'error' ? 'border-red-900 bg-red-950 text-red-200' : 'border-slate-800 bg-slate-900 text-slate-300')
      status.textContent = message
    }
    const markDirty = () => {
      const changed = descriptors.some((field) => !sameValue(values[field.path], getValue(config, field.path)))
      save.disabled = !changed
      dirty.textContent = changed ? '有未保存修改' : '没有未保存修改'
    }
    const inputValue = (input, type) => {
      if (type === 'boolean') {
        return input.checked
      }
      if (type === 'number') {
        return Number(input.value)
      }
      return input.value
    }
    const render = () => {
      form.innerHTML = ''
      const groups = [...new Set(descriptors.map((item) => item.group))]
      for (const group of groups) {
        const section = document.createElement('section')
        section.className = 'rounded-lg border border-slate-800 bg-slate-900/60 p-4'
        section.innerHTML = '<div class="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 class="text-base font-medium text-slate-100"></h2><div data-actions class="flex flex-wrap items-center gap-2"></div></div><div data-fields class="grid gap-4 md:grid-cols-2"></div>'
        section.querySelector('h2').textContent = group
        const actionHost = section.querySelector('[data-actions]')
        for (const action of actions.filter((item) => item.group === group)) {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'rounded-md border border-blue-500/70 px-3 py-2 text-sm text-blue-100 hover:bg-blue-950 disabled:cursor-not-allowed disabled:opacity-50'
          button.textContent = action.label
          button.addEventListener('click', async () => {
            button.disabled = true
            const response = await fetch('/api/config/actions/' + encodeURIComponent(action.id), {
              method: 'POST'
            })
            const result = await response.json()
            button.disabled = false
            if (result.isFailed) {
              showStatus(result.message, 'error')
              return
            }
            showStatus(result.data && result.data.message ? result.data.message : result.message)
          })
          actionHost.append(button)
        }
        const grid = section.querySelector('[data-fields]')
        for (const field of descriptors.filter((item) => item.group === group)) {
          const row = document.createElement('label')
          row.className = 'grid gap-2'
          const label = document.createElement('span')
          label.className = 'text-sm text-slate-300'
          label.textContent = field.label
          const input = document.createElement('input')
          input.dataset.path = field.path
          input.className = 'rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500'
          input.type = field.type === 'password' ? 'password' : field.type === 'boolean' ? 'checkbox' : field.type === 'number' ? 'number' : 'text'
          const value = getValue(config, field.path)
          values[field.path] = value
          if (field.type === 'boolean') {
            input.checked = Boolean(value)
            input.className = 'h-5 w-5 accent-blue-600'
          } else {
            input.value = value ?? ''
          }
          input.addEventListener('input', () => {
            values[field.path] = inputValue(input, field.type)
            markDirty()
          })
          input.addEventListener('change', () => {
            values[field.path] = inputValue(input, field.type)
            markDirty()
          })
          row.append(label, input)
          grid.append(row)
        }
        form.append(section)
      }
      markDirty()
    }
    const load = async () => {
      const response = await fetch('/api/config')
      const result = await response.json()
      if (result.isFailed) {
        showStatus(result.message, 'error')
        return
      }
      config = result.data.config
      descriptors = result.data.descriptor
      actions = result.data.actions || []
      render()
    }
    save.addEventListener('click', async () => {
      const patch = {}
      for (const field of descriptors) {
        const current = values[field.path]
        if (!sameValue(current, getValue(config, field.path))) {
          setValue(patch, field.path, current)
        }
      }
      save.disabled = true
      const response = await fetch('/api/config', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ patch })
      })
      const result = await response.json()
      if (result.isFailed) {
        showStatus(result.message, 'error')
        markDirty()
        return
      }
      config = result.data.config
      showStatus(result.data.message)
      render()
    })
    exportConfig.addEventListener('click', () => {
      window.location.href = '/api/config/export'
    })
    importConfig.addEventListener('click', () => {
      importFile.value = ''
      importFile.click()
    })
    importFile.addEventListener('change', async () => {
      const file = importFile.files && importFile.files[0]
      if (!file) {
        return
      }
      const text = await file.text()
      const response = await fetch('/api/config/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ text })
      })
      const result = await response.json()
      if (result.isFailed) {
        showStatus(result.message, 'error')
        return
      }
      config = result.data.config
      showStatus(result.data.message)
      render()
    })
    void load()
  </script>
</body>
</html>
`
