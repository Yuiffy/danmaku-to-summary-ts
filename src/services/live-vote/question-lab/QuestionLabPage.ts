/** Self-contained local UI. All question/evidence output is rendered with textContent. */
export function questionLabPage(nonce: string, token: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>鹿饼 · 直播记忆</title><style nonce="${nonce}">
:root{color-scheme:light;--ink:#203832;--muted:#718179;--line:#dce5dd;--green:#236950;--paper:#f6f7f2}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.65 system-ui,"Microsoft YaHei",sans-serif}
button,input,textarea,select{font:inherit}button{cursor:pointer}button:disabled{cursor:wait;opacity:.55}
.shell{display:grid;grid-template-columns:270px minmax(0,1fr);min-height:100vh}aside{padding:38px 26px;background:#eaf0e7;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:26px}
.brand{font-size:26px;font-weight:700;letter-spacing:.04em}.brand small{display:block;font-size:12px;letter-spacing:.18em;color:var(--muted);font-weight:500;margin-top:3px}
.tag{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--green)}.dot{width:7px;height:7px;background:#419168;border-radius:50%}
label{display:block;font-size:12px;color:var(--muted);margin-bottom:7px}select,input{width:100%;padding:10px;border:1px solid #cbd8ce;background:#f8faf6;border-radius:8px;color:var(--ink)}
.hint{font-size:12px;color:var(--muted)}.side-note{margin-top:auto;border-top:1px solid #ccd9ce;padding-top:20px}a{color:var(--green)}
main{max-width:1040px;width:100%;padding:38px 54px 26px;margin:auto;display:flex;flex-direction:column;min-height:100vh}
header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding-bottom:20px}.subtle{background:transparent;border:1px solid var(--line);color:var(--muted);padding:6px 12px;border-radius:7px;font-size:12px}
.intro{padding:68px 0 36px}.eyebrow{font-size:12px;letter-spacing:.16em;color:var(--green)}h1{font-size:clamp(26px,3vw,38px);line-height:1.35;font-weight:600;margin:14px 0}.intro p{color:var(--muted);margin:0}
.examples{display:flex;gap:10px;flex-wrap:wrap;margin-top:24px}.examples button{border:1px solid var(--line);border-radius:30px;padding:8px 15px;background:white;color:var(--ink);font-size:13px}
#messages{flex:1;display:flex;flex-direction:column;gap:24px;padding-bottom:24px}.message{max-width:100%;overflow-wrap:anywhere;white-space:pre-wrap}.question{align-self:flex-end;background:#e6eee5;padding:14px 19px;border-radius:18px 18px 3px 18px;max-width:85%}.answer{border-left:3px solid #8dac92;padding:2px 0 2px 20px}.answer strong{display:block;font-size:12px;color:var(--green);margin-bottom:8px;letter-spacing:.06em}.error{color:#9b4c32}
.meta{color:var(--muted);font-size:12px;margin-top:12px}.clue{border-top:1px solid var(--line);margin-top:13px;padding-top:11px;font-size:13px;white-space:pre-wrap}.clue time{display:block;color:var(--green);font-size:12px;margin-bottom:4px}
details{margin-top:15px}summary{cursor:pointer;font-size:13px;color:var(--green)}.controls{display:flex;gap:18px;align-items:center;margin-bottom:12px}.controls label{margin:0;display:flex;gap:5px;align-items:center;white-space:nowrap}.controls input{width:auto;accent-color:var(--green)}
.composer{position:sticky;bottom:0;background:var(--paper);padding-top:12px}.box{border:1px solid #b6caba;border-radius:14px;background:#fff;padding:14px}textarea{resize:vertical;min-height:76px;max-height:200px;width:100%;border:0;outline:0;background:transparent;color:var(--ink)}textarea:focus-visible{outline:2px solid #b6caba;outline-offset:4px}.actions{display:flex;align-items:center;justify-content:space-between;gap:15px}.send{border:0;background:var(--green);color:white;padding:9px 22px;border-radius:9px}.cancel{background:white;color:var(--muted);border:1px solid var(--line);border-radius:8px;padding:8px 15px}#status{font-size:12px;color:var(--muted)}.foot{font-size:11px;color:var(--muted);padding-top:8px;text-align:center}
.filter{margin-top:14px}#search-options[hidden]{display:none}button:hover{filter:brightness(.97)}button:focus-visible,summary:focus-visible{outline:2px solid var(--green);outline-offset:3px}
@media(max-width:720px){.shell{grid-template-columns:1fr}aside{padding:18px 22px;gap:14px;border-right:0;border-bottom:1px solid var(--line)}.brand{font-size:20px}.brand small,.side-note{display:none}main{padding:22px;min-height:75vh}.intro{padding:34px 0 26px}header{padding-bottom:14px}.controls{gap:12px}}
</style></head><body><div class="shell"><aside>
<div class="brand">鹿饼<small>LIVESTREAM MEMORIES</small></div><div class="tag"><span class="dot"></span>本机问答实验室</div>
<div><label for="room">默认直播间</label><select id="room" disabled><option>加载直播间…</option></select><p class="hint">问题点名其他主播时查对应房间；比较时写明双方，最多 3 个房间。</p></div>
<div id="search-options" hidden><label for="terms">关键词（用逗号分隔，最多 5 个）</label><input id="terms" placeholder="例如：提督，礼物">
<div class="filter"><label for="date">日期范围（可留空）</label><input id="date" placeholder="2026 或 2026-10 或 2026-10-06"></div>
<div class="filter"><label for="kind">资料类型</label><select id="kind"><option value="all">全部资料（含舰礼档案）</option><option value="subtitle">字幕与舰礼档案</option><option value="danmaku">只看弹幕</option></select></div></div>
<div class="side-note hint">从直播记录里找答案。<br>每条问题独立检索，请写出完整问题。<br><br>结果只显示在这里，不会发送到直播间或动态评论区。</div>
</aside><main><header><span>直播记忆 · 问答测试</span><button id="clear" class="subtle">清空对话</button></header>
<section class="intro" id="intro"><div class="eyebrow">ASK THE ARCHIVE</div><h1>那些直播里聊过的事。</h1><p>问一个问题，看看记录中的答案与线索。</p><div class="examples"><button>这个月的舰礼是什么？</button><button>岁己和七海以前聊过哪些喜欢的游戏？</button></div></section>
<div id="messages" role="log" aria-live="polite"></div>
<form id="form" class="composer"><div class="controls"><label><input type="radio" name="mode" value="ask" checked>问鹿饼</label><label><input type="radio" name="mode" value="search">只查证据</label></div>
<div class="box"><label for="question" class="hint">你的问题</label><textarea id="question" maxlength="120" placeholder="比如：这个月的提督礼物是什么？" required></textarea><div class="actions"><span id="status" role="status">Enter 提问 · Shift + Enter 换行</span><div><button id="cancel" type="button" class="cancel" hidden>停止查询</button> <button id="send" class="send" disabled>查询 →</button></div></div></div><div class="foot">问鹿饼：AI 整理答案与证据 · 只查证据：直接查看原文，不生成结论</div></form>
</main></div><script nonce="${nonce}">
const token=${JSON.stringify(token)},byId=id=>document.getElementById(id),form=byId('form'),messages=byId('messages');
let controller;
function element(tag,text,cls){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el}
function appendQuestion(text,room){const node=element('div',room+' · '+text,'message question');messages.append(node)}
function evidence(parent,clue){const row=element('div',undefined,'clue');const kind=clue.kind==='gift-catalog'?'舰礼档案 · 礼物所属月 '+clue.catalogMonth:clue.kind==='subtitle'?'录像字幕':clue.kind==='highlight'?'精选摘要（粗略线索）':clue.kind==='clip-subtitle'?'切片字幕（切片内时间）':'观众弹幕';row.append(element('time',(clue.roomName||clue.roomId||'')+' · '+(clue.date||'日期不详')+' '+clue.time+' · '+kind));row.append(element('div',clue.excerpt));parent.append(row)}
function finish(){controller=undefined;byId('send').disabled=false;byId('cancel').hidden=true;byId('room').disabled=false;byId('clear').disabled=false;byId('status').textContent='每次独立检索 · 最长等待 90 秒';}
document.querySelectorAll('[name=mode]').forEach(input=>input.addEventListener('change',()=>{byId('search-options').hidden=document.querySelector('[name=mode]:checked').value!=='search'}));
document.querySelectorAll('.examples button').forEach(button=>button.addEventListener('click',()=>{byId('question').value=button.textContent;byId('question').focus()}));
byId('clear').addEventListener('click',()=>{messages.replaceChildren();byId('intro').hidden=false});
byId('cancel').addEventListener('click',()=>controller?.abort());
byId('question').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();form.requestSubmit()}});
form.addEventListener('submit',async event=>{
 event.preventDefault();if(controller)return;
 const question=byId('question').value.replace(/\\s+/g,' ').trim(),roomId=byId('room').value;if(!question||!roomId)return;
 const mode=document.querySelector('[name=mode]:checked').value,payload={roomId,question};
 if(mode==='search'){const terms=byId('terms').value.split(/[,，]/).map(x=>x.trim()).filter(Boolean);if(terms.length)payload.terms=terms;payload.date=byId('date').value.trim()||null;payload.kind=byId('kind').value;payload.expandTop=2;}
 controller=new AbortController();byId('send').disabled=true;byId('cancel').hidden=false;byId('room').disabled=true;byId('clear').disabled=true;byId('intro').hidden=true;byId('status').textContent='正在查询直播记录…';
 appendQuestion(question,byId('room').selectedOptions[0].textContent);byId('question').value='';
 const reply=element('div',undefined,'message answer');reply.append(element('strong','鹿饼'));const body=element('div','正在查找相关记录…');reply.append(body);messages.append(reply);reply.scrollIntoView({block:'nearest',behavior:'smooth'});
 try{
  const response=await fetch('/api/'+mode,{method:'POST',headers:{'Content-Type':'application/json','X-Lab-Token':token},body:JSON.stringify(payload),signal:controller.signal});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'查询失败，请稍后重试');
  if(mode==='ask'){body.textContent=data.result.answer;const clues=data.result.clues||[];clues.forEach(clue=>evidence(reply,clue));}
  else{body.textContent=data.hits.length?'找到 '+data.hits.length+' 条相关记录。以下是检索证据，请结合上下文判断。':'当前检索范围内没有命中，可以换关键词或日期再试。';
   data.hits.forEach(hit=>{evidence(reply,hit);const cues=hit.expanded?.context||hit.context;if(cues?.length){const details=element('details');details.append(element('summary','查看上下文'));details.append(element('div',cues.map(c=>c.time+' '+c.text).join('\\n'),'clue'));reply.append(details)}});
   reply.append(element('div','查询房间：'+(data.searchedRooms||[]).map(room=>room.name).join('、')+' · 已索引字幕 '+data.indexedFiles+' 份 · '+(data.indexComplete?'索引已完成':'索引尚未完整或不可用')+(data.embeddingStatus==='unavailable'?' · 本次使用关键词检索':''),'meta'));
  }
  reply.append(element('div',(data.elapsedMs/1000).toFixed(1)+' 秒 · 结果仅供核对，ASR 字幕可能有误','meta'));
 }catch(error){body.textContent=error.name==='AbortError'?'已取消本次查询。':error.message;body.classList.add('error')}
 finally{finish()}
});
fetch('/api/rooms',{headers:{'X-Lab-Token':token}}).then(r=>{if(!r.ok)throw new Error();return r.json()}).then(data=>{
 const select=byId('room');select.replaceChildren();data.rooms.forEach(room=>{const option=element('option',room.name+' · '+room.roomId);option.value=room.roomId;select.append(option)});
 if(data.rooms.some(room=>room.roomId==='25788785'))select.value='25788785';select.disabled=false;byId('send').disabled=!data.rooms.length;
}).catch(()=>{byId('status').textContent='无法加载直播间，请检查本机服务配置。'});
</script></body></html>`;
}
