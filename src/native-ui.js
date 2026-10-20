/* Local audio and desktop access use narrow main-process IPC; no renderer credentials. */
(() => {
  let live=false, busy=false, conversation=false, speech=null, generation=0, expectedThread=null, turn=null, sending=false;
  const earlyCompletions=new Map();
  let dispatch=null;
  const mic=document.createElement('button');mic.id='voice-button';mic.className='icon-button composer-tool';mic.innerHTML=icon('mic');mic.title='本地听写／连续语音对话';mic.setAttribute('aria-label','语音');mic.setAttribute('aria-pressed','false');
  const desktop=document.createElement('button');desktop.id='desktop-button';desktop.className='icon-button composer-tool';desktop.innerHTML=icon('desktop');desktop.title='电脑控制权限';desktop.setAttribute('aria-label','电脑控制');desktop.setAttribute('aria-pressed','false');
  $('#composer-tools').append(desktop,mic);
  const line=document.createElement('div');line.id='native-status';line.hidden=true;line.setAttribute('role','status');
  const message=document.createElement('span'),interrupt=document.createElement('button'),stop=document.createElement('button');
  interrupt.className=stop.className='small-link';interrupt.textContent='打断回答';stop.textContent='结束语音';line.append(message,interrupt,stop);$('#prompt').after(line);
  function show(text){line.hidden=!text;message.textContent=text||'';mic.setAttribute('aria-label',live?'结束语音':'语音');mic.setAttribute('aria-pressed',String(live));interrupt.hidden=!conversation;stop.hidden=!live;}
  function pause(value){return call('voicePause',{paused:value});}
  function stopAudio(){if(speech){speech.pause();speech.src='';speech=null;}}
  async function end(){generation++;live=false;busy=false;turn=null;expectedThread=null;stopAudio();show('');await call('voiceStop');}
  async function begin(asConversation=false){
    if(live){await end();return;}
    if(state.loading||state.active.has(state.current?.id))throw new Error('当前任务完成后再开始语音');
    if(asConversation&&(!state.cwd||!state.settings.hasKey))throw new Error('请先选择项目并配置模型连接');
    if(asConversation&&($('#prompt').value.trim()||state.files.length))throw new Error('请先发送或清空输入框和附件，再开始连续对话');
    generation++;live=true;busy=false;conversation=asConversation;expectedThread=state.current?.id||null;show('正在启动本地识别…');
    try{await call('voiceStart');}catch(e){live=false;show('');throw e;}
  }
  mic.onclick=action(async()=>{if(live)return end();window.openNativePanel?.();});
  desktop.onclick=()=>window.openNativePanel?.();stop.onclick=action(end);
  interrupt.onclick=action(async()=>{
    generation++;stopAudio();await call('voiceInterrupt');let running=turn;
    if(!running&&dispatch){const result=await dispatch;if(result)running={threadId:result.threadId,id:result.turn.id};}
    if(running?.threadId)await call('interrupt',{threadId:running.threadId});
    turn=null;busy=false;await pause(false);show('已打断，可以继续说话');
  });
  const plain=text=>text.replace(/```[\s\S]*?```/g,'（代码见屏幕）').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/https?:\/\/\S+/g,'').replace(/[#*_`>|]/g,'').slice(0,1800);
  async function completed(p){
    if(!live||!conversation||!turn||turn.id!==p.turn.id||turn.threadId!==p.threadId)return;
    turn=null;const currentGeneration=generation;
    try{
      const items=state.turns.get(p.turn.id)?.items||p.turn.items||[];
      const agents=items.filter(i=>i.type==='agentMessage');
      const selected=agents.filter(i=>i.phase==='final_answer');
      const text=plain((selected.length?selected:agents.slice(-1)).map(i=>i.text||'').join('\n'));
      if(p.turn.status==='completed'&&text){
        show('正在准备朗读…');const audio=await call('voiceSpeak',{text});if(!live||generation!==currentGeneration)return;
        show('正在朗读 · 可点击打断');speech=new Audio(audio);
        await new Promise((resolve,reject)=>{const player=speech;player.onended=resolve;player.onerror=()=>reject(new Error('系统音频播放失败'));player.onpause=resolve;player.play().catch(reject);});
      }
    }catch(e){if(generation===currentGeneration)toast(errorText(e));}
    finally{if(live&&generation===currentGeneration){busy=false;stopAudio();await pause(false);show('正在听 · 说完会自动发送');}}
  }
  window.desk.onEvent(event=>{
    const p=event.params||{};
    if(event.method==='desk/desktop'){desktop.setAttribute('aria-label',p.enabled?'电脑控制已开启':'电脑控制');desktop.setAttribute('aria-pressed',String(!!p.enabled));return;}
    if(event.method==='turn/completed'){
      if(sending){earlyCompletions.set(p.turn.id,p);if(earlyCompletions.size>16)earlyCompletions.delete(earlyCompletions.keys().next().value);}
      else completed(p).catch(e=>toast(errorText(e)));
    }
    if(event.method!=='desk/voice')return;
    if(p.type==='stopped'){if(live){live=false;generation++;busy=false;stopAudio();show('');}return;}
    if(!live)return;
    if(p.type==='error'){toast(p.message);end().catch(()=>{});return;}
    if(p.type==='ready')show(conversation?'正在听 · 说完会自动发送':'正在听 · 识别文字放入输入框');
    if(p.type==='partial'&&!busy)show(p.text||'正在听…');
    if(p.type==='final'&&p.text&&!busy){
      if(!conversation){$('#prompt').value+=($('#prompt').value?'\n':'')+p.text;sizePrompt();show('正在听 · 识别文字放入输入框');return;}
      busy=true;const currentGeneration=generation;
      (async()=>{
        if($('#prompt').value.trim()||state.files.length)throw new Error('输入框有其他内容，语音已停止，内容已保留');
        await pause(true);if(!live||generation!==currentGeneration)return;
        $('#prompt').value=p.text;sizePrompt();show('正在回答…');sending=true;earlyCompletions.clear();let result;
        try{dispatch=sendMessage();result=await dispatch;}finally{sending=false;dispatch=null;}
        if(!live||generation!==currentGeneration)return;
        if(result?.turn?.id){
          turn={threadId:result.threadId,id:result.turn.id};expectedThread=result.threadId;
          const early=earlyCompletions.get(turn.id);earlyCompletions.clear();
          if(early)await completed(early);
        }else{busy=false;await pause(false);show('正在听 · 说完会自动发送');}
      })().catch(e=>{toast(errorText(e));end().catch(()=>{});});
    }
  });
  // Changing chats ends the audio session; no late transcript can go into a different chat.
  setInterval(()=>{if(live&&expectedThread&&state.current?.id!==expectedThread)end().catch(()=>{});},300);
  window.addEventListener('beforeunload',()=>{stopAudio();call('voiceStop').catch(()=>{});});
  window.renderNativePanel=async target=>{
    const info=await call('nativeStatus');
    const section=document.createElement('section');section.className='work-block';
    const h=document.createElement('h3');h.textContent='电脑与语音';section.append(h);
    const status=document.createElement('p');status.className='muted';section.append(status);
    const setStatus=text=>{status.textContent=text;};
    const add=(label,fn)=>{const b=document.createElement('button');b.className='secondary';b.textContent=label;b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){setStatus(errorText(e));}finally{b.disabled=false;}};return b;};
    const actions=document.createElement('div');actions.className='work-actions';
    setStatus(info.modules.pyautogui&&info.modules.vosk&&info.modules.sounddevice&&info.model?'本地依赖已就绪':'需要安装独立依赖及42 MB中文识别模型');
    actions.append(add('安装本地依赖',async()=>{setStatus('正在安装与下载模型，请稍候…');await call('nativeSetup');setStatus('本地依赖已就绪');}));
    section.append(actions);
    const voiceTitle=document.createElement('h3');voiceTitle.textContent='语音';
    const voiceNote=document.createElement('p');voiceNote.className='muted';voiceNote.textContent='声音在本机识别，连续对话将文字发送给当前中转模型并用系统声音朗读。回答时暂停收音，点「打断回答」可继续说话；不保存录音。';
    const voiceActions=document.createElement('div');voiceActions.className='work-actions';voiceActions.append(add('开始听写',async()=>{await begin(false);$('#workspace-dialog').close();}),add('连续语音对话',async()=>{await begin(true);$('#workspace-dialog').close();}),add('结束语音',end));section.append(voiceTitle,voiceNote,voiceActions);
    const controlTitle=document.createElement('h3');controlTitle.textContent='电脑控制';
    const controlNote=document.createElement('p');controlNote.className='muted';controlNote.textContent='可查看主屏并操作鼠标、键盘。屏幕截图会发送给当前中转模型。开启30分钟后到期，重开程序默认关闭；将鼠标移到屏幕角落可触发输入急停。';
    const select=document.createElement('select');select.id='desktop-access-mode';select.setAttribute('aria-label','电脑控制确认方式');select.innerHTML='<option value="ask">每次操作确认</option><option value="full">本次免逐次确认</option>';
    const controls=document.createElement('div');controls.className='work-actions';controls.append(select,add('开启电脑控制',async()=>{const result=await call('desktopAccess',{mode:select.value});setStatus(`电脑控制已开启，${new Date(result.expiresAt).toLocaleTimeString()}到期`);}),add('停止电脑控制',async()=>{await call('desktopAccess',{mode:'off'});setStatus('电脑控制已关闭');}),add('立即停止全部',async()=>{await end();await call('nativeStop');setStatus('电脑控制与语音已停止');}));
    section.append(controlTitle,controlNote,controls);
    const help=document.createElement('p');help.className='muted';help.textContent=info.hotkey?'紧急停止：Ctrl / ⌘ + Alt + Esc，或托盘菜单「停止电脑控制与语音」。':'可随时使用托盘菜单「停止电脑控制与语音」。';section.append(help);
    if(info.platform==='darwin'){const p=document.createElement('p');p.className='muted';p.textContent=`系统权限：屏幕${info.permissions.screen}；麦克风${info.permissions.microphone}；辅助功能${info.permissions.accessibility?'已允许':'待允许'}。请在 macOS「系统设置 → 隐私与安全性」授权 Codex Desk；Python 辅助进程若单独列出，也需授权。`;section.append(p);}
    target.append(section);
  };
})();
