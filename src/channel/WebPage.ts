export const webPageHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="icon" href="data:,">
  <title>Codexio</title>
  <style>
    *{box-sizing:border-box}
    html,body{height:100%;overflow:hidden}
    body{margin:0;font-family:Inter,Arial,"Microsoft YaHei",sans-serif;background:#111827;color:#f9fafb}
    .shell{height:100vh;display:block}
    .brand{display:flex;align-items:center;gap:12px;font-weight:800;font-size:18px}
    .mark{width:34px;height:34px;border-radius:8px;background:#f9fafb;display:grid;place-items:center;color:#111827;font-weight:900}
    .panel{height:100vh;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:#111827;color:#f9fafb}
    .panelHeader{padding:18px 22px;border-bottom:1px solid #283244}
    #messages{padding:20px 22px;overflow:auto;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth}
    .message{max-width:86%;padding:11px 13px;border-radius:8px;line-height:1.55;white-space:pre-wrap;word-break:break-word;font-size:14px;animation:messageIn 160ms ease-out both}
    .user{align-self:flex-end;background:#2f6fed;color:#fff}
    .agent{align-self:flex-start;background:#202938;color:#f9fafb}
    form{display:grid;grid-template-columns:1fr auto;gap:10px;padding:16px 22px;border-top:1px solid #283244}
    textarea{resize:none;min-height:50px;max-height:160px;padding:11px 12px;border:1px solid #3a4558;border-radius:8px;background:#0b1220;color:#f9fafb;font:inherit;outline:none;transition:border-color 140ms ease,box-shadow 140ms ease}
    textarea:focus{border-color:#7aa2ff;box-shadow:0 0 0 3px rgba(122,162,255,.16)}
    textarea::placeholder{color:#8793a5}
    button{height:50px;max-height:50px;border:0;border-radius:8px;background:#f9fafb;color:#111827;padding:0 18px;font-weight:900;cursor:pointer;min-width:76px;transition:background-color 140ms ease,transform 120ms ease,color 140ms ease}
    button:hover:not(:disabled){background:#e6ebf3}
    button:active:not(:disabled){transform:translateY(1px)}
    button:disabled{background:#667085;color:#d0d5dd;cursor:default}
    @keyframes messageIn{
      from{opacity:0;transform:translateY(6px) scale(.99)}
      to{opacity:1;transform:translateY(0) scale(1)}
    }
    @media (prefers-reduced-motion:reduce){
      #messages{scroll-behavior:auto}
      .message{animation:none}
      textarea,button{transition:none}
    }
    @media (max-width:640px){
      .panelHeader{padding:14px 16px}
      #messages{padding:16px}
      form{padding:12px 16px;grid-template-columns:1fr}
      button{height:44px;max-height:44px}
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="panel" id="chat">
      <div class="panelHeader">
        <div class="brand"><span class="mark">C</span><span>Codexio</span></div>
      </div>
      <section id="messages"></section>
      <form id="form">
        <textarea id="text" placeholder="输入文本" required></textarea>
        <button id="send" type="submit">发送</button>
      </form>
    </section>
  </main>
  <script>
    const messages = document.querySelector('#messages')
    const form = document.querySelector('#form')
    const text = document.querySelector('#text')
    const send = document.querySelector('#send')
    function append(className, value) {
      const element = document.createElement('div')
      element.className = 'message ' + className
      element.textContent = value
      messages.appendChild(element)
      messages.scrollTop = messages.scrollHeight
    }
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(protocol + '//' + location.host + '/ws')
    send.disabled = true
    socket.addEventListener('open', () => {
      send.disabled = false
      text.focus()
    })
    socket.addEventListener('close', () => {
      send.disabled = true
      append('agent', 'WebSocket 已断开')
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.type === 'clear') {
        messages.innerHTML = ''
        return
      }
      if (message.type === 'error') {
        append('agent', message.message)
        return
      }
      if (message.type === 'human') {
        append('user', message.text)
        return
      }
      if (message.type === 'agent') {
        append('agent', message.text)
      }
    })
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const value = text.value.trim()
      if (!value) {
        return
      }
      if (socket.readyState !== WebSocket.OPEN) {
        append('agent', 'WebSocket 未连接')
        return
      }
      append('user', value)
      text.value = ''
      socket.send(JSON.stringify({
        text: value
      }))
      text.focus()
    })
    text.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') {
        return
      }
      if (event.ctrlKey) {
        event.preventDefault()
        const start = text.selectionStart
        const end = text.selectionEnd
        const value = text.value
        text.value = value.slice(0, start) + '\\n' + value.slice(end)
        text.selectionStart = start + 1
        text.selectionEnd = start + 1
        return
      }
      event.preventDefault()
      form.requestSubmit()
    })
  </script>
</body>
</html>`
