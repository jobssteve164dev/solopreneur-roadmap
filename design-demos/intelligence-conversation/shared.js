const input=document.querySelector('textarea');
const send=document.querySelector('.send');
const log=document.querySelector('[data-log]');
let activeThread='new';
let activeRecent='';
function addMessage(className,text){
  const message=document.createElement('div');message.className='message '+className;message.textContent=text;log.append(message);return message;
}
function sendMessage(value){
  const text=(value||input.value).trim();
  if(!text)return;
  document.querySelector('[data-home]').classList.add('hide');
  document.querySelector('[data-chat]').classList.remove('hide');
  if(!log.dataset.started){
    log.querySelectorAll('.message').forEach(message=>message.remove());
    log.dataset.started='true';
  }
  addMessage('user-message',text);
  let reply='';
  if(document.body.dataset.variant==='decision'){
    reply=text.includes('顺序')?'先确认登录失败的影响范围，再复现和修复。登录恢复后，根据用户对数据导出的需要安排导出功能。':text.includes('比较')?'登录问题影响进入应用，导出影响拿走数据。先确认两边受影响的人数与紧迫程度，再决定优先级。':'登录失败会挡住用户进入应用。先确定影响范围和复现方式，再决定修复顺序；导出功能可以在登录恢复后继续推进。';
  }else if(document.body.dataset.variant==='thread'){
    log.querySelector('.eyebrow').textContent=activeThread==='export'?'议题 · 导出功能什么时候做？':activeThread==='login'?'议题 · 登录问题影响哪些用户？':'新议题';
    reply=activeThread==='export'?'先确认现在是否有人必须导出数据。如果没有迫切需求，可以先把登录问题处理好，再回来定导出的范围。':activeThread==='login'?'我们可以接着确认影响范围：哪些用户无法登录、从什么时候开始、是否有共同的操作路径？':'先说说你想解决的事，以及眼下最难决定的地方。';
  }else{
    reply=activeRecent==='feature'||text.includes('新功能')?'先确认它解决了谁的什么问题，以及是否有人现在就需要。你手里有具体反馈吗？':text.includes('阻碍')?'先列出上线前仍会挡住用户使用的事情，再挑最影响结果的一件处理。现在最明显的阻碍是什么？':'先看登录问题是否让用户无法继续使用，再看导出功能是否有明确的使用时点。你现在掌握哪些反馈？';
  }
  addMessage('answer',reply);input.value='';send.disabled=true;
  log.parentElement.scrollTop=log.parentElement.scrollHeight;
}
document.querySelectorAll('[data-prompt]').forEach(button=>button.addEventListener('click',()=>{
  if(document.body.dataset.variant==='thread')activeThread=button.closest('.thread')?.querySelector('h2')?.textContent.includes('导出')?'export':'login';
  if(document.body.dataset.variant==='conversation'){
    activeRecent='';
    delete log.dataset.started;
    log.querySelector('.chat-context').textContent='当前讨论 · 我的应用';
  }
  input.value=button.dataset.prompt;send.disabled=false;sendMessage();
}));
send.addEventListener('click',()=>sendMessage());
input.addEventListener('input',()=>{send.disabled=!input.value.trim()});
input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage()}});
document.querySelectorAll('[data-back]').forEach(button=>button.addEventListener('click',event=>{event.preventDefault();document.querySelector('[data-chat]').classList.add('hide');document.querySelector('[data-home]').classList.remove('hide');if(document.body.dataset.variant==='thread'){delete log.dataset.started;activeThread='new'}if(document.body.dataset.variant==='conversation'){delete log.dataset.started;log.querySelector('.chat-context').textContent='当前讨论 · 我的应用'}activeRecent=''}));
document.querySelectorAll('.scope button').forEach(button=>button.addEventListener('click',()=>{
  document.querySelectorAll('.scope button').forEach(item=>item.classList.toggle('selected',item===button));
  document.querySelectorAll('.thread').forEach(thread=>thread.classList.toggle('hide',button.textContent!=='全部'&&!thread.textContent.includes(button.textContent)));
}));
document.querySelectorAll('[data-recent]').forEach(button=>button.addEventListener('click',()=>{
  activeRecent=button.dataset.recent.includes('新功能')?'feature':'login';
  log.querySelectorAll('.message').forEach(message=>message.remove());
  log.dataset.started='true';
  log.querySelector('.chat-context').textContent='上次对话 · 我的应用';
  addMessage('user-message',activeRecent==='feature'?'新功能应该现在上线吗？':'先修登录，还是先做导出？');
  addMessage('answer',activeRecent==='feature'?'先确认这个功能解决的问题是否已经明确，以及是否有人现在需要它。':'先查登录失败影响多少用户。如果有人无法进入应用，优先处理登录。');
  document.querySelector('[data-home]').classList.add('hide');
  document.querySelector('[data-chat]').classList.remove('hide');
}));
