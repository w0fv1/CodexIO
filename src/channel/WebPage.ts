export const webPageHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="icon" href="data:,">
  <title>Codexio</title>
  <script src="https://unpkg.com/@tailwindcss/browser@4"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <style>
    [x-cloak]{display:none!important}
    .thin-scrollbar{scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.68) transparent}
    .thin-scrollbar::-webkit-scrollbar{width:8px;height:8px}
    .thin-scrollbar::-webkit-scrollbar-track{background:transparent}
    .thin-scrollbar::-webkit-scrollbar-thumb{background:rgba(148,163,184,.58);border:2px solid transparent;border-radius:999px;background-clip:content-box}
    .thin-scrollbar::-webkit-scrollbar-thumb:hover{background:rgba(100,116,139,.76);border:2px solid transparent;background-clip:content-box}
    .theme-light{background:#f1f5f9;color:#020617}
    .theme-dark{background:#020617;color:#e2e8f0}
    .app-header{border-color:#e2e8f0;background:rgba(255,255,255,.9)}
    .theme-dark .app-header{border-color:#1e293b;background:rgba(2,6,23,.88)}
    .app-mark{background:#020617;color:#fff}
    .theme-dark .app-mark{background:#f8fafc;color:#020617}
    .app-title{color:#020617}
    .theme-dark .app-title{color:#f8fafc}
    .header-button{cursor:pointer;border-color:#e2e8f0;color:#334155;background:transparent}
    .header-button:hover{background:#f8fafc}
    .theme-dark .header-button{border-color:#334155;color:#cbd5e1}
    .theme-dark .header-button:hover{background:#0f172a}
    .empty-state{color:#94a3b8}
    .theme-dark .empty-state{color:#64748b}
    .user-bubble{background:#2563eb;color:#fff}
    .theme-dark .user-bubble{background:#2563eb;color:#fff}
    .agent-bubble{border-color:#e2e8f0;background:#fff;color:#0f172a}
    .theme-dark .agent-bubble{border-color:#1e293b;background:#0f172a;color:#e2e8f0}
    .message-actions{opacity:0;transition:opacity 140ms ease}
    .message-row:hover .message-actions,.message-row:focus-within .message-actions{opacity:1}
    .message-image{max-width:min(320px,100%);max-height:320px;border-radius:10px;object-fit:contain}
    .tool-button{display:grid;cursor:pointer;place-items:center;width:32px;height:32px;border:1px solid #e2e8f0;border-radius:10px;background:rgba(255,255,255,.8);color:#64748b;box-shadow:0 1px 2px rgba(15,23,42,.06);transition:background-color 140ms ease,border-color 140ms ease,color 140ms ease,transform 120ms ease}
    .tool-button:hover{background:#fff;border-color:#cbd5e1;color:#0f172a}
    .tool-button:active{transform:translateY(1px)}
    .theme-dark .tool-button{border-color:#334155;background:rgba(15,23,42,.8);color:#94a3b8;box-shadow:none}
    .theme-dark .tool-button:hover{background:#1e293b;border-color:#475569;color:#f8fafc}
    .app-footer{background:#f1f5f9}
    .theme-dark .app-footer{background:#020617}
    .composer-card{border-color:#cbd5e1;background:#fff;box-shadow:0 10px 18px rgba(148,163,184,.34)}
    .composer-card.drag-active{border-color:#2563eb;box-shadow:0 0 0 4px rgba(37,99,235,.1),0 10px 18px rgba(148,163,184,.34)}
    .theme-dark .composer-card{border-color:#334155;background:#0f172a;box-shadow:0 14px 26px rgba(0,0,0,.32)}
    .theme-dark .composer-card.drag-active{border-color:#3b82f6;box-shadow:0 0 0 4px rgba(59,130,246,.18),0 14px 26px rgba(0,0,0,.32)}
    .composer-input{color:#020617}
    .theme-dark .composer-input{color:#f8fafc}
    .composer-input::placeholder{color:#94a3b8}
    .theme-dark .composer-input::placeholder{color:#64748b}
    .send-button{cursor:pointer;background:#020617;color:#fff}
    .send-button:hover:not(:disabled){background:#1e293b}
    .send-button:disabled{cursor:not-allowed;background:#cbd5e1;color:#64748b}
    .theme-dark .send-button{background:#f8fafc;color:#020617}
    .theme-dark .send-button:hover:not(:disabled){background:#e2e8f0}
    .theme-dark .send-button:disabled{background:#334155;color:#94a3b8}
    .jump-button{cursor:pointer;border-color:#e2e8f0;background:#fff;color:#475569}
    .jump-button:hover{background:#f8fafc}
    .theme-dark .jump-button{border-color:#334155;background:#0f172a;color:#cbd5e1}
    .theme-dark .jump-button:hover{background:#1e293b}
    .markdown-body a{color:#2563eb;text-decoration:underline;text-underline-offset:2px}
    .markdown-body blockquote{margin:12px 0;border-left:3px solid #cbd5e1;padding-left:12px;color:#475569}
    .markdown-body code{border-radius:6px;background:#f1f5f9;padding:2px 6px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:.95em;color:#020617}
    .markdown-body ol{margin:10px 0;padding-left:20px;list-style:decimal}
    .markdown-body p{margin-bottom:12px}
    .markdown-body p:last-child{margin-bottom:0}
    .markdown-body pre{margin:12px 0;overflow:auto;border-radius:8px;background:#0f172a;padding:12px;color:#e2e8f0}
    .markdown-body pre code{background:transparent;padding:0;color:inherit}
    .markdown-body table{margin:12px 0;display:block;width:100%;border-collapse:collapse;overflow:auto}
    .markdown-body td,.markdown-body th{border:1px solid #e2e8f0;padding:6px 8px;text-align:left}
    .markdown-body ul{margin:10px 0;padding-left:20px;list-style:disc}
    .theme-dark .markdown-body a{color:#60a5fa}
    .theme-dark .markdown-body blockquote{border-color:#475569;color:#94a3b8}
    .theme-dark .markdown-body code{background:#1e293b;color:#f8fafc}
    .theme-dark .markdown-body pre code{background:transparent;padding:0;color:inherit}
    .theme-dark .markdown-body td,.theme-dark .markdown-body th{border-color:#334155}
    @media (hover:none){.message-actions{opacity:1}}
  </style>
</head>
<body class="h-screen overflow-hidden bg-slate-100 text-slate-950 antialiased">
  <main
    id="chat"
    class="grid h-screen grid-rows-[auto_minmax(0,1fr)_auto]"
    :class="theme === 'dark' ? 'theme-dark' : 'theme-light'"
    x-data="codexioChat()"
    x-init="init()"
  >
    <header class="app-header border-b px-4 py-3 backdrop-blur sm:px-6">
      <div class="mx-auto flex max-w-5xl items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-3">
          <span class="app-mark grid size-8 shrink-0 place-items-center rounded-lg text-sm font-black">C</span>
          <span class="app-title truncate text-base font-semibold tracking-normal">Codexio</span>
        </div>
        <div class="flex shrink-0 items-center gap-2 text-xs">
          <span
            class="size-2 rounded-full"
            :class="connected ? 'bg-emerald-500' : 'bg-rose-500'"
            aria-hidden="true"
          ></span>
          <a
            href="/config"
            class="header-button grid size-8 place-items-center rounded-md border transition"
            aria-label="打开配置"
            title="打开配置"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.72l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          </a>
          <button
            type="button"
            class="header-button grid size-8 place-items-center rounded-md border transition"
            :aria-label="theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
            :title="theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
            @click="toggleTheme()"
          >
            <svg x-cloak x-show="theme !== 'dark'" xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
            <svg x-cloak x-show="theme === 'dark'" xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
          </button>
        </div>
      </div>
    </header>

    <section
      id="messages"
      x-ref="messages"
      class="thin-scrollbar overflow-y-auto px-3 py-4 scroll-smooth sm:px-6 sm:py-5"
      @scroll="handleScroll()"
    >
      <div class="mx-auto flex min-h-full max-w-5xl flex-col gap-3">
        <div
          class="empty-state grid flex-1 place-items-center text-sm"
          x-show="messages.length === 0"
        >Ready</div>

        <template x-for="message in messages" :key="message.id">
          <div
            class="message-row flex items-start gap-2"
            :class="{
              'justify-end': message.type === 'user',
              'justify-start': message.type === 'agent',
              'justify-center': message.type === 'system' || message.type === 'error'
            }"
          >
            <div
              x-show="message.type === 'system' || message.type === 'error'"
              class="max-w-[88%] whitespace-pre-wrap break-words px-2 py-1 text-center text-xs leading-5 text-slate-400 sm:max-w-[78%]"
              :class="{ 'text-rose-500': message.type === 'error' }"
              x-text="message.text"
            ></div>
            <template x-if="message.type === 'user'">
              <div class="flex max-w-[88%] items-start gap-2 sm:max-w-[78%]">
                <div class="message-actions shrink-0 pt-1">
                  <button type="button" class="tool-button" :aria-label="copiedId === message.id ? '已复制' : '复制消息'" :title="copiedId === message.id ? '已复制' : '复制消息'" @click="copyMessage(message)">
                    <svg x-cloak x-show="copiedId !== message.id" xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                    <svg x-cloak x-show="copiedId === message.id" xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
                  </button>
                </div>
                <div class="user-bubble rounded-2xl rounded-br-md px-4 py-2.5 text-sm leading-6 shadow-sm">
                  <div x-show="message.text" class="whitespace-pre-wrap break-words" x-text="message.text"></div>
                  <div x-show="message.files && message.files.length" class="mt-2 grid gap-2">
                    <template x-for="file in message.files || []" :key="file.id">
                      <div>
                        <template x-if="isImageFile(file)">
                          <img class="message-image bg-white/10" :src="file.url" :alt="file.name || 'image'">
                        </template>
                        <template x-if="!isImageFile(file)">
                          <a class="flex max-w-full items-center gap-2 rounded-lg bg-white/15 px-2.5 py-2 text-white no-underline" :href="file.url" target="_blank" rel="noopener">
                            <svg xmlns="http://www.w3.org/2000/svg" class="size-5 shrink-0 opacity-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
                            <span class="min-w-0">
                              <span class="block truncate font-medium" x-text="file.name || 'file'"></span>
                              <span class="block text-xs opacity-80" x-text="formatFileSize(file.size)"></span>
                            </span>
                          </a>
                        </template>
                      </div>
                    </template>
                  </div>
                </div>
              </div>
            </template>
            <template x-if="message.type === 'agent'">
              <div class="flex max-w-[88%] items-start gap-2 sm:max-w-[78%]">
                <div class="agent-bubble break-words rounded-2xl rounded-bl-md border px-4 py-2.5 text-sm leading-6 shadow-sm">
                  <div x-show="message.html" class="markdown-body" x-html="message.html"></div>
                  <div x-show="!message.html" class="whitespace-pre-wrap" x-text="message.text"></div>
                  <div x-show="message.files && message.files.length" class="mt-2 grid gap-2">
                    <template x-for="file in message.files || []" :key="file.id">
                      <div>
                        <template x-if="isImageFile(file)">
                          <img class="message-image bg-slate-100 dark:bg-slate-800" :src="file.url" :alt="file.name || 'image'">
                        </template>
                        <template x-if="!isImageFile(file)">
                          <a class="flex max-w-full items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-slate-700 no-underline dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200" :href="file.url" target="_blank" rel="noopener">
                            <svg xmlns="http://www.w3.org/2000/svg" class="size-5 shrink-0 text-slate-500 dark:text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
                            <span class="min-w-0">
                              <span class="block truncate font-medium" x-text="file.name || 'file'"></span>
                              <span class="block text-xs text-slate-500 dark:text-slate-400" x-text="formatFileSize(file.size)"></span>
                            </span>
                          </a>
                        </template>
                      </div>
                    </template>
                  </div>
                </div>
                <div class="message-actions shrink-0 pt-1">
                  <button type="button" class="tool-button" :aria-label="copiedId === message.id ? '已复制' : '复制消息'" :title="copiedId === message.id ? '已复制' : '复制消息'" @click="copyMessage(message)">
                    <svg x-cloak x-show="copiedId !== message.id" xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                    <svg x-cloak x-show="copiedId === message.id" xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
                  </button>
                </div>
              </div>
            </template>
          </div>
        </template>
      </div>
    </section>

    <footer class="app-footer px-3 pb-3 pt-2 sm:px-6 sm:pb-5">
      <form id="form" class="mx-auto max-w-5xl" @submit.prevent="send()">
        <div
          class="composer-card rounded-2xl border p-2 transition focus-within:border-blue-500 focus-within:ring-4 focus-within:ring-blue-500/10"
          :class="{ 'drag-active': dragActive }"
          @paste="handlePaste($event)"
          @dragenter.prevent="handleDragEnter($event)"
          @dragover.prevent="handleDragOver($event)"
          @dragleave.prevent="handleDragLeave($event)"
          @drop.prevent="handleDrop($event)"
        >
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div class="min-w-0">
              <textarea
                id="text"
                x-ref="text"
                x-model="draft"
                class="composer-input thin-scrollbar max-h-40 min-h-14 w-full resize-none overflow-y-auto border-0 bg-transparent px-2 py-2 text-sm leading-6 outline-none"
                placeholder="输入消息，Enter 发送"
                rows="1"
                @input="resizeInput()"
                @keydown.enter="handleEnter($event)"
              ></textarea>
              <div x-show="draftFiles.length" class="flex flex-wrap gap-2 px-2 pb-1">
                <template x-for="file in draftFiles" :key="file.id">
                  <div class="relative h-16 overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800" :class="isImageFile(file) ? 'w-16' : 'w-48 max-w-full'">
                    <template x-if="isImageFile(file)">
                      <img class="size-full object-cover" :src="file.url" :alt="file.name || 'image'">
                    </template>
                    <template x-if="!isImageFile(file)">
                      <div class="flex size-full min-w-0 items-center gap-2 px-2 pr-7">
                        <svg xmlns="http://www.w3.org/2000/svg" class="size-5 shrink-0 text-slate-500 dark:text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
                        <span class="min-w-0 text-xs leading-4">
                          <span class="block truncate font-medium text-slate-700 dark:text-slate-200" x-text="file.name || 'file'"></span>
                          <span class="block text-slate-500 dark:text-slate-400" x-text="formatFileSize(file.size)"></span>
                        </span>
                      </div>
                    </template>
                    <button type="button" class="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-black/60 text-white" aria-label="移除文件" title="移除文件" @click="removeDraftFile(file.id)">
                      <svg xmlns="http://www.w3.org/2000/svg" class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                    </button>
                  </div>
                </template>
              </div>
            </div>
            <div class="flex items-center justify-end gap-2">
              <input x-ref="file" type="file" multiple class="hidden" @change="uploadFiles($event)">
              <button type="button" class="tool-button" aria-label="上传文件" title="上传文件" :disabled="!connected || uploading" @click="$refs.file.click()">
                <svg xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 6-8.4 8.4a2 2 0 0 0 2.8 2.8l8.4-8.4a4 4 0 1 0-5.6-5.6L4.8 11.6a6 6 0 1 0 8.4 8.4L21 12.2"/></svg>
              </button>
              <button
                id="send"
                type="submit"
                class="send-button h-10 rounded-xl px-5 text-sm font-semibold transition active:translate-y-px disabled:cursor-not-allowed"
                :disabled="!connected || (draft.trim().length === 0 && draftFiles.length === 0)"
              >发送</button>
            </div>
          </div>
        </div>
      </form>
    </footer>

    <button
      type="button"
      class="jump-button fixed bottom-24 left-1/2 hidden -translate-x-1/2 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-sm transition sm:bottom-28"
      :class="{ '!block': !autoScroll && messages.length > 0 }"
      @click="scrollToBottom(true)"
    >回到底部</button>
  </main>

  <script>
    function codexioChat() {
      return {
        socket: null,
        messages: [],
        draft: '',
        draftFiles: [],
        connected: false,
        connecting: false,
        uploading: false,
        dragActive: false,
        reconnectTimer: null,
        autoScroll: true,
        copiedId: null,
        theme: 'light',
        nextId: 1,
        init() {
          this.theme = this.getInitialTheme()
          this.connect()
          this.$nextTick(() => {
            this.resizeInput()
          })
        },
        getInitialTheme() {
          const saved = localStorage.getItem('codexio-theme')
          if (saved === 'light' || saved === 'dark') {
            return saved
          }
          if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            return 'dark'
          }
          return 'light'
        },
        toggleTheme() {
          this.theme = this.theme === 'dark' ? 'light' : 'dark'
          localStorage.setItem('codexio-theme', this.theme)
        },
        connect() {
          if (this.reconnectTimer) {
            window.clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
          }
          if (this.socket) {
            this.socket.close()
          }
          this.connecting = true
          this.connected = false
          const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
          const socket = new WebSocket(protocol + '//' + location.host + '/ws')
          this.socket = socket
          socket.addEventListener('open', () => {
            this.connected = true
            this.connecting = false
            this.$nextTick(() => {
              this.$refs.text.focus()
            })
          })
          socket.addEventListener('close', () => {
            if (this.socket !== socket) {
              return
            }
            this.connected = false
            this.connecting = false
            this.scheduleReconnect()
          })
          socket.addEventListener('error', () => {
            if (this.socket !== socket) {
              return
            }
            this.connected = false
            this.connecting = false
            this.scheduleReconnect()
          })
          socket.addEventListener('message', (event) => {
            this.receive(event.data)
          })
        },
        scheduleReconnect() {
          if (this.connected || this.connecting || this.reconnectTimer) {
            return
          }
          this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null
            this.connect()
          }, 1000)
        },
        receive(data) {
          let message
          try {
            message = JSON.parse(data)
          } catch {
            this.append('error', 'Invalid message')
            return
          }
          if (message.type === 'clear') {
            this.messages = []
            this.autoScroll = true
            return
          }
          if (message.type === 'ready') {
            return
          }
          if (message.type === 'error') {
            this.append('error', message.message || 'Request failed')
            return
          }
          if (message.type === 'user') {
            this.append('user', message.text || '', null, message.files || [])
            return
          }
          if (message.type === 'system') {
            this.append('system', message.text || '')
            return
          }
          if (message.type === 'agent') {
            this.append('agent', message.text || '', message.html, message.files || [])
          }
        },
        send() {
          const value = this.draft.trim()
          if (!value && this.draftFiles.length === 0) {
            return
          }
          if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            this.scheduleReconnect()
            return
          }
          this.socket.send(JSON.stringify({
            text: value,
            files: this.draftFiles.map((file) => file.id)
          }))
          this.draft = ''
          this.draftFiles = []
          this.$nextTick(() => {
            this.resizeInput()
            this.$refs.text.focus()
          })
        },
        append(type, text, html, files) {
          this.messages.push({
            id: this.nextId++,
            type,
            text,
            html,
            files: files || []
          })
          if (this.autoScroll) {
            this.$nextTick(() => {
              this.scrollToBottom(false)
            })
          }
        },
        async copyMessage(message) {
          const text = message && typeof message.text === 'string' ? message.text : ''
          if (!text) {
            return
          }
          try {
            if (navigator.clipboard && window.isSecureContext) {
              await navigator.clipboard.writeText(text)
            } else {
              this.copyWithFallback(text)
            }
            this.copiedId = message.id
            window.setTimeout(() => {
              if (this.copiedId === message.id) {
                this.copiedId = null
              }
            }, 1200)
          } catch {
            this.append('error', '复制失败')
          }
        },
        async uploadFiles(event) {
          const files = Array.from(event.target.files || [])
          event.target.value = ''
          await this.uploadSelectedFiles(files)
        },
        async uploadSelectedFiles(files) {
          if (this.uploading) {
            return
          }
          const selectedFiles = Array.from(files || [])
          if (selectedFiles.length === 0) {
            return
          }
          this.uploading = true
          try {
            for (const file of selectedFiles) {
              const form = new FormData()
              form.append('file', file)
              const response = await fetch('/api/files', {
                method: 'POST',
                body: form
              })
              const result = await response.json()
              if (result.isFailed) {
                this.append('error', result.message || '上传失败')
                continue
              }
              this.draftFiles.push(result.data.file)
            }
          } catch {
            this.append('error', '上传失败')
          } finally {
            this.uploading = false
            this.$nextTick(() => {
              this.$refs.text.focus()
            })
          }
        },
        isImageFile(file) {
          return Boolean(file && typeof file.mime === 'string' && file.mime.toLowerCase().startsWith('image/'))
        },
        formatFileSize(size) {
          const bytes = Number(size)
          if (!Number.isFinite(bytes) || bytes <= 0) {
            return '0 B'
          }
          const units = ['B', 'KB', 'MB', 'GB']
          let value = bytes
          let unit = 0
          while (value >= 1024 && unit < units.length - 1) {
            value = value / 1024
            unit += 1
          }
          return (unit === 0 ? String(value) : value.toFixed(value >= 10 ? 1 : 2)) + ' ' + units[unit]
        },
        async handlePaste(event) {
          const files = Array.from(event.clipboardData && event.clipboardData.files || [])
          if (files.length === 0) {
            return
          }
          event.preventDefault()
          await this.uploadSelectedFiles(files)
        },
        handleDragEnter(event) {
          if (Array.from(event.dataTransfer && event.dataTransfer.items || []).some((item) => item.kind === 'file')) {
            this.dragActive = true
          }
        },
        handleDragOver(event) {
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'copy'
          }
          if (Array.from(event.dataTransfer && event.dataTransfer.items || []).some((item) => item.kind === 'file')) {
            this.dragActive = true
          }
        },
        handleDragLeave(event) {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            this.dragActive = false
          }
        },
        async handleDrop(event) {
          this.dragActive = false
          await this.uploadSelectedFiles(Array.from(event.dataTransfer && event.dataTransfer.files || []))
        },
        removeDraftFile(id) {
          this.draftFiles = this.draftFiles.filter((file) => file.id !== id)
        },
        copyWithFallback(text) {
          const element = document.createElement('textarea')
          element.value = text
          element.setAttribute('readonly', '')
          element.style.position = 'fixed'
          element.style.top = '-9999px'
          document.body.appendChild(element)
          element.select()
          document.execCommand('copy')
          document.body.removeChild(element)
        },
        handleEnter(event) {
          if (event.shiftKey || event.ctrlKey) {
            this.$nextTick(() => {
              this.resizeInput()
            })
            return
          }
          event.preventDefault()
          this.send()
        },
        resizeInput() {
          const element = this.$refs.text
          if (!element) {
            return
          }
          element.style.height = 'auto'
          element.style.height = Math.min(element.scrollHeight, 160) + 'px'
        },
        handleScroll() {
          const element = this.$refs.messages
          const distance = element.scrollHeight - element.scrollTop - element.clientHeight
          this.autoScroll = distance < 48
        },
        scrollToBottom(force) {
          const element = this.$refs.messages
          if (!element) {
            return
          }
          element.scrollTo({
            top: element.scrollHeight,
            behavior: force ? 'smooth' : 'auto'
          })
          this.autoScroll = true
        }
      }
    }
  </script>
</body>
</html>`
