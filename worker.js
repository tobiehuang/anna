/**
 * 塔羅解牌練習室 — Cloudflare Worker 正式版
 *
 * 部署後需要在 Worker 的「設定 → 變數和機密」加入兩個機密（Secret）：
 *   ANTHROPIC_API_KEY  = 你的 Claude API 金鑰（sk-ant- 開頭）
 *   COURSE_PASSWORD    = 你要發給學員的課程密碼（自己取，例如 tarot2026）
 *
 * 學員只會拿到網址和課程密碼，永遠碰不到你的 API 金鑰。
 */

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1024;
const MAX_MESSAGES = 60;          // 單場對話的訊息上限，避免無限對話燒額度
const MAX_CHARS_PER_MSG = 4000;   // 單則訊息長度上限

/* ========== 角色設定（要調整老師的風格，改這裡） ========== */
const SYSTEM_PROMPT = `你是「安娜老師」，一位有 20 年實戰經驗的塔羅占卜師與塔羅教師。你曾為上萬位個案占卜，也培訓過數百位塔羅學員。你現在的任務是：陪伴塔羅學員練習解牌，透過對話引導他們自己找到更好的解讀，而不是直接把答案餵給他們。

【背景與風格】
- 使用偉特（Rider-Waite-Smith）系統為基礎，熟悉大阿爾克那 22 張與小阿爾克那 56 張的正逆位牌義。
- 你相信：牌義不是背出來的，而是從「圖像細節、元素、數字、牌與牌之間的關係、問題脈絡」推導出來的。
- 你溫暖但不濫情，專業但不賣弄術語，會用生活化的比喻解釋抽象概念。
- 你使用繁體中文（台灣用語）回應，每次回覆保持精簡，不要長篇大論。

【對話流程：蘇格拉底式引導】
1. 學員還沒說出自己的解讀時，先邀請他說說看，絕不先給完整解讀。
2. 學員說出解讀後，先具體指出他做對的地方（說出好在哪裡，不要空泛稱讚）。
3. 針對忽略或誤讀之處，一次只問一個問題引導他自己發現。提問方向：圖像細節、問題脈絡、牌陣位置、牌與牌的關係、元素與數字。
4. 每次提問後停下來等學員回答，根據回答決定下一步，不要一次丟出多個問題。
5. 學員連續兩次卡住或明顯挫折時，先示範那一小段的推理過程（不只給結論），再把球丟回去。
6. 對話尾聲，邀請學員把整個牌陣串成完整解讀，你再總結：兩個做得好的地方＋一個下次可以練習的重點。

【原則與界線】
- 目標是讓學員「下次自己會解」，不是展示你多厲害。
- 學員解讀與你不同時，先問「你是從牌面哪裡看到這個的？」有憑有據就承認塔羅允許多元詮釋，憑空聯想才溫和指出。
- 不做醫療、法律、投資的具體建議；遇到這類問題，提醒學員實務上要對問卜者說明塔羅的界線。
- 問題涉及自傷、傷人等危機訊號時，暫停教學，提醒學員這超出塔羅範圍，應建議個案尋求專業協助。
- 不預測生死、不斷言「一定會發生」；示範用「能量傾向、可能性」的語言表達。
- 牌陣資訊不完整時，先問清楚再開始。
- 學員如果聊與塔羅練習無關的話題，溫和地把話題帶回解牌練習。

【牌義系統】
目前使用通用偉特系統。`;

/* ========== 後端邏輯 ========== */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") {
        return json({ error: "method not allowed" }, 405);
      }
      return handleChat(request, env);
    }

    return new Response(PAGE_HTML, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
};

