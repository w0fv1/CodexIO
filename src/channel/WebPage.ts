export const webPageHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="icon" href="data:,">
  <title>Codexio</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;font-family:Inter,Arial,"Microsoft YaHei",sans-serif;background:#f2f4f7;color:#121621}
    .shell{min-height:100vh;display:grid;grid-template-columns:minmax(0,1fr) minmax(420px,520px)}
    .intro{display:grid;align-content:space-between;gap:32px;padding:42px clamp(28px,5vw,72px);background:#fff}
    .brand{display:flex;align-items:center;gap:12px;font-weight:800;font-size:18px}
    .mark{width:34px;height:34px;border-radius:8px;background:#111827;display:grid;place-items:center;color:#fff;font-weight:900}
    .hero{max-width:720px}
    h1{font-size:clamp(38px,5vw,68px);line-height:1.02;margin:0 0 22px;font-weight:900;letter-spacing:0}
    .lead{font-size:20px;line-height:1.7;margin:0;color:#475467;max-width:660px}
    .actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:30px}
    .action{display:inline-flex;align-items:center;justify-content:center;height:44px;padding:0 18px;border-radius:8px;border:1px solid #111827;background:#111827;color:#fff;font-weight:800;text-decoration:none}
    .action.secondary{background:#fff;color:#111827}
    .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:34px;max-width:760px}
    .item{border:1px solid #d9dee8;border-radius:8px;padding:16px;background:#fbfcfe;min-height:132px}
    .item b{display:block;font-size:16px;margin-bottom:10px}
    .item span{display:block;color:#667085;line-height:1.55;font-size:14px}
    .flow{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:34px;max-width:760px}
    .step{border:1px solid #d9dee8;border-radius:8px;background:#fff;padding:14px}
    .step small{display:block;color:#98a2b3;font-weight:800;margin-bottom:8px}
    .step span{display:block;font-size:14px;font-weight:800;color:#344054}
    .panel{min-height:100vh;display:grid;grid-template-rows:auto 1fr auto;background:#111827;color:#f9fafb;border-left:1px solid #202938}
    .panelHeader{padding:22px;border-bottom:1px solid #283244}
    .panelHeader h2{font-size:18px;margin:0 0 8px}
    .panelHeader p{margin:0;color:#aeb8c7;line-height:1.5;font-size:14px}
    #messages{padding:20px 22px;overflow:auto;display:flex;flex-direction:column;gap:12px}
    .message{max-width:86%;padding:11px 13px;border-radius:8px;line-height:1.55;white-space:pre-wrap;word-break:break-word;font-size:14px}
    .user{align-self:flex-end;background:#2f6fed;color:#fff}
    .agent{align-self:flex-start;background:#202938;color:#f9fafb}
    form{display:grid;grid-template-columns:1fr auto;gap:10px;padding:16px 22px;border-top:1px solid #283244}
    textarea{resize:none;min-height:50px;max-height:160px;padding:11px 12px;border:1px solid #3a4558;border-radius:8px;background:#0b1220;color:#f9fafb;font:inherit;outline:none}
    textarea:focus{border-color:#7aa2ff}
    textarea::placeholder{color:#8793a5}
    button{border:0;border-radius:8px;background:#f9fafb;color:#111827;padding:0 18px;font-weight:900;cursor:pointer;min-width:76px}
    button:disabled{background:#667085;color:#d0d5dd;cursor:default}
    @media (max-width:900px){
      .shell{grid-template-columns:1fr}
      .intro{min-height:auto;padding:28px 20px}
      .grid{grid-template-columns:1fr}
      .flow{grid-template-columns:repeat(2,minmax(0,1fr))}
      .panel{min-height:70vh;border-left:0;border-top:1px solid #202938}
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="intro">
      <div class="brand"><span class="mark">C</span><span>Codexio</span></div>
      <div class="hero">
        <h1>让 coding agent 通过统一通道工作</h1>
        <p class="lead">Codexio 是无数据库、配置驱动的 coding agent 文本中转器。它把网页、命令行和本地 agent 连接到同一个轻量 host 中，用 HTTP API 与事件流完成消息传递。</p>
        <div class="actions">
          <a class="action" href="#chat">打开 Web 通道</a>
          <a class="action secondary" href="https://github.com/openai/codex" rel="noreferrer">Codex CLI</a>
        </div>
        <div class="grid">
          <div class="item"><b>配置驱动</b><span>server、workspace、agent、proxy 和 channel 都来自本地 YAML 配置，运行边界清晰。</span></div>
          <div class="item"><b>多通道接入</b><span>Web 通道适合远程对话，CLI 通道适合本地终端，外部系统可通过 HTTP API 投递消息。</span></div>
          <div class="item"><b>本地优先</b><span>不接入主后端数据库，agent 在配置的 workspace 中运行，状态尽量留在本机工具链。</span></div>
        </div>
        <div class="flow">
          <div class="step"><small>01</small><span>pnpm install</span></div>
          <div class="step"><small>02</small><span>pnpm dev</span></div>
          <div class="step"><small>03</small><span>选择通道</span></div>
          <div class="step"><small>04</small><span>发送任务</span></div>
        </div>
      </div>
    </section>
    <section class="panel" id="chat">
      <div class="panelHeader">
        <h2>Web 通道</h2>
        <p>这里直接连接当前 Codexio host，消息会转发给已启用的 agent。</p>
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
    const events = new EventSource('/api/web/events')
    events.onmessage = (event) => {
      const message = JSON.parse(event.data)
      append('agent', message.text)
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const value = text.value.trim()
      if (!value) {
        return
      }
      append('user', value)
      text.value = ''
      send.disabled = true
      const response = await fetch('/api/web/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: value
        })
      })
      const result = await response.json()
      if (result.data && result.data.action === 'clear') {
        messages.innerHTML = ''
      }
      if (result.isFailed) {
        append('agent', result.message)
      }
      send.disabled = false
      text.focus()
    })
  </script>
</body>
</html>`
