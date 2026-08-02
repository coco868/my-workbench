(function(){
  const KEY='myWorkbench_v1';
  const PALETTE=['#F6A5C0','#9CC9E8','#9BD9B0','#E8CE9C','#C3A5E8','#E89C9C','#9CD9D2','#D2D99C'];
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const pad = n => String(n).padStart(2,'0');
  const ymd = (y,m,d)=> `${y}-${pad(m+1)}-${pad(d)}`;
  const todayStr = ()=>{ const n=new Date(); return ymd(n.getFullYear(),n.getMonth(),n.getDate()); };

  let state;
  let activeTab='habit';

  // ---------- 体重体脂（独立 Supabase 表 body_metrics） ----------
  const BM_KEY='myWorkbench_body_v1';
  const BM_USER='shared';
  let bodyMetrics = {};   // { 'YYYY-MM-DD': {weight:Number, bodyFat:Number} }
  let bmRange = 30;       // 7/30/90/'all'
  let rtBodyChannel=null;
  function loadBodyLocal(){ try{ bodyMetrics = JSON.parse(localStorage.getItem(BM_KEY))||{}; }catch(e){ bodyMetrics={}; } }
  function saveBodyLocal(){ localStorage.setItem(BM_KEY, JSON.stringify(bodyMetrics)); }

  // ---------- Supabase 云端同步（不登录单用户模式） ----------
  const CFG_KEY='wbSupabaseCfg';
  const ROW_ID='app';
  let supabase=null, cloudEnabled=false, cloudError=null, lastSyncAt=0, localSaveAt=0, rtChannel=null;
  function getCfg(){ try{ return JSON.parse(localStorage.getItem(CFG_KEY))||{}; }catch(e){ return {}; } }
  function setCfg(c){ localStorage.setItem(CFG_KEY, JSON.stringify(c)); }
  function loadSupabaseSDK(){
    if(window.supabase) return Promise.resolve();
    const tryLoad = (src)=> new Promise((res,rej)=>{
      const s=document.createElement('script');
      s.src=src; s.async=true;
      s.onload=()=>res();
      s.onerror=()=>rej(new Error('load fail: '+src));
      document.head.appendChild(s);
    });
    // 优先加载本地打包的 SDK（手机/离线更稳定），失败再回退 CDN
    return tryLoad('./supabase.min.js').catch(()=> tryLoad('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'));
  }
  async function initCloud(){
    const c=getCfg();
    if(!(c && c.url && c.url.indexOf('http')===0 && c.key && c.key.length>20)){ cloudEnabled=false; return; }
    try{
      await loadSupabaseSDK();
      supabase = window.supabase.createClient(c.url, c.key);
      cloudEnabled = true; cloudError=null;
    }catch(e){ supabase=null; cloudEnabled=false; cloudError='Supabase SDK 加载失败，请检查网络（国内访问该 CDN 可能受限）'; }
  }

  // ---------- 备份：IndexedDB 句柄 + File System Access ----------
  const DB_NAME='wbBackup', STORE='handles';
  const fsSupported = ('showSaveFilePicker' in window);
  function idbOpen(){
    return new Promise((res,rej)=>{
      const r=indexedDB.open(DB_NAME,1);
      r.onupgradeneeded=()=>{ r.result.createObjectStore(STORE); };
      r.onsuccess=()=>res(r.result);
      r.onerror=()=>rej(r.error);
    });
  }
  async function idbGet(key){
    const db=await idbOpen();
    return new Promise((res,rej)=>{
      const tx=db.transaction(STORE,'readonly');
      const rq=tx.objectStore(STORE).get(key);
      rq.onsuccess=()=>res(rq.result);
      rq.onerror=()=>rej(rq.error);
    });
  }
  async function idbSet(key,val){
    const db=await idbOpen();
    return new Promise((res,rej)=>{
      const tx=db.transaction(STORE,'readwrite');
      tx.objectStore(STORE).put(val,key);
      tx.oncomplete=()=>res();
      tx.onerror=()=>rej(tx.error);
    });
  }
  async function writeBackup(data){
    const h=await idbGet('backupHandle');
    if(!h) return;
    const w=await h.createWritable();
    await w.write(JSON.stringify({ state:data.state, bodyMetrics:data.bodyMetrics },null,2));
    await w.close();
  }
  async function readBackup(h){
    const f=await h.getFile();
    return JSON.parse(await f.text());
  }
  let backupTimer=null;
  function scheduleBackup(){
    if(!fsSupported) return;
    clearTimeout(backupTimer);
    backupTimer=setTimeout(()=>{ writeBackup({ state, bodyMetrics }).catch(()=>{}); }, 500);
  }

  // ---------- 状态持久化 ----------
  function load(){
    try{
      const s = JSON.parse(localStorage.getItem(KEY));
      if(s) return Object.assign(defaultState(), s);
    }catch(e){}
    return defaultState();
  }
  function defaultState(){
    const now=new Date();
    return {
      habitDefaults:{ wake:'07:30', sleep:'23:00' },
      customHabits:[ {name:'喝水8杯',color:PALETTE[0]}, {name:'冥想10分钟',color:PALETTE[1]} ],
      dayRecords:{}, tasks:[], questions:{}, reviews:{},
      viewYear: now.getFullYear(), viewMonth: now.getMonth()
    };
  }
  function save(){
    localStorage.setItem(KEY, JSON.stringify(state));
    scheduleBackup();
    if(cloudEnabled) scheduleCloud();
  }
  let cloudTimer=null;
  function scheduleCloud(){
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(()=>{ saveCloud().catch(()=>{}); }, 400);
  }
  async function saveCloud(){
    if(!supabase) return;
    try{
      const ts = new Date().toISOString();
      const { error } = await supabase.from('workbench_state').upsert({ id: ROW_ID, data: state, updated_at: ts });
      if(error) throw error;
      localSaveAt = ts; lastSyncAt = ts; cloudError=null;
    }catch(e){ cloudError = (e&&e.message)||String(e); }
    updateCloudStatus();
  }
  async function loadFromCloud(){
    if(!supabase) return false;
    try{
      const { data, error } = await supabase.from('workbench_state').select('*').eq('id', ROW_ID).maybeSingle();
      if(error) throw error;
      if(data && data.data){
        state = Object.assign(defaultState(), data.data);
        localStorage.setItem(KEY, JSON.stringify(state));
        lastSyncAt = data.updated_at || new Date().toISOString();
        cloudError=null;
        return true;
      }
    }catch(e){ cloudError = (e&&e.message)||String(e); }
    return false;
  }
  function subscribeRealtime(){
    if(!supabase) return;
    try{
      rtChannel = supabase.channel('workbench-state-'+ROW_ID)
        .on('postgres_changes', { event:'*', schema:'public', table:'workbench_state', filter:`id=eq.${ROW_ID}` },
          async ()=>{
            try{
              const { data } = await supabase.from('workbench_state').select('*').eq('id', ROW_ID).maybeSingle();
              if(data && data.data){
                const rt = data.updated_at ? new Date(data.updated_at).getTime() : 0;
                if(localSaveAt && rt <= new Date(localSaveAt).getTime()) return; // 忽略自身回环
                state = Object.assign(defaultState(), data.data);
                localStorage.setItem(KEY, JSON.stringify(state));
                lastSyncAt = data.updated_at || new Date().toISOString();
                bootRender();
                toast('已同步云端最新数据');
              }
            }catch(e){}
          })
        .subscribe();
    }catch(e){}
  }
  function disconnectRealtime(){
    if(rtChannel && supabase){ try{ supabase.removeChannel(rtChannel); }catch(e){} rtChannel=null; }
  }

  // ---------- 体重体脂：独立表 body_metrics 的云端同步 ----------
  async function loadBodyFromCloud(){
    if(!supabase) return;
    try{
      const { data, error } = await supabase.from('body_metrics').select('*').eq('user_id', BM_USER);
      if(error) throw error;
      const map={};
      (data||[]).forEach(r=>{ map[r.date]={ weight:+r.weight, bodyFat:+r.body_fat }; });
      bodyMetrics = map; saveBodyLocal(); cloudError=null;
    }catch(e){ cloudError=(e&&e.message)||String(e); }
  }
  async function upsertBodyRow(date, weight, bodyFat){
    if(!supabase) return;
    try{ const { error } = await supabase.from('body_metrics').upsert({ user_id:BM_USER, date, weight, body_fat:bodyFat }, { onConflict:'user_id,date' }); if(error) throw error; }catch(e){}
  }
  async function deleteBodyRow(date){
    if(!supabase) return;
    try{ const { error } = await supabase.from('body_metrics').delete().eq('user_id', BM_USER).eq('date', date); if(error) throw error; }catch(e){}
  }
  function subscribeBodyRealtime(){
    if(!supabase) return;
    try{
      rtBodyChannel = supabase.channel('body-metrics-'+BM_USER)
        .on('postgres_changes', { event:'*', schema:'public', table:'body_metrics' },
          async ()=>{
            try{
              const { data } = await supabase.from('body_metrics').select('*').eq('user_id', BM_USER);
              const map={}; (data||[]).forEach(r=>{ map[r.date]={ weight:+r.weight, bodyFat:+r.body_fat }; });
              bodyMetrics = map; saveBodyLocal();
              if(activeTab==='body'){ renderBodyChart(); renderBodyList(); }
            }catch(e){}
          })
        .subscribe();
    }catch(e){}
  }
  function disconnectBodyRealtime(){
    if(rtBodyChannel && supabase){ try{ supabase.removeChannel(rtBodyChannel); }catch(e){} rtBodyChannel=null; }
  }

  function updateCloudStatus(){
    const el=$('#cloudStatus'); if(!el) return;
    if(!cloudEnabled){ el.textContent='未连接云端，当前为本地模式（数据仅存本机）。'; el.className='backup-status sync-off'; return; }
    if(cloudError){ el.textContent='云端同步出错：'+cloudError+'（已保留本地数据）'; el.className='backup-status sync-err'; return; }
    const t = lastSyncAt ? new Date(lastSyncAt).toLocaleString('zh-CN') : '—';
    el.textContent='已连接云端 · 最后同步：'+t; el.className='backup-status sync-ok';
  }

  // ---------- Tabs ----------
  $$('.tabs button').forEach(b=>b.addEventListener('click',()=>{
    $$('.tabs button').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    const t=b.dataset.tab;
    activeTab=t;
    ['habit','study','body','data'].forEach(s=>{ $('#tab-'+s).classList.toggle('hidden', s!==t); });
  }));

  // ---------- Header date ----------
  (function(){
    const now=new Date();
    const w=['日','一','二','三','四','五','六'][now.getDay()];
    $('#todayStr').textContent = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 星期${w}`;
  })();

  // ---------- Habit defaults ----------
  $('#saveDefaults').addEventListener('click',()=>{
    state.habitDefaults.wake = $('#defWake').value || '07:30';
    state.habitDefaults.sleep = $('#defSleep').value || '23:00';
    save(); renderCalendar(); toast('已保存作息目标');
  });

  // ---------- Custom habits ----------
  $('#addHabit').addEventListener('click',()=>{
    const v=$('#newHabit').value.trim();
    if(!v) return;
    state.customHabits.push({name:v, color:PALETTE[state.customHabits.length%PALETTE.length]});
    $('#newHabit').value='';
    save(); renderHabitChips(); renderCalendar();
  });
  function renderHabitChips(){
    const box=$('#habitChips'); box.innerHTML='';
    state.customHabits.forEach((h,i)=>{
      const el=document.createElement('span');
      el.className='chip';
      el.style.background=h.color+'33';
      el.style.borderColor=h.color;
      el.innerHTML=`<i style="background:${h.color}"></i>${escapeHtml(h.name)}<button data-i="${i}" class="chip-del">×</button>`;
      box.appendChild(el);
    });
    $$('.chip-del').forEach(b=>b.addEventListener('click',()=>{
      const i=+b.dataset.i;
      state.customHabits.splice(i,1);
      save(); renderHabitChips(); renderCalendar();
    }));
  }

  // ---------- Calendar ----------
  $('#prevMonth').addEventListener('click',()=>{ shiftMonth(-1); });
  $('#nextMonth').addEventListener('click',()=>{ shiftMonth(1); });
  function shiftMonth(d){
    let m=state.viewMonth+d, y=state.viewYear;
    if(m<0){m=11;y--;} if(m>11){m=0;y++;}
    state.viewMonth=m; state.viewYear=y; renderCalendar();
  }
  function toMin(hm){ const [h,m]=hm.split(':').map(Number); return h*60+m; }
  function sleepMet(actual,target){
    if(!actual||!target) return false;
    const a=toMin(actual), t=toMin(target);
    const aa = (a<720)? a+1440 : a; // 把凌晨(0-12点)视为次日，便于跨午夜比较
    return aa>=t;
  }
  function renderCalendar(){
    const y=state.viewYear, m=state.viewMonth;
    $('#calTitle').textContent = `${y}年 ${m+1}月`;
    const grid=$('#calGrid'); grid.innerHTML='';
    const first=new Date(y,m,1).getDay();
    const days=new Date(y,m+1,0).getDate();
    const prevDays=new Date(y,m,0).getDate();
    const cells=[];
    for(let i=first-1;i>=0;i--) cells.push({d:prevDays-i, other:true});
    for(let d=1;d<=days;d++) cells.push({d, m, y, other:false});
    while(cells.length%7!==0){ const last=cells[cells.length-1]; cells.push({d:last.d+1, other:true}); }
    cells.forEach(c=>{
      const dateStr = c.other ? '' : ymd(c.y, c.m, c.d);
      const rec = c.other ? null : state.dayRecords[dateStr];
      const cell=document.createElement('div');
      cell.className='cal-cell'+(c.other?' other':'');
      let cls='';
      if(rec && rec.wake && rec.sleep){
        const tw = rec.targetWake||state.habitDefaults.wake;
        const ts = rec.targetSleep||state.habitDefaults.sleep;
        const wakeOk = toMin(rec.wake) <= toMin(tw);                 // 实际起床 ≤ 目标起床
        const sleepOk = sleepMet(rec.sleep, ts);                     // 实际睡觉 ≥ 目标睡觉（跨午夜感知）
        cls = (wakeOk && sleepOk) ? 'met' : 'unmet';                 // 双达标=绿；已记录但未达标=橙
      }
      if(cls) cell.classList.add(cls);
      let dots='';
      if(rec && rec.custom){
        state.customHabits.forEach(h=>{
          if(rec.custom[h.name]) dots+=`<span class="dot" style="background:${h.color}"></span>`;
        });
      }
      cell.innerHTML=`<span class="cd">${c.d}</span><div class="dots">${dots}</div>`;
      if(!c.other) cell.addEventListener('click',()=>openDay(dateStr));
      grid.appendChild(cell);
    });
  }

  // ---------- Day modal ----------
  let curDate=null;
  function openDay(dateStr){
    curDate=dateStr;
    const rec=state.dayRecords[dateStr]||{};
    $('#dmTitle').textContent = dateStr+' 打卡';
    $('#dmTWake').value = rec.targetWake||state.habitDefaults.wake;
    $('#dmTSleep').value = rec.targetSleep||state.habitDefaults.sleep;
    $('#dmWake').value = rec.wake||'';
    $('#dmSleep').value = rec.sleep||'';
    const hb=$('#dmHabits'); hb.innerHTML='';
    if(state.customHabits.length===0){ hb.innerHTML='<p class="empty">暂无自定义习惯，可在上方添加</p>'; }
    state.customHabits.forEach(h=>{
      const row=document.createElement('label');
      row.className='dm-habit';
      const checked = rec.custom && rec.custom[h.name] ? 'checked':'';
      row.innerHTML=`<input type="checkbox" data-h="${escapeHtml(h.name)}" ${checked}><i style="background:${h.color}"></i>${escapeHtml(h.name)}`;
      hb.appendChild(row);
    });
    $('#dayModal').classList.remove('hidden');
  }
  $('#dayModal').addEventListener('click',e=>{ if(e.target.id==='dayModal') closeDay(); });
  function closeDay(){ $('#dayModal').classList.add('hidden'); curDate=null; }
  $('#dmSave').addEventListener('click',()=>{
    if(!curDate) return;
    const custom={};
    $$('#dmHabits input[type=checkbox]').forEach(cb=>{ custom[cb.dataset.h]=cb.checked; });
    state.dayRecords[curDate]={ targetWake:$('#dmTWake').value, targetSleep:$('#dmTSleep').value,
      wake:$('#dmWake').value, sleep:$('#dmSleep').value, custom };
    save(); closeDay(); renderCalendar(); toast('已保存');
  });
  $('#dmDelete').addEventListener('click',()=>{
    if(curDate){ delete state.dayRecords[curDate]; save(); closeDay(); renderCalendar(); toast('已删除记录'); }
  });

  // ---------- Learning tasks ----------
  $('#addTask').addEventListener('click',()=>{
    const title=$('#newTaskTitle').value.trim();
    if(!title) return;
    const start=$('#newTaskStart').value || todayStr();
    state.tasks.push({ id:Date.now()+'', title, start, due:$('#newTaskDue').value||'', progress:0, checkins:{} });
    $('#newTaskTitle').value=''; $('#newTaskStart').value=''; $('#newTaskDue').value='';
    save(); renderTasks();
  });
  function daysBetween(a,b){ // a,b 'YYYY-MM-DD' -> 整数天数 (b - a)
    const da=new Date(a+'T00:00:00'), db=new Date(b+'T00:00:00');
    return Math.round((db-da)/86400000);
  }
  function renderTasks(){
    const list=$('#taskList'); list.innerHTML='';
    if(state.tasks.length===0){ list.innerHTML='<p class="empty">还没有学习任务，添加一项开始吧～</p>'; return; }
    const t0=todayStr();
    state.tasks.forEach(t=>{
      const el=document.createElement('div'); el.className='task';
      const done = !!t.checkins[t0];
      // 进度增强：时间进度 vs 完成进度
      let progHtml='';
      if(t.start && t.due){
        const total = Math.max(1, daysBetween(t.start, t.due));
        const elapsed = Math.min(total, Math.max(0, daysBetween(t.start, t0)));
        const timeP = Math.round(elapsed/total*100);
        progHtml = `<div class="task-prog">时间进度 <b>${timeP}%</b>（已过 ${elapsed}/${total} 天） · 完成进度 <b>${t.progress||0}%</b>
          <div class="bar"><i style="width:${t.progress||0}%"></i></div></div>`;
      }
      const timeline = (t.start||t.due)
        ? `<div class="timeline"><b>${t.start||'—'}</b><span class="dotline"></span><b>${t.due||'进行中'}</b></div>`
        : '';
      el.innerHTML=`
        <div class="task-top">
          <span class="task-title">${escapeHtml(t.title)}</span>
          <span>
            <button class="edit" data-id="${t.id}">编辑</button>
            <button class="del" data-id="${t.id}">删除</button>
          </span>
        </div>
        ${timeline}
        <div class="task-meta">累计进度 <b>${t.progress||0}%</b></div>
        ${progHtml}
        <input type="range" min="0" max="100" value="${t.progress||0}" data-id="${t.id}" class="prog">
        <button class="checkin ${done?'on':''}" data-id="${t.id}">${done?'今日已打卡 ✓':'今日打卡'}</button>`;
      list.appendChild(el);
    });
    $$('.task .del').forEach(b=>b.addEventListener('click',()=>{
      state.tasks=state.tasks.filter(t=>t.id!==b.dataset.id); save(); renderTasks();
    }));
    $$('.task .edit').forEach(b=>b.addEventListener('click',()=>openTaskEdit(b.dataset.id)));
    $$('.task .prog').forEach(s=>s.addEventListener('input',()=>{
      const t=state.tasks.find(x=>x.id===s.dataset.id);
      if(t){ t.progress=+s.value; s.closest('.task').querySelector('.task-meta b').textContent=t.progress+'%'; save(); }
    }));
    $$('.task .checkin').forEach(b=>b.addEventListener('click',()=>{
      const t=state.tasks.find(x=>x.id===b.dataset.id);
      if(!t) return;
      if(t.checkins[t0]) delete t.checkins[t0]; else t.checkins[t0]=true;
      save(); renderTasks();
    }));
  }

  // ---------- 学习计划编辑弹窗 ----------
  let editTaskId=null;
  function openTaskEdit(id){
    const t=state.tasks.find(x=>x.id===id); if(!t) return;
    editTaskId=id;
    $('#tmTitle').value=t.title||'';
    $('#tmStart').value=t.start||'';
    $('#tmDue').value=t.due||'';
    $('#tmProg').value=t.progress||0;
    $('#tmProgVal').textContent=(t.progress||0)+'%';
    $('#taskModal').classList.remove('hidden');
  }
  $('#taskModal').addEventListener('click',e=>{ if(e.target.id==='taskModal') closeTaskEdit(); });
  function closeTaskEdit(){ $('#taskModal').classList.add('hidden'); editTaskId=null; }
  $('#tmProg').addEventListener('input',()=>{ $('#tmProgVal').textContent=$('#tmProg').value+'%'; });
  $('#tmSave').addEventListener('click',()=>{
    const t=state.tasks.find(x=>x.id===editTaskId); if(!t) return;
    t.title=$('#tmTitle').value.trim()||t.title;
    t.start=$('#tmStart').value||'';
    t.due=$('#tmDue').value||'';
    t.progress=+$('#tmProg').value;
    save(); closeTaskEdit(); renderTasks(); toast('已保存修改');
  });
  $('#tmDelete').addEventListener('click',()=>{
    if(confirm('确定删除该学习计划？此操作不可撤销。')){
      state.tasks=state.tasks.filter(t=>t.id!==editTaskId);
      save(); closeTaskEdit(); renderTasks(); toast('已删除计划');
    }
  });

  // ---------- 体重体脂 UI ----------
  $$('.bm-range button').forEach(b=>b.addEventListener('click',()=>{
    $$('.bm-range button').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    const r=b.dataset.range; bmRange = (r==='all')?'all':+r;
    renderBodyChart();
  }));
  function openBodyModal(){
    $('#bmDate').value = todayStr();
    $('#bmWeight').value=''; $('#bmFat').value='';
    $('#bmMsg').textContent='';
    $('#bodyModal').classList.remove('hidden');
  }
  $('#bodyModal').addEventListener('click',e=>{ if(e.target.id==='bodyModal') closeBodyModal(); });
  function closeBodyModal(){ $('#bodyModal').classList.add('hidden'); }
  $('#bmCancel').addEventListener('click',closeBodyModal);
  $('#bmAdd').addEventListener('click',openBodyModal);
  $('#bmSave').addEventListener('click',()=>{
    const date=$('#bmDate').value;
    const w=parseFloat($('#bmWeight').value), f=parseFloat($('#bmFat').value);
    if(!date){ $('#bmMsg').textContent='请选择日期'; return; }
    if(!(w>0)||!(f>=0)){ $('#bmMsg').textContent='请输入有效的体重与体脂率'; return; }
    if(bodyMetrics[date] && !confirm('该日期已有记录，确定覆盖？')) return;
    bodyMetrics[date]={ weight:Math.round(w*10)/10, bodyFat:Math.round(f*10)/10 };
    saveBodyLocal();
    upsertBodyRow(date, bodyMetrics[date].weight, bodyMetrics[date].bodyFat);
    closeBodyModal(); renderBodyChart(); renderBodyList(); toast('已保存记录');
  });
  function deleteBodyRecord(date){
    if(!confirm('确定删除 '+date+' 的记录？')) return;
    delete bodyMetrics[date];
    saveBodyLocal();
    deleteBodyRow(date);
    renderBodyChart(); renderBodyList(); toast('已删除记录');
  }
  function renderBodyList(){
    const box=$('#bmList'); if(!box) return; box.innerHTML='';
    const dates=Object.keys(bodyMetrics).sort().reverse();
    if(dates.length===0){ box.innerHTML='<p class="empty">还没有记录，点击上方「添加记录」开始追踪吧～</p>'; return; }
    dates.forEach(d=>{
      const r=bodyMetrics[d];
      const row=document.createElement('div'); row.className='bm-row';
      row.innerHTML=`<span class="date">${d}</span>
        <span class="vals">体重 <b>${r.weight}</b> kg　体脂 <b>${r.bodyFat}</b> %</span>
        <button class="del" data-d="${d}">删除</button>`;
      box.appendChild(row);
    });
    $$('#bmList .del').forEach(b=>b.addEventListener('click',()=>deleteBodyRecord(b.dataset.d)));
  }
  function renderBodyChart(){
    const box=$('#bmChart'); if(!box) return;
    let entries=Object.keys(bodyMetrics).map(d=>({date:d,w:bodyMetrics[d].weight,f:bodyMetrics[d].bodyFat}));
    entries.sort((a,b)=>a.date<b.date?-1:1);
    if(bmRange!=='all'){
      const cut=new Date(); cut.setDate(cut.getDate()-bmRange);
      const cutStr=ymd(cut.getFullYear(),cut.getMonth(),cut.getDate());
      entries=entries.filter(e=>e.date>=cutStr);
    }
    if(entries.length<1){ box.innerHTML='<p class="empty">暂无数据，添加记录后这里会显示曲线。</p>'; return; }
    if(entries.length<2){ box.innerHTML='<p class="empty">至少 2 条记录才能绘制曲线，继续添加吧～</p>'; renderBodyList(); return; }
    const wVals=entries.map(e=>e.w), fVals=entries.map(e=>e.f);
    let wMin=Math.min(...wVals), wMax=Math.max(...wVals);
    let fMin=Math.min(...fVals), fMax=Math.max(...fVals);
    const wPad=Math.max(0.5,(wMax-wMin)*0.15), fPad=Math.max(0.5,(fMax-fMin)*0.15);
    wMin=wMin-wPad; wMax=wMax+wPad; fMin=Math.min(0,fMin-fPad); fMax=fMax+fPad;
    const W=680,H=300,mL=42,mR=42,mT=18,mB=34, pw=W-mL-mR, ph=H-mT-mB;
    const X=i=> mL + (entries.length===1?pw/2: i/(entries.length-1)*pw);
    const Yw=v=> mT + ph - (v-wMin)/(wMax-wMin||1)*ph;
    const Yf=v=> mT + ph - (v-fMin)/(fMax-fMin||1)*ph;
    const wPts=entries.map((e,i)=>`${X(i).toFixed(1)},${Yw(e.w).toFixed(1)}`).join(' ');
    const fPts=entries.map((e,i)=>`${X(i).toFixed(1)},${Yf(e.f).toFixed(1)}`).join(' ');
    let grid=''; for(let g=0; g<=4; g++){ const y=mT+ph*g/4; grid+=`<line x1="${mL}" y1="${y.toFixed(1)}" x2="${mL+pw}" y2="${y.toFixed(1)}" stroke="#F0E3E8" stroke-width="1"/>`; }
    let yl=''; for(let g=0; g<=4; g++){ const y=mT+ph*g/4; const wv=(wMax-(wMax-wMin)*g/4).toFixed(1); const fv=(fMax-(fMax-fMin)*g/4).toFixed(1); yl+=`<text x="${mL-6}" y="${(y+4).toFixed(1)}" text-anchor="end" font-size="10" fill="#F6A5C0">${wv}</text>`; yl+=`<text x="${mL+pw+6}" y="${(y+4).toFixed(1)}" text-anchor="start" font-size="10" fill="#C3A5E8">${fv}</text>`; }
    let xl=''; const step=Math.max(1,Math.ceil(entries.length/6)); entries.forEach((e,i)=>{ if(i%step===0 || i===entries.length-1) xl+=`<text x="${X(i).toFixed(1)}" y="${H-12}" text-anchor="middle" font-size="9" fill="#9A9A9A">${e.date.slice(5)}</text>`; });
    let dots=''; entries.forEach((e,i)=>{ dots+=`<circle cx="${X(i).toFixed(1)}" cy="${Yw(e.w).toFixed(1)}" r="3" fill="#F6A5C0"/>`; dots+=`<circle cx="${X(i).toFixed(1)}" cy="${Yf(e.f).toFixed(1)}" r="3" fill="#C3A5E8"/>`; });
    box.innerHTML=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      ${grid}${yl}${xl}
      <polyline points="${wPts}" fill="none" stroke="#F6A5C0" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      <polyline points="${fPts}" fill="none" stroke="#C3A5E8" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      <text x="${mL}" y="12" font-size="10" fill="#F6A5C0">体重(kg)</text>
      <text x="${mL+pw}" y="12" text-anchor="end" font-size="10" fill="#C3A5E8">体脂(%)</text>
    </svg>`;
  }

  // ---------- Questions ----------
  function loadQ(){ $('#qText').value = state.questions[$('#qDate').value]||''; }
  $('#qDate').addEventListener('change',loadQ);
  $('#saveQ').addEventListener('click',()=>{
    const d=$('#qDate').value; if(!d) return;
    const v=$('#qText').value.trim();
    if(v) state.questions[d]=v; else delete state.questions[d];
    save(); toast('已保存学习问题');
  });

  // ---------- Review ----------
  function loadRev(){
    const m=$('#revMonth').value;
    $('#revText').value = state.reviews[m]||'';
    renderRevSummary(m);
  }
  $('#revMonth').addEventListener('change',loadRev);
  function renderRevSummary(m){
    const tasks=state.tasks;
    const avg = tasks.length? Math.round(tasks.reduce((s,t)=>s+(t.progress||0),0)/tasks.length):0;
    const studyDays=new Set();
    tasks.forEach(t=>Object.keys(t.checkins).forEach(d=>{ if(d.startsWith(m+'-')) studyDays.add(d); }));
    const lifeDays=new Set();
    Object.keys(state.dayRecords).forEach(d=>{ if(d.startsWith(m+'-')) lifeDays.add(d); });
    const qs=Object.keys(state.questions).filter(d=>d.startsWith(m+'-')).sort().map(d=>({d,t:state.questions[d]}));
    const startedThisMonth = tasks.filter(t=>t.start && t.start.startsWith(m+'-')).length;
    let html=`<div class="stat"><span>任务平均进度</span><b>${avg}%</b></div>
      <div class="stat"><span>学习打卡天数</span><b>${studyDays.size} 天</b></div>
      <div class="stat"><span>作息记录天数</span><b>${lifeDays.size} 天</b></div>
      <div class="stat"><span>本月开始计划</span><b>${startedThisMonth} 个</b></div>`;
    if(qs.length){
      html+='<div class="qlist"><h4>本月学习问题（'+qs.length+'）</h4>';
      qs.forEach(q=> html+=`<div class="qitem"><span class="qd">${q.d}</span>${escapeHtml(q.t)}</div>`);
      html+='</div>';
    } else { html+='<p class="empty">本月暂无学习问题记录。</p>'; }
    $('#revSummary').innerHTML=html;
  }
  $('#saveRev').addEventListener('click',()=>{
    const m=$('#revMonth').value; if(!m) return;
    const v=$('#revText').value.trim();
    if(v) state.reviews[m]=v; else delete state.reviews[m];
    save(); toast('已保存复盘');
  });

  // ---------- 云端同步 UI ----------
  async function connectCloud(){
    const url=$('#sbUrl').value.trim();
    const key=$('#sbKey').value.trim();
    if(!url || url.indexOf('http')!==0 || !key){
      alert('请填写完整的 Supabase Project URL 与 anon key。');
      return;
    }
    setCfg({url, key});
    await initCloud();
    if(!cloudEnabled){ alert('无法连接：'+(cloudError||'请检查 URL 与 anon key 是否正确')); return; }
    updateCloudStatus();
    const got = await loadFromCloud();
    subscribeRealtime();
    await loadBodyFromCloud();
    subscribeBodyRealtime();
    bootRender();
    updateCloudStatus();
    toast(got ? '已连接并从云端恢复数据' : '已连接，已创建云端备份');
  }
  function disconnectCloud(){
    disconnectRealtime();
    disconnectBodyRealtime();
    setCfg({});
    cloudEnabled=false; supabase=null; cloudError=null; lastSyncAt=0; localSaveAt=0;
    updateCloudStatus();
    toast('已断开云端同步');
  }
  $('#sbConnect').addEventListener('click', connectCloud);
  $('#sbDisconnect').addEventListener('click', disconnectCloud);

  // ---------- 数据备份 UI ----------
  async function bindBackup(){
    if(!fsSupported){
      alert('当前浏览器不支持「自动备份到文件」（需 Chrome / Edge 桌面版）。\n你仍可使用「导出数据」手动备份，再在其它设备「导入数据」。');
      return;
    }
    try{
      const h=await window.showSaveFilePicker({
        suggestedName:'我的工作台-备份.json',
        types:[{description:'JSON 备份', accept:{'application/json':['.json']}}]
      });
      await idbSet('backupHandle', h);
      await writeBackup(state);
      updateBackupStatus();
      toast('已绑定自动备份文件');
    }catch(e){ if(e && e.name!=='AbortError') console.warn(e); }
  }
  function updateBackupStatus(){
    const el=$('#backupStatus');
    if(!fsSupported){
      el.textContent='当前浏览器不支持「自动备份到文件」（需 Chrome/Edge 桌面版）。建议用「导出数据」手动备份。';
      return;
    }
    idbGet('backupHandle').then(h=>{
      el.textContent = h ? ('已绑定自动备份文件：'+(h.name||'备份.json')+'（每次保存自动同步）')
                         : '尚未绑定备份文件，点击上方按钮选择保存位置。';
    });
  }
  function exportData(){
    const blob=new Blob([JSON.stringify({ state, bodyMetrics },null,2)],{type:'application/json'});
    const a=document.createElement('a');
    const n=new Date();
    a.href=URL.createObjectURL(blob);
    a.download=`我的工作台-${n.getFullYear()}-${pad(n.getMonth()+1)}-${pad(n.getDate())}.json`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
    toast('已导出数据');
  }
  function importData(file){
    const r=new FileReader();
    r.onload=()=>{
      try{
        const data=JSON.parse(r.result);
        if(confirm('导入将覆盖当前所有数据，确定继续？')){
          state=Object.assign(defaultState(), data.state||data);
          if(data.bodyMetrics){ bodyMetrics=data.bodyMetrics; saveBodyLocal(); }
          save(); bootRender(); updateBackupStatus();
          renderBodyChart(); renderBodyList();
          toast('已导入数据');
        }
      }catch(e){ alert('文件格式不正确，无法导入。'); }
    };
    r.readAsText(file);
  }
  $('#bindBackup').addEventListener('click',bindBackup);
  $('#exportBtn').addEventListener('click',exportData);
  $('#importBtn').addEventListener('click',()=>$('#importFile').click());
  $('#importFile').addEventListener('change',e=>{
    const f=e.target.files[0]; if(f) importData(f); e.target.value='';
  });

  // ---------- utils ----------
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  let toastT;
  function toast(msg){
    let el=$('#toast');
    if(!el){ el=document.createElement('div'); el.id='toast'; document.body.appendChild(el); }
    el.textContent=msg; el.classList.add('show');
    clearTimeout(toastT); toastT=setTimeout(()=>el.classList.remove('show'),1800);
  }

  // ---------- 统一渲染 ----------
  function bootRender(){
    $('#defWake').value = state.habitDefaults.wake;
    $('#defSleep').value = state.habitDefaults.sleep;
    renderHabitChips(); renderCalendar(); renderTasks(); renderBodyChart(); renderBodyList();
    $('#qDate').value = todayStr(); loadQ();
    const n=new Date();
    $('#revMonth').value = `${n.getFullYear()}-${pad(n.getMonth()+1)}`; loadRev();
  }

  // ---------- 启动：先尝试从备份文件恢复 ----------
  async function boot(){
    state = load();
    loadBodyLocal();
    let restored=false;
    await initCloud();
    if(cloudEnabled){
      await loadFromCloud();
      subscribeRealtime();
      await loadBodyFromCloud();
      subscribeBodyRealtime();
    }
    if(fsSupported){
      try{
        const h=await idbGet('backupHandle');
        if(h){
          const data=await readBackup(h);
          if(data && typeof data==='object'){
            state=Object.assign(defaultState(), data.state||data);
            if(data.bodyMetrics){ bodyMetrics=data.bodyMetrics; saveBodyLocal(); }
            restored=true;
          }
        }
      }catch(e){ console.warn('备份读取失败，使用本地数据', e); }
    }
    save();
    bootRender();
    updateBackupStatus();
    { const c=getCfg(); $('#sbUrl').value=c.url||''; $('#sbKey').value=c.key||''; }
    updateCloudStatus();
    if('serviceWorker' in navigator){
      window.addEventListener('load',()=>{ navigator.serviceWorker.register('./sw.js').catch(()=>{}); });
    }
    if(restored) toast('已从备份文件恢复数据');
  }

  boot();
})();
