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
    @media (hover:none){.message-actions{opacity:1}}
  </style>
</head>
<body class="h-screen overflow-hidden bg-slate-100 text-slate-950 antialiased">
  <main
    id="chat"
    class="relative h-screen overflow-hidden lg:grid lg:grid-cols-[280px_minmax(0,1fr)]"
    :class="theme === 'dark' ? 'bg-slate-950 text-slate-200' : 'bg-slate-100 text-slate-950'"
    x-data="codexioChat()"
    x-init="init()"
  >
    <div
      x-cloak
      x-show="sidebarOpen"
      x-transition.opacity
      class="fixed inset-0 z-20 bg-slate-950/45 lg:hidden"
      @click="sidebarOpen = false"
    ></div>

    <aside
      id="threads"
      class="fixed inset-y-0 left-0 z-30 flex w-[min(82vw,280px)] -translate-x-full flex-col transition-transform duration-200 lg:static lg:z-auto lg:w-auto lg:translate-x-0"
      :class="[
        sidebarOpen ? 'translate-x-0' : '',
        theme === 'dark' ? 'bg-slate-950' : 'bg-white'
      ]"
    >
      <div class="flex h-14 shrink-0 items-center justify-between gap-3 px-3">
        <div class="flex min-w-0 items-center gap-2">
          <span class="grid size-8 shrink-0 place-items-center rounded-lg text-sm font-black" :class="theme === 'dark' ? 'bg-slate-50 text-slate-950' : 'bg-slate-950 text-white'">C</span>
          <span class="truncate text-sm font-semibold tracking-normal" :class="theme === 'dark' ? 'text-slate-50' : 'text-slate-950'">Codexio</span>
        </div>
        <button
          type="button"
          class="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md bg-transparent transition lg:hidden"
          :class="theme === 'dark' ? 'text-slate-300 hover:bg-slate-900' : 'text-slate-700 hover:bg-slate-50'"
          aria-label="关闭对话列表"
          title="关闭对话列表"
          @click="sidebarOpen = false"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <div class="p-3">
        <button
          type="button"
          class="flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-lg text-sm font-semibold transition active:translate-y-px"
          :class="theme === 'dark' ? 'bg-slate-50 text-slate-950 hover:bg-slate-200' : 'bg-slate-950 text-white hover:bg-slate-800'"
          @click="createThread(true)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
          <span>新建对话</span>
        </button>
      </div>

      <nav class="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-2" aria-label="对话列表">
        <template x-for="thread in threads" :key="thread.id">
          <button
            type="button"
            class="mb-1 flex h-11 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left text-sm transition"
            :class="thread.id === activeIoThreadId ? (theme === 'dark' ? 'bg-slate-900 text-slate-50' : 'bg-slate-100 text-slate-950') : (theme === 'dark' ? 'text-slate-400 hover:bg-slate-900 hover:text-slate-100' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950')"
            :title="thread.title || '新对话'"
            @click="switchThread(thread.id)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>
            <span class="min-w-0 flex-1 truncate" x-text="thread.title || '新对话'"></span>
            <span x-show="thread.isWorking" class="size-2 shrink-0 rounded-full bg-emerald-500" aria-hidden="true"></span>
            <span
              x-show="thread.unread > 0"
              class="grid min-w-5 shrink-0 place-items-center rounded-full bg-blue-600 px-1.5 text-[10px] leading-5 text-white"
              x-text="thread.unread"
            ></span>
          </button>
        </template>
      </nav>
    </aside>

    <section class="grid h-screen w-full min-w-0 overflow-hidden grid-rows-[auto_minmax(0,1fr)_auto]">
      <header
        class="h-14 w-full min-w-0 px-3 backdrop-blur sm:px-6"
        :class="theme === 'dark' ? 'bg-slate-950/90' : 'bg-white/90'"
      >
        <div class="mx-auto flex h-full w-full max-w-5xl min-w-0 items-center justify-between gap-3">
          <div class="flex min-w-0 flex-1 items-center gap-2">
            <button
              type="button"
              class="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md bg-transparent transition lg:hidden"
              :class="theme === 'dark' ? 'text-slate-300 hover:bg-slate-900' : 'text-slate-700 hover:bg-slate-50'"
              aria-label="打开对话列表"
              title="打开对话列表"
              @click="sidebarOpen = true"
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg>
            </button>
            <div class="min-w-0">
              <div class="max-w-full truncate text-sm font-semibold" :class="theme === 'dark' ? 'text-slate-50' : 'text-slate-950'" x-text="activeThreadTitle()"></div>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2 text-xs">
            <span
              class="size-2 rounded-full"
              :class="connected ? 'bg-emerald-500' : 'bg-rose-500'"
              aria-hidden="true"
            ></span>
            <button
              type="button"
              class="grid size-8 cursor-pointer place-items-center rounded-md bg-transparent transition"
              :class="theme === 'dark' ? 'text-slate-300 hover:bg-slate-900' : 'text-slate-700 hover:bg-slate-50'"
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
      class="thin-scrollbar w-full min-w-0 overflow-y-auto overflow-x-hidden px-3 py-4 scroll-smooth sm:px-6 sm:py-5"
      @scroll="handleScroll()"
    >
      <div class="mx-auto flex min-h-full w-full max-w-5xl min-w-0 flex-col gap-3">
        <template x-for="message in messages" :key="message.id">
          <div
            class="group flex items-start gap-2"
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
              <div class="flex max-w-[88%] min-w-0 items-start gap-2 sm:max-w-[78%]">
                <div class="message-actions hidden shrink-0 pt-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 sm:block">
                  <button type="button" class="grid size-8 cursor-pointer place-items-center rounded-[10px] transition active:translate-y-px" :class="theme === 'dark' ? 'bg-slate-900/80 text-slate-400 hover:bg-slate-800 hover:text-slate-50' : 'bg-white/80 text-slate-500 hover:bg-white hover:text-slate-900'" :aria-label="copiedId === message.id ? '已复制' : '复制消息'" :title="copiedId === message.id ? '已复制' : '复制消息'" @click="copyMessage(message)">
                    <svg x-cloak x-show="copiedId !== message.id" xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                    <svg x-cloak x-show="copiedId === message.id" xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
                  </button>
                </div>
                <div class="min-w-0 rounded-2xl rounded-br-md bg-blue-600 px-4 py-2.5 text-sm leading-6 text-white shadow-sm">
                  <div x-show="message.text" class="whitespace-pre-wrap break-words" x-text="message.text"></div>
                  <div x-show="message.files && message.files.length" class="mt-2 grid gap-2">
                    <template x-for="file in message.files || []" :key="file.id">
                      <div>
                        <template x-if="isImageFile(file)">
                          <img class="max-h-80 max-w-[min(320px,100%)] rounded-[10px] bg-white/10 object-contain" :src="file.url" :alt="file.name || 'image'">
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
              <div class="flex max-w-[88%] min-w-0 items-start gap-2 sm:max-w-[78%]">
                <div class="min-w-0 break-words rounded-2xl rounded-bl-md border px-4 py-2.5 text-sm leading-6 shadow-sm" :class="theme === 'dark' ? 'border-slate-800 bg-slate-900 text-slate-200' : 'border-slate-200 bg-white text-slate-900'">
                  <div
                    x-show="message.html"
                    class="[&_a]:text-blue-600 [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:my-3 [&_blockquote]:border-l-[3px] [&_blockquote]:border-slate-300 [&_blockquote]:pl-3 [&_blockquote]:text-slate-600 [&_code]:rounded-md [&_code]:bg-slate-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.95em] [&_code]:text-slate-950 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-3 [&_p:last-child]:mb-0 [&_pre]:my-3 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-slate-900 [&_pre]:p-3 [&_pre]:text-slate-200 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit [&_table]:my-3 [&_table]:block [&_table]:w-full [&_table]:border-collapse [&_table]:overflow-auto [&_td]:border [&_td]:border-slate-200 [&_td]:px-2 [&_td]:py-1.5 [&_td]:text-left [&_th]:border [&_th]:border-slate-200 [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-5"
                    :class="theme === 'dark' ? '[&_a]:text-blue-400 [&_blockquote]:border-slate-600 [&_blockquote]:text-slate-400 [&_code]:bg-slate-800 [&_code]:text-slate-50 [&_td]:border-slate-700 [&_th]:border-slate-700' : ''"
                    x-html="message.html"
                  ></div>
                  <div x-show="!message.html" class="whitespace-pre-wrap" x-text="message.text"></div>
                  <div x-show="message.files && message.files.length" class="mt-2 grid gap-2">
                    <template x-for="file in message.files || []" :key="file.id">
                      <div>
                        <template x-if="isImageFile(file)">
                          <img class="max-h-80 max-w-[min(320px,100%)] rounded-[10px] object-contain" :class="theme === 'dark' ? 'bg-slate-800' : 'bg-slate-100'" :src="file.url" :alt="file.name || 'image'">
                        </template>
                        <template x-if="!isImageFile(file)">
                          <a class="flex max-w-full items-center gap-2 rounded-lg border px-2.5 py-2 no-underline" :class="theme === 'dark' ? 'border-slate-700 bg-slate-950 text-slate-200' : 'border-slate-200 bg-slate-50 text-slate-700'" :href="file.url" target="_blank" rel="noopener">
                            <svg xmlns="http://www.w3.org/2000/svg" class="size-5 shrink-0" :class="theme === 'dark' ? 'text-slate-400' : 'text-slate-500'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
                            <span class="min-w-0">
                              <span class="block truncate font-medium" x-text="file.name || 'file'"></span>
                              <span class="block text-xs" :class="theme === 'dark' ? 'text-slate-400' : 'text-slate-500'" x-text="formatFileSize(file.size)"></span>
                            </span>
                          </a>
                        </template>
                      </div>
                    </template>
                  </div>
                </div>
                <div class="message-actions hidden shrink-0 pt-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 sm:block">
                  <button type="button" class="grid size-8 cursor-pointer place-items-center rounded-[10px] transition active:translate-y-px" :class="theme === 'dark' ? 'bg-slate-900/80 text-slate-400 hover:bg-slate-800 hover:text-slate-50' : 'bg-white/80 text-slate-500 hover:bg-white hover:text-slate-900'" :aria-label="copiedId === message.id ? '已复制' : '复制消息'" :title="copiedId === message.id ? '已复制' : '复制消息'" @click="copyMessage(message)">
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

      <footer class="w-full min-w-0 overflow-hidden px-3 pb-3 pt-2 sm:px-6 sm:pb-5" :class="theme === 'dark' ? 'bg-slate-950' : 'bg-slate-100'">
      <form id="form" class="mx-auto w-full max-w-5xl min-w-0" @submit.prevent="send()">
        <div
          class="rounded-2xl p-2 transition focus-within:ring-4 focus-within:ring-blue-500/10"
          :class="dragActive ? (theme === 'dark' ? 'bg-slate-900 shadow-[0_0_0_4px_rgba(59,130,246,0.18),0_14px_26px_rgba(0,0,0,0.32)]' : 'bg-white shadow-[0_0_0_4px_rgba(37,99,235,0.1),0_10px_18px_rgba(148,163,184,0.34)]') : (theme === 'dark' ? 'bg-slate-900 shadow-[0_14px_26px_rgba(0,0,0,0.32)]' : 'bg-white shadow-[0_10px_18px_rgba(148,163,184,0.34)]')"
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
                class="thin-scrollbar max-h-40 min-h-14 w-full resize-none overflow-y-auto border-0 bg-transparent px-2 py-2 text-sm leading-6 outline-none"
                :class="theme === 'dark' ? 'text-slate-50 placeholder:text-slate-500' : 'text-slate-950 placeholder:text-slate-400'"
                placeholder="输入消息，Enter 发送"
                rows="1"
                @input="resizeInput()"
                @keydown.enter="handleEnter($event)"
              ></textarea>
              <div x-show="draftFiles.length" class="flex flex-wrap gap-2 px-2 pb-1">
                <template x-for="file in draftFiles" :key="file.id">
                  <div class="relative h-16 overflow-hidden rounded-lg border" :class="(isImageFile(file) ? 'w-16 ' : 'w-48 max-w-full ') + (theme === 'dark' ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-slate-100')">
                    <template x-if="isImageFile(file)">
                      <img class="size-full object-cover" :src="file.url" :alt="file.name || 'image'">
                    </template>
                    <template x-if="!isImageFile(file)">
                      <div class="flex size-full min-w-0 items-center gap-2 px-2 pr-7">
                        <svg xmlns="http://www.w3.org/2000/svg" class="size-5 shrink-0" :class="theme === 'dark' ? 'text-slate-400' : 'text-slate-500'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
                        <span class="min-w-0 text-xs leading-4">
                          <span class="block truncate font-medium" :class="theme === 'dark' ? 'text-slate-200' : 'text-slate-700'" x-text="file.name || 'file'"></span>
                          <span class="block" :class="theme === 'dark' ? 'text-slate-400' : 'text-slate-500'" x-text="formatFileSize(file.size)"></span>
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
              <button type="button" class="grid size-8 cursor-pointer place-items-center rounded-[10px] transition active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50" :class="theme === 'dark' ? 'bg-slate-900/80 text-slate-400 hover:bg-slate-800 hover:text-slate-50' : 'bg-white/80 text-slate-500 hover:bg-white hover:text-slate-900'" aria-label="上传文件" title="上传文件" :disabled="!connected || uploading" @click="$refs.file.click()">
                <svg xmlns="http://www.w3.org/2000/svg" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 6-8.4 8.4a2 2 0 0 0 2.8 2.8l8.4-8.4a4 4 0 1 0-5.6-5.6L4.8 11.6a6 6 0 1 0 8.4 8.4L21 12.2"/></svg>
              </button>
              <button
                id="send"
                type="submit"
                class="h-10 cursor-pointer rounded-xl px-5 text-sm font-semibold transition active:translate-y-px disabled:cursor-not-allowed"
                :class="theme === 'dark' ? 'bg-slate-50 text-slate-950 enabled:hover:bg-slate-200 disabled:bg-slate-700 disabled:text-slate-400' : 'bg-slate-950 text-white enabled:hover:bg-slate-800 disabled:bg-slate-300 disabled:text-slate-500'"
                :disabled="!connected || (draft.trim().length === 0 && draftFiles.length === 0)"
              >发送</button>
            </div>
          </div>
        </div>
      </form>
      </footer>

      <button
      type="button"
      class="fixed bottom-24 left-1/2 hidden -translate-x-1/2 cursor-pointer rounded-full border px-3 py-1.5 text-xs font-semibold shadow-sm transition sm:bottom-28 lg:left-[calc(50%+140px)]"
      :class="[
        !autoScroll && messages.length > 0 ? '!block' : '',
        theme === 'dark' ? 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
      ]"
      @click="scrollToBottom(true)"
      >回到底部</button>
    </section>
  </main>

  <script>
    function codexioChat() {
      return {
        socket: null,
        threads: [],
        activeIoThreadId: '',
        allIoThreadId: 'io_all',
        sidebarOpen: false,
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
          this.messages = []
          this.connect()
          this.$nextTick(() => {
            this.resizeInput()
          })
        },
        createThread(activate) {
          const thread = {
            id: this.newIoThreadId(),
            title: '',
            messages: [],
            unread: 0,
            isWorking: false,
            updatedAt: Date.now()
          }
          this.threads.unshift(thread)
          if (activate || !this.activeIoThreadId) {
            this.switchThread(thread.id)
          }
          return thread
        },
        newIoThreadId() {
          if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID()
          }
          return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2)
        },
        switchThread(id) {
          if (!id) {
            this.activeIoThreadId = ''
            this.messages = []
            this.autoScroll = true
            this.$nextTick(() => {
              this.scrollToBottom(false)
              this.$refs.text.focus()
            })
            return
          }
          const thread = this.ensureThread(id)
          this.activeIoThreadId = thread.id
          thread.unread = 0
          this.messages = thread.messages
          this.sidebarOpen = false
          this.autoScroll = true
          this.$nextTick(() => {
            this.scrollToBottom(false)
            this.$refs.text.focus()
          })
        },
        activeThread() {
          return this.activeIoThreadId ? this.ensureThread(this.activeIoThreadId) : null
        },
        activeThreadTitle() {
          const thread = this.activeThread()
          if (!thread) {
            return '新对话'
          }
          return thread.title || '新对话'
        },
        ensureThread(id) {
          let thread = this.threads.find((item) => item.id === id)
          if (thread) {
            return thread
          }
          thread = {
            id: id || this.newIoThreadId(),
            title: '',
            messages: [],
            unread: 0,
            isWorking: false,
            updatedAt: Date.now()
          }
          this.threads.unshift(thread)
          if (!this.activeIoThreadId) {
            this.activeIoThreadId = thread.id
            this.messages = thread.messages
          }
          return thread
        },
        updateThreadTitle(thread, message) {
          if (thread.title || message.type !== 'user') {
            return
          }
          const text = (message.text || '').replace(/\s+/g, ' ').trim()
          if (text.length > 0) {
            thread.title = text.slice(0, 32)
          }
        },
        upsertThread(input) {
          if (!input || !input.id) {
            return
          }
          const thread = this.ensureThread(input.id)
          thread.title = typeof input.title === 'string' && input.title.length > 0 ? input.title : thread.title
          thread.isWorking = Boolean(input.isWorking)
          if (thread.id === this.activeIoThreadId) {
            this.messages = thread.messages
          }
        },
        removeThread(id) {
          const index = this.threads.findIndex((item) => item.id === id)
          if (index < 0) {
            return
          }
          this.threads.splice(index, 1)
          if (this.activeIoThreadId === id) {
            const next = this.threads[0]
            this.activeIoThreadId = next ? next.id : ''
            this.messages = next ? next.messages : []
          }
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
            this.append(this.activeIoThreadId || this.allIoThreadId, 'error', 'Invalid message')
            return
          }
          if (message.allIoThreadId) {
            this.allIoThreadId = message.allIoThreadId
          }
          if (message.event === 'ready') {
            return
          }
          if (message.event === 'threads') {
            for (const thread of message.threads || []) {
              this.upsertThread(thread)
            }
            return
          }
          if (message.event === 'messages') {
            this.replaceMessages(message.messages || [])
            return
          }
          if (message.event === 'thread') {
            this.upsertThread(message.thread)
            return
          }
          if (message.event === 'threadDeleted') {
            this.removeThread(message.id)
            return
          }
          if (message.event === 'error') {
            this.append(message.ioThreadId, 'error', message.message || 'Request failed')
            return
          }
          if (message.event !== 'message') {
            return
          }
          if (message.role === 'user') {
            this.append(message.ioThreadId, 'user', message.text || '', null, message.files || [])
            return
          }
          if (message.role === 'system') {
            this.append(message.ioThreadId, 'system', message.text || '')
            return
          }
          if (message.role === 'agent') {
            this.append(message.ioThreadId, 'agent', message.text || '', message.html, message.files || [])
          }
        },
        replaceMessages(messages) {
          for (const thread of this.threads) {
            thread.messages = []
            thread.unread = 0
          }
          const activeId = this.activeIoThreadId
          for (const message of messages) {
            const type = message.role === 'agent' ? 'agent' : message.role
            const thread = this.ensureThread(message.ioThreadId)
            thread.messages.push({
              id: this.nextId++,
              type,
              text: message.text || '',
              html: message.html,
              files: message.files || []
            })
            thread.updatedAt = message.createdAt || Date.now()
            this.updateThreadTitle(thread, thread.messages[thread.messages.length - 1])
            if (activeId && thread.id !== activeId) {
              thread.unread = 0
            }
          }
          const active = this.activeThread()
          this.messages = active ? active.messages : []
          if (this.autoScroll) {
            this.$nextTick(() => {
              this.scrollToBottom(false)
            })
          }
        },
        send() {
          const value = this.draft.trim()
          if (!value && this.draftFiles.length === 0) {
            return
          }
          if (!this.activeIoThreadId) {
            this.createThread(true)
          }
          if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            this.scheduleReconnect()
            return
          }
          const payload = {
            text: value,
            files: this.draftFiles.map((file) => file.id)
          }
          if (this.activeIoThreadId) {
            payload.ioThreadId = this.activeIoThreadId
          }
          this.socket.send(JSON.stringify(payload))
          this.draft = ''
          this.draftFiles = []
          this.$nextTick(() => {
            this.resizeInput()
            this.$refs.text.focus()
          })
        },
        append(ioThreadId, type, text, html, files) {
          const message = {
            id: this.nextId++,
            type,
            text,
            html,
            files: files || []
          }
          if (ioThreadId === this.allIoThreadId) {
            for (const item of this.threads) {
              const copied = {
                ...message,
                id: this.nextId++
              }
              item.messages.push(copied)
              item.updatedAt = Date.now()
              if (item.id !== this.activeIoThreadId) {
                item.unread += 1
              }
            }
            const active = this.activeThread()
            this.messages = active ? active.messages : []
            if (this.autoScroll) {
              this.$nextTick(() => {
                this.scrollToBottom(false)
              })
            }
            return
          }
          if (!ioThreadId) {
            return
          }
          const thread = this.ensureThread(ioThreadId)
          thread.messages.push(message)
          thread.updatedAt = Date.now()
          this.updateThreadTitle(thread, message)
          if (thread.id !== this.activeIoThreadId) {
            thread.unread += 1
            return
          }
          this.messages = thread.messages
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
            this.append(this.activeIoThreadId, 'error', '复制失败')
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
                this.append(this.activeIoThreadId, 'error', result.message || '上传失败')
                continue
              }
              this.draftFiles.push(result.data.file)
            }
          } catch {
            this.append(this.activeIoThreadId, 'error', '上传失败')
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