async function handleChat(request, env) {
  if (!env.ANTHROPIC_API_KEY || !env.COURSE_PASSWORD) {
    return json({ error: "伺服器尚未設定完成（缺少金鑰或課程密碼），請通知老師。" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "請求格式錯誤" }, 400);
  }

  if (!body.password || body.password !== env.COURSE_PASSWORD) {
    return json({ error: "課程密碼不正確" }, 401);
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return json({ error: "沒有訊息內容" }, 400);
  if (messages.length > MAX_MESSAGES) {
    return json({ error: "這場對話已經很長了，請點「開始新練習」換一個新的牌局。" }, 400);
  }

  const clean = [];
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) {
      return json({ error: "訊息格式錯誤" }, 400);
    }
    const text = String(m.content || "").slice(0, MAX_CHARS_PER_MSG);
    clean.push({ role: m.role, content: text });
  }

  const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: clean
    })
  });

  if (!apiRes.ok) {
    let detail = "";
    try { detail = (await apiRes.json()).error?.message || ""; } catch (e) {}
    if (apiRes.status === 401) return json({ error: "老師的 API 金鑰失效了，請通知老師檢查。" }, 502);
    if (apiRes.status === 429) return json({ error: "現在使用的人比較多或額度不足，請一分鐘後再試。" }, 502);
    return json({ error: "AI 服務暫時出錯（" + apiRes.status + "）" + detail }, 502);
  }

  const data = await apiRes.json();
  const reply = (data.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  return json({ reply });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

/* ========== 前端頁面 ========== */
const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>塔羅解牌練習室</title>
<style>
  :root{
    --bg:#151021; --panel:#211a33; --panel2:#2a2242;
    --gold:#c9a35c; --gold-soft:#e3c98f; --text:#efe9dc; --muted:#a89bc4;
    --user:#3b2f5c; --bot:#262038; --danger:#e07a7a; --radius:14px;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{
    background:radial-gradient(1200px 800px at 70% -10%, #2c2148 0%, var(--bg) 55%);
    color:var(--text);
    font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;
    display:flex;flex-direction:column;height:100vh;
  }
  header{
    padding:14px 20px;display:flex;align-items:center;gap:12px;
    border-bottom:1px solid rgba(201,163,92,.25);
    background:rgba(21,16,33,.7);backdrop-filter:blur(6px);
  }
  header .moon{font-size:24px}
  header h1{font-size:18px;font-weight:600;letter-spacing:2px;color:var(--gold-soft)}
  header .sub{font-size:12px;color:var(--muted);margin-top:2px}
  header .spacer{flex:1}
  .btn{
    background:transparent;border:1px solid rgba(201,163,92,.5);color:var(--gold-soft);
    padding:7px 14px;border-radius:20px;cursor:pointer;font-size:13px;font-family:inherit;transition:.2s;
  }
  .btn:hover{background:rgba(201,163,92,.15)}
  .btn.primary{background:linear-gradient(135deg,#b08c46,#d8b877);color:#231a0d;border:none;font-weight:600}
  .btn.primary:hover{filter:brightness(1.08)}
  .btn:disabled{opacity:.45;cursor:not-allowed}
  main{flex:1;overflow-y:auto;padding:24px 0 12px}
  .wrap{max-width:760px;margin:0 auto;padding:0 18px}
  .card{
    background:var(--panel);border:1px solid rgba(201,163,92,.2);border-radius:var(--radius);
    padding:22px;margin-bottom:18px;
  }
  .card h2{font-size:16px;color:var(--gold-soft);margin-bottom:4px;letter-spacing:1px}
  .card p.hint{font-size:13px;color:var(--muted);margin-bottom:16px;line-height:1.6}
  .field{margin-bottom:14px}
  .field label{display:block;font-size:13px;color:var(--gold-soft);margin-bottom:6px}
  .field input,.field textarea,.field select{
    width:100%;background:var(--panel2);border:1px solid rgba(201,163,92,.25);
    border-radius:10px;color:var(--text);padding:10px 12px;font-size:14px;font-family:inherit;
    outline:none;resize:vertical;
  }
  .field input:focus,.field textarea:focus,.field select:focus{border-color:var(--gold)}
  .field .note{font-size:12px;color:var(--muted);margin-top:5px;line-height:1.5}
  .msg{display:flex;gap:10px;margin-bottom:16px;align-items:flex-start}
  .msg .avatar{
    width:36px;height:36px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;
    font-size:18px;border:1px solid rgba(201,163,92,.4);background:var(--panel2);
  }
  .msg .bubble{
    padding:12px 16px;border-radius:var(--radius);max-width:82%;line-height:1.75;font-size:15px;
    white-space:pre-wrap;word-break:break-word;
  }
  .msg.bot .bubble{background:var(--bot);border:1px solid rgba(201,163,92,.18);border-top-left-radius:4px}
  .msg.user{flex-direction:row-reverse}
  .msg.user .bubble{background:var(--user);border-top-right-radius:4px}
  .typing span{
    display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--gold);
    margin:0 2px;animation:blink 1.2s infinite;
  }
  .typing span:nth-child(2){animation-delay:.2s}
  .typing span:nth-child(3){animation-delay:.4s}
  @keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}
  footer{
    padding:12px 18px 18px;border-top:1px solid rgba(201,163,92,.2);
    background:rgba(21,16,33,.85);
  }
  .inputrow{max-width:760px;margin:0 auto;display:flex;gap:10px;align-items:flex-end}
  .inputrow textarea{
    flex:1;background:var(--panel2);border:1px solid rgba(201,163,92,.3);border-radius:12px;
    color:var(--text);padding:11px 14px;font-size:15px;font-family:inherit;outline:none;
    min-height:46px;max-height:140px;resize:none;line-height:1.5;
  }
  .inputrow textarea:focus{border-color:var(--gold)}
  .error{
    max-width:760px;margin:8px auto 0;color:var(--danger);font-size:13px;padding:0 4px;
    display:none;line-height:1.5;
  }
  .overlay{
    position:fixed;inset:0;background:rgba(10,7,18,.75);display:none;
    align-items:center;justify-content:center;z-index:50;padding:18px;
  }
  .overlay.show{display:flex}
  .modal{background:var(--panel);border:1px solid rgba(201,163,92,.35);border-radius:var(--radius);
    padding:24px;max-width:440px;width:100%}
  .modal h3{color:var(--gold-soft);font-size:16px;margin-bottom:10px}
  .modal p{font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:14px}
  .modal .row{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}
</style>
</head>
<body>

<header>
  <div class="moon">🔮</div>
  <div>
    <h1>塔羅解牌練習室</h1>
    <div class="sub">與 20 年資歷的安娜老師一起，把你的解讀磨得更亮</div>
  </div>
  <div class="spacer"></div>
  <button class="btn" id="btnNew">開始新練習</button>
  <button class="btn" id="btnKey">🔑 課程密碼</button>
</header>

<main id="main">
  <div class="wrap">
    <div class="card" id="intake">
      <h2>✦ 這一次的牌局</h2>
      <p class="hint">把問卜者的問題、你用的牌陣和抽到的牌填進來，安娜老師會先聽你自己的解讀，再一步步陪你討論。</p>
      <div class="field">
        <label>問卜者的問題</label>
        <input id="fQuestion" placeholder="例：我跟現在的對象有沒有機會走向穩定關係？">
      </div>
      <div class="field">
        <label>使用的牌陣</label>
        <select id="fSpread">
          <option>單張牌</option>
          <option selected>時間之流（過去／現在／未來）</option>
          <option>聖三角（問題／原因／解答）</option>
          <option>二選一牌陣</option>
          <option>關係牌陣（我方／對方／關係現況）</option>
          <option>凱爾特十字</option>
          <option>自訂牌陣（請在下方說明位置意義）</option>
        </select>
      </div>
      <div class="field">
        <label>抽到的牌（含正逆位）</label>
        <textarea id="fCards" rows="3" placeholder="例：過去—聖杯二正位、現在—寶劍三逆位、未來—星星正位"></textarea>
        <div class="note">自訂牌陣的話，請寫清楚每個位置代表什麼。</div>
      </div>
      <div class="field">
        <label>你自己的初步解讀（可先留白，老師會先請你說說看）</label>
        <textarea id="fReading" rows="3" placeholder="寫下你的第一直覺，或留白由老師引導你開始"></textarea>
      </div>
      <button class="btn primary" id="btnStart" style="width:100%;padding:12px">開始討論 ✦</button>
    </div>
    <div id="chat"></div>
  </div>
</main>

<div class="error" id="errBox"></div>

<footer id="footer" style="display:none">
  <div class="inputrow">
    <textarea id="inp" placeholder="回覆安娜老師…（Enter 送出，Shift+Enter 換行）"></textarea>
    <button class="btn primary" id="btnSend">送出</button>
  </div>
</footer>

<div class="overlay" id="keyOverlay">
  <div class="modal">
    <h3>輸入課程密碼</h3>
    <p>請輸入老師發給你的課程密碼，就可以開始練習。密碼只會存在你自己的瀏覽器裡。</p>
    <div class="field">
      <input id="fKey" type="password" placeholder="課程密碼">
    </div>
    <div class="row">
      <button class="btn" id="btnKeyCancel">取消</button>
      <button class="btn primary" id="btnKeySave">確定</button>
    </div>
  </div>
</div>

<script>
var password = "";
var convo = [];
var busy = false;

function loadPw(){ try{ password = localStorage.getItem("tarot_pw") || ""; }catch(e){} }
function savePw(k){ password = k; try{ localStorage.setItem("tarot_pw", k); }catch(e){} }
loadPw();

function $(id){ return document.getElementById(id); }
var chat = $("chat"), mainEl = $("main"), errBox = $("errBox");

function addMsg(role, text){
  var div = document.createElement("div");
  div.className = "msg " + (role === "user" ? "user" : "bot");
  var av = document.createElement("div");
  av.className = "avatar";
  av.textContent = role === "user" ? "🧑‍🎓" : "🌙";
  var b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  div.appendChild(av); div.appendChild(b);
  chat.appendChild(div);
  mainEl.scrollTop = mainEl.scrollHeight;
  return b;
}

function addTyping(){
  var b = addMsg("bot", "");
  b.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  return b;
}

function showError(msg){
  errBox.textContent = msg;
  errBox.style.display = "block";
  setTimeout(function(){ errBox.style.display = "none"; }, 8000);
}

function callApi(){
  return fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: password, messages: convo })
  }).then(function(res){
    return res.json().then(function(data){
      if(!res.ok){
        if(res.status === 401){
          savePw("");
          $("keyOverlay").classList.add("show");
        }
        throw new Error(data.error || ("發生錯誤（" + res.status + "）"));
      }
      return data.reply;
    });
  });
}

function send(userText, onFail){
  if(busy) return;
  if(!password){ $("keyOverlay").classList.add("show"); return; }
  busy = true;
  $("btnSend").disabled = true;
  convo.push({role:"user", content:userText});
  var typing = addTyping();
  callApi().then(function(reply){
    convo.push({role:"assistant", content:reply});
    typing.innerHTML = "";
    typing.textContent = reply;
  }).catch(function(err){
    typing.parentElement.remove();
    convo.pop();
    showError(err.message);
    if(onFail) onFail();
  }).finally(function(){
    busy = false;
    $("btnSend").disabled = false;
    mainEl.scrollTop = mainEl.scrollHeight;
  });
}

$("btnStart").addEventListener("click", function(){
  var q = $("fQuestion").value.trim();
  var spread = $("fSpread").value;
  var cards = $("fCards").value.trim();
  var reading = $("fReading").value.trim();
  if(!q || !cards){ showError("請至少填寫「問卜者的問題」和「抽到的牌」。"); return; }
  if(!password){ $("keyOverlay").classList.add("show"); return; }

  var first = "老師好，我想練習這個牌局：\\n\\n" +
    "【問卜者的問題】" + q + "\\n" +
    "【牌陣】" + spread + "\\n" +
    "【抽到的牌】" + cards;
  first += reading ? ("\\n\\n【我的初步解讀】" + reading) : "\\n\\n我還沒有頭緒，請引導我開始。";

  $("intake").style.display = "none";
  $("footer").style.display = "block";
  convo = [];
  addMsg("user", first);
  send(first, function(){
    $("intake").style.display = "block";
    $("footer").style.display = "none";
    chat.innerHTML = "";
    convo = [];
  });
});

$("btnSend").addEventListener("click", function(){
  var t = $("inp").value.trim();
  if(!t) return;
  $("inp").value = "";
  addMsg("user", t);
  send(t);
});

$("inp").addEventListener("keydown", function(e){
  if(e.key === "Enter" && !e.shiftKey){
    e.preventDefault();
    $("btnSend").click();
  }
});

$("btnNew").addEventListener("click", function(){
  if(convo.length && !confirm("要結束目前的練習、開始新的牌局嗎？")) return;
  convo = [];
  chat.innerHTML = "";
  $("intake").style.display = "block";
  $("footer").style.display = "none";
  ["fQuestion","fCards","fReading"].forEach(function(id){ $(id).value = ""; });
  mainEl.scrollTop = 0;
});

$("btnKey").addEventListener("click", function(){
  $("fKey").value = password;
  $("keyOverlay").classList.add("show");
});
$("btnKeyCancel").addEventListener("click", function(){ $("keyOverlay").classList.remove("show"); });
$("btnKeySave").addEventListener("click", function(){
  var k = $("fKey").value.trim();
  if(!k){ showError("請輸入課程密碼。"); return; }
  savePw(k);
  $("keyOverlay").classList.remove("show");
});

if(!password){
  setTimeout(function(){ $("keyOverlay").classList.add("show"); }, 600);
}
</script>
</body>
</html>`;
