'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtMoney = fen => fen == null ? '待确认' : (fen / 100).toLocaleString('zh-CN', {maximumFractionDigits:2});
const fmtTime = value => value.slice(11,16);
const fmtDate = value => value.slice(5,10).replace('-', '月') + '日';
const duration = value => `${Math.floor(value/60) ? Math.floor(value/60)+'小时' : ''}${value%60 ? value%60+'分' : ''}` || '0分';
const state = {step:1,phase:'idle',ready:false,busy:false,result:null,selected:new Set(),expanded:new Set(),job:null,generation:0,payload:null,polling:null};
let config;
let toastTimer;

function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3200);
}

async function api(path, options={}) {
  const response = await fetch(path, {headers:{'Content-Type':'application/json'}, ...options});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求没有成功，请稍后再试。');
  return data;
}

function mode(value) {
  $('mode').value = value;
  document.querySelectorAll('[data-mode]').forEach(button => {
    const on = button.dataset.mode === value;
    button.classList.toggle('active', on); button.setAttribute('aria-pressed', String(on));
  });
  $('sleep-options').hidden = value !== 'sleeper';
}

function collect() {
  return {origin:$('origin').value.trim(), destination:$('destination').value.trim(),
    earliest:`${$('date').value}T${$('time').value}`, latest:$('latest').value,
    mode:$('mode').value, depart_days:Number($('depart-days').value),
    seats:[...document.querySelectorAll('input[name=seats]:checked')].map(i=>i.value),
    min_transfer:Number($('min-transfer').value), max_transfer:Number($('max-transfer').value),
    min_sleep:Number($('min-sleep').value), budget:$('budget').value,
    via:$('via').value.trim(), via_mode:$('via-mode').value, exclude:$('exclude').value,
    allow_cross_station:$('cross').checked, avoid_early:$('early-policy').value!=='allow', early_policy:$('early-policy').value,
    include_unavailable:$('unavailable').checked, stay_min:$('stay-min').value,
    stay_max:$('stay-max').value, hubs:4};
}

function restore(payload) {
  if (!payload || typeof payload !== 'object') return;
  const fields = {origin:'origin', destination:'destination', latest:'latest', depart_days:'depart-days',
    min_transfer:'min-transfer', max_transfer:'max-transfer', min_sleep:'min-sleep', budget:'budget',
    via:'via', via_mode:'via-mode', exclude:'exclude', stay_min:'stay-min', stay_max:'stay-max'};
  Object.entries(fields).forEach(([key,id]) => { if (payload[key] != null) $(id).value = payload[key]; });
  if (typeof payload.earliest === 'string') {
    $('date').value = payload.earliest.slice(0,10); $('time').value = payload.earliest.slice(11,16);
  }
  if (payload.mode) mode(payload.mode);
  if (Array.isArray(payload.seats)) document.querySelectorAll('input[name=seats]').forEach(i => i.checked = payload.seats.includes(i.value));
  $('early-policy').value=payload.early_policy || (payload.avoid_early===true?'strict':payload.avoid_early===false?'allow':'prefer');
  [['allow_cross_station','cross'],['include_unavailable','unavailable']].forEach(([key,id]) => {
    if (typeof payload[key] === 'boolean') $(id).checked = payload[key];
  });
}

function readHistory() {
  try { const data = JSON.parse(localStorage.getItem('railway-history') || '[]'); return Array.isArray(data) ? data.slice(0,8) : []; }
  catch { return []; }
}
function saveHistory(payload) {
  try {
    const key = JSON.stringify(payload);
    const recent = readHistory().filter(item => JSON.stringify(item.payload) !== key);
    localStorage.setItem('railway-history', JSON.stringify([{payload, saved:new Date().toISOString()},...recent].slice(0,8)));
  } catch { /* Device storage can be disabled; search still works. */ }
}

function showFilters(payload) {
  const tags = [payload.origin+' → '+payload.destination, fmtDate(payload.earliest)+' '+fmtTime(payload.earliest)+' 后出发', fmtDate(payload.latest)+' '+fmtTime(payload.latest)+' 前到达'];
  if (payload.depart_days > 1) tags.push(`连续 ${payload.depart_days} 天可出发`);
  if (payload.via) tags.push((payload.via_mode === 'must' ? '必须经 ' : '优先经 ')+payload.via);
  if (payload.mode === 'sleeper') tags.push('夜间卧铺 ≥ '+duration(payload.min_sleep));
  if (payload.early_policy==='strict') tags.push('严格避开凌晨换乘');
  if (payload.budget) tags.push('预算 ¥'+payload.budget);
  $('active-filters').innerHTML = tags.map(t => '<span>'+esc(t)+'</span>').join('');
  $('active-filters').hidden = false;
}

function sortedRoutes() {
  if (!state.result) return [];
  const list = [...state.result.routes], sort = $('sort').value;
  return list.sort((a,b) => {
    const gate = Number(!a.available)-Number(!b.available) || Number(!a.priced)-Number(!b.priced);
    if (gate) return gate;
    if (sort === 'price') return (a.price_fen ?? Infinity)-(b.price_fen ?? Infinity) || a.duration-b.duration;
    if (sort === 'duration') return a.duration-b.duration;
    if (sort === 'arrival') return a.arrive.localeCompare(b.arrive);
    if (sort === 'sleeper') return Number(b.rest_minutes>=state.payload.min_sleep)-Number(a.rest_minutes>=state.payload.min_sleep) || a.daytime_minutes-b.daytime_minutes || a.arrive.localeCompare(b.arrive) || (a.price_fen??Infinity)-(b.price_fen??Infinity) || a.duration-b.duration || b.rest_minutes-a.rest_minutes;
    const score = r => r.duration+r.wait*.3+(r.cross_station?90:0)+(r.price_fen??1e9)/100*.7-Math.min(r.rest_minutes,480)*.15;
    return score(a)-score(b);
  });
}

function getRoute(id) { return state.result?.routes.find(r=>r.id===id); }
function bookingUrl(segment) {
  const query=new URLSearchParams({linktypeid:'dc',fs:segment.from+','+segment.from_code,ts:segment.to+','+segment.to_code,date:segment.depart.slice(0,10),flag:'N,N,Y'});
  return 'https://kyfw.12306.cn/otn/leftTicket/init?'+query;
}

function detailMarkup(route) {
  const id=route.id;
  return `${route.early_arrival?'<p class="transfer-note">这条路线在清晨 6 点前到站。卧铺可休息窗口满足你的要求，接续车 6 点后出发；请确认能接受早起。选择“严格避开”可排除这类路线。</p>':''}<p class="detail-meta">总耗时 ${duration(route.duration)} · 车上 ${duration(route.on_train)} · 中转等待 ${duration(route.wait)}<br>成人票合计 ${route.priced ? '¥'+fmtMoney(route.price_fen) : '价格待确认'} · 查询于 ${esc(state.result.checked_at.replace('T',' '))}</p>`+
    route.segments.map((s,index)=>`${index?`<div class="transfer-note">${route.cross_station?'同城换站':'同站换乘'} · ${esc(route.segments[index-1].to)}${route.cross_station?' → '+esc(s.from):''} · 预留 ${duration(route.wait)}${route.cross_station?'<br>市内交通时间未实时核实，请自行安排。':''}</div>`:''}<section class="detail-leg"><div class="detail-leg-head"><strong>${index+1 < 10?'0':''}${index+1} / ${esc(s.train)}</strong><span>${esc(s.seat)} · ${s.availability==='available'?'有票':s.availability==='not_on_sale'?'尚未开售':'无票或待核实'}</span></div><div class="detail-stops"><div><strong>${fmtTime(s.depart)} ${esc(s.from)}</strong><small>${esc(s.depart.slice(0,10))}</small></div><span>→</span><div><strong>${fmtTime(s.arrive)} ${esc(s.to)}</strong><small>${esc(s.arrive.slice(0,10))}</small></div></div><div class="detail-fare"><span>查询票价 ${s.price_fen==null?'待确认':'¥'+fmtMoney(s.price_fen)}<br>乘车时长 ${duration(s.duration)}</span><span>票价核验：${s.fare_checked_at?esc(s.fare_checked_at.replace('T',' ')):'未完成'}<br>余票核验：${s.inventory_checked_at?esc(s.inventory_checked_at.replace('T',' ')):'未完成'}</span></div>${s.fare_error?'<p class="muted">'+esc(s.fare_error)+'</p>':''}<a class="booking-link" href="${esc(bookingUrl(s))}" target="_blank" rel="noopener noreferrer">去 12306 核实并购买这一段 ↗</a></section>`).join('')+
    `<p class="muted">${route.rest_minutes ? '夜间可休息窗口 '+duration(route.rest_minutes)+'，按 22:00—次日 08:00 与卧铺乘车时间的重叠计算。<br>' : ''}各段需要分别购票，本工具不占票、不下单。出发前请核实车次与换乘条件。</p><div class="detail-actions"><button type="button" class="primary-button" data-copy-itinerary="${esc(id)}">复制行程文字 ↗</button><button type="button" class="secondary-button" data-requery>重新查询当前条件</button></div>`;
}

function itinerary(route) {
  return ['转个弯 · 行程参考',...route.segments.map((s,i)=>`${i+1}. ${s.train} ${s.from}→${s.to}\n${s.depart.replace('T',' ')} 至 ${s.arrive.replace('T',' ')}\n${s.seat} ${s.price_fen==null?'价格待确认':'¥'+fmtMoney(s.price_fen)} / ${s.availability==='available'?'查询时有票':'未确认有票'}`),`成人火车票合计：${route.priced?'¥'+fmtMoney(route.price_fen):'待确认'}，总耗时 ${duration(route.duration)}`,`核验时间 ${state.result.checked_at.replace('T',' ')}。价格与余票可能变化，请到12306核实购票。`].join('\n\n');
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制'); }
  catch { toast('浏览器未允许复制，请从地址栏或行程中手动复制'); }
}

function openCompare() {
  const routes=[...state.selected].map(getRoute).filter(Boolean);
  if(!routes.length) return;
  $('dialog-title').textContent='选一条更合适的路线';
  const fields=[['火车票合计',r=>r.priced?'<strong>¥'+fmtMoney(r.price_fen)+'</strong>':'待确认'],['总耗时',r=>duration(r.duration)],['出发',r=>esc(r.depart.replace('T',' '))],['到达',r=>esc(r.arrive.replace('T',' '))],['中转',r=>esc(r.via||'直达')+(r.cross_station?'（换站）':'')],['等待',r=>duration(r.wait)],['夜间卧铺窗口',r=>r.rest_minutes?duration(r.rest_minutes):'无'],['白天行程',r=>duration(r.daytime_minutes)],['席别',r=>r.segments.map(s=>esc(s.train)+' '+esc(s.seat)).join('<br>')],['余票',r=>r.available?'全程查询有票':'未全程确认有票']];
  $('dialog-content').innerHTML='<div class="comparison-scroll"><table class="comparison-table"><thead><tr><th>比较项目</th>'+routes.map((r,i)=>'<th>路线 '+(i+1)+'</th>').join('')+'</tr></thead><tbody>'+fields.map(([name,fn])=>'<tr><th>'+name+'</th>'+routes.map(r=>'<td>'+fn(r)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div><p class="muted">可休息时段不是实际睡眠时长。白天行程按 08:00—22:00 计算。</p>';
  $('detail-dialog').showModal();
}

function showHistory() {
  const entries=readHistory();
  $('history-list').innerHTML=entries.length?entries.map((item,index)=>`<button type="button" class="history-item" data-history="${index}"><div><b>${esc(item.payload.origin)} → ${esc(item.payload.destination)}</b><span>${esc(item.payload.earliest?.replace('T',' ')||'')} 出发</span></div><span>恢复条件 ↗</span></button>`).join(''):'<p class="muted">还没有查询记录，开始规划你的第一段旅程吧。</p>';
  $('history-dialog').showModal();
}

function setupAutocomplete(id) {
  const input=$(id), list=$(id+'-list'); let timer, serial=0, active=-1;
  const hide=()=>{clearTimeout(timer);++serial;list.hidden=true; input.setAttribute('aria-expanded','false'); input.removeAttribute('aria-activedescendant'); active=-1;};
  input.addEventListener('input',()=>{
    clearTimeout(timer); const current=++serial;
    timer=setTimeout(async()=>{
      try {
        const values=await api('/api/stations?q='+encodeURIComponent(input.value));
        if(current!==serial || document.activeElement!==input) return;
        list.innerHTML=values.map((item,i)=>`<li role="option" id="${id}-option-${i}" aria-selected="false"><button type="button" tabindex="-1" data-value="${esc(item.value)}">${esc(item.label)}<span>${esc(item.type)}</span></button></li>`).join('');
        list.hidden=!values.length; input.setAttribute('aria-expanded',String(!!values.length)); active=-1;
      } catch { hide(); }
    },180);
  });
  list.addEventListener('pointerdown',e=>{const button=e.target.closest('[data-value]');if(button){e.preventDefault();input.value=button.dataset.value;hide();input.dispatchEvent(new Event("change",{bubbles:true}));}});
  input.addEventListener('blur',()=>setTimeout(hide,100));
  input.addEventListener('keydown',e=>{
    const options=[...list.querySelectorAll('li')];
    if(e.key==='Escape'){hide();return;}
    if(list.hidden||!options.length)return;
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      e.preventDefault();active=(active+(e.key==='ArrowDown'?1:-1)+options.length)%options.length;
      options.forEach((li,i)=>{li.classList.toggle('selected',i===active);li.setAttribute('aria-selected',String(i===active));});
      input.setAttribute('aria-activedescendant',options[active].id);options[active].scrollIntoView({block:'nearest'});
    }else if(e.key==='Enter'&&active>=0){e.preventDefault();input.value=options[active].querySelector('button').dataset.value;hide();input.dispatchEvent(new Event('change',{bubbles:true}));}
  });
}

function addDays(date, amount) {
  const d=new Date(date+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+amount); return d.toISOString().slice(0,10);
}

function currentSummary(payload=collect()) {
  return `${payload.origin || '出发地'} → ${payload.destination || '目的地'} · ${payload.earliest?.slice(0,10) || '选择日期'}`;
}

function updateSummaries() {
  document.querySelectorAll('[data-trip-summary]').forEach(el=>el.textContent=currentSummary());
  document.querySelectorAll('[data-search-summary]').forEach(el=>el.textContent=currentSummary(state.phase==='stale'?collect():state.payload || collect()));
  $('editing-notice').hidden=!state.busy;
  $('advanced-count').textContent=advancedCount() ? `已设置 ${advancedCount()} 项` : '未设置额外条件';
}

function advancedCount() {
  const p=collect();
  const baseline=['O','3','4','F','I','J'];
  return [!!p.via,!!p.budget,p.depart_days!==1,p.min_transfer!==45,p.max_transfer!==360,
    !!p.stay_min||!!p.stay_max,!!p.exclude,p.allow_cross_station,p.include_unavailable,
    p.seats.length!==baseline.length || baseline.some(s=>!p.seats.includes(s))].filter(Boolean).length;
}

function syncNavigation() {
  document.querySelectorAll('.step-nav [data-step]').forEach(button=>{
    const step=Number(button.dataset.step);
    button.disabled=(step===3 && state.phase==='idle') || (step===4 && !state.result);
    if(step===state.step)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');
    button.classList.toggle('done',step<state.step || (step===3 && state.phase==='complete'));
  });
  $('search-button').textContent=state.busy?'查看查询进度':'开始寻找路线';
  $('compare-bar').hidden=state.step!==4 || !state.selected.size;
  updateSummaries();
}

function writeAddress(replace=false) {
  const params=new URLSearchParams();
  const p=collect();
  if(p.origin && p.destination)params.set('q',JSON.stringify(p));
  params.set('step',String(state.step));
  history[replace?'replaceState':'pushState']({wizardStep:state.step},'', '#'+params.toString());
}

function validateTrip(report=true) {
  $('trip-error').hidden=true;
  for(const id of ['origin','destination','date']) {
    if(!$(id).checkValidity()) {
      if(report){goStep(1,{skipValidation:true});$(id).reportValidity();}
      return false;
    }
  }
  if($('origin').value.trim()===$('destination').value.trim()) {
    if(report){goStep(1,{skipValidation:true});$('trip-error').textContent='出发地和目的地不能相同。';$('trip-error').hidden=false;}
    return false;
  }
  return true;
}

function goStep(step,{replace=false,skipValidation=false,fromHistory=false}={}) {
  if(!skipValidation && step>1 && !validateTrip())return;
  if(step===3 && state.phase==='idle'){toast('请先开始查询');return;}
  if(step===4 && !state.result){if(fromHistory)return goStep(2,{replace:true});toast('查询完成后可查看路线');return;}
  state.step=step;
  document.querySelectorAll('.step-page').forEach((page,index)=>page.hidden=index+1!==step);
  document.querySelector('.wizard').classList.toggle('show-results',step===4);
  syncNavigation();
  if(!fromHistory)writeAddress(replace);
  window.scrollTo({top:0,behavior:'instant'});
  const heading=$('step-'+step).querySelector('h1');
  heading?.focus({preventScroll:true});
}

function updateProgress(percent,message) {
  $('progress').value=percent;
  $('progress-percent').textContent=percent+'%';
  $('progress-message').textContent=message;
  const stage=percent<18?0:percent<60?1:2;
  document.querySelectorAll('.query-stages li').forEach((li,index)=>{
    li.classList.toggle('complete',state.phase==='complete'||index<stage);
    li.classList.toggle('current',state.busy && index===stage);
  });
}

function updateProgressState() {
  $('progress-heading').textContent=({running:'正在寻找路线',complete:'查询已完成',error:'查询未完成',cancelled:'查询已停止',stale:'条件已修改',idle:'寻找路线'})[state.phase];
  $('cancel-button').hidden=!state.busy;
  $('retry-button').hidden=!['error','cancelled','stale'].includes(state.phase);
  $('view-results').hidden=!state.result;
  $('progress-note').textContent=state.phase==='complete'
    ? `用时 ${state.result.elapsed_seconds} 秒。可返回查看本次条件。`
    : state.phase==='stale'?'原查询结果已失效，请按新条件重新查询。'
    : state.phase==='cancelled'?'已保留填写的条件，可修改后重新查询。'
    : '按实际乘车日期查询余票与票价。';
  syncNavigation();
}

function cancelSearch() {
  const id=state.job;
  ++state.generation;
  clearTimeout(state.polling);
  state.job=null;state.busy=false;
  if(state.phase==='running')state.phase='cancelled';
  if(id)api('/api/cancel/'+encodeURIComponent(id),{method:'POST'}).catch(()=>{});
  updateProgressState();
}

function markDirty() {
  updateSummaries();
  if(!state.payload || JSON.stringify(collect())===JSON.stringify(state.payload))return;
  if(state.busy)cancelSearch();
  state.result=null;state.selected.clear();state.expanded.clear();
  state.phase='stale';
  $('progress-error').hidden=true;
  $('route-list').innerHTML='';$('active-filters').hidden=true;
  updateProgress(0,'等待重新查询');updateProgressState();
  updateCompare();syncNavigation();writeAddress(true);
}

function validatePreferences() {
  for(const input of $('step-2').querySelectorAll('input,select')) {
    if(!input.checkValidity()) {
      goStep(2);
      let parent=input.parentElement;
      while(parent && parent!==$('step-2')){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}
      input.reportValidity();return false;
    }
  }
  const p=collect();
  if(!p.seats.length){$('preferences').open=true;showError('请至少选择一种席别。');return false;}
  if(p.latest<=p.earliest){showError('最晚到达时间须晚于最早出发时间。');$('latest').focus();return false;}
  return true;
}

function showError(message) {$('form-error').textContent=message;$('form-error').hidden=false;}

function failSearch(error) {
  const id=state.job;
  state.job=null;state.busy=false;state.phase='error';
  clearTimeout(state.polling);
  if(id)api('/api/cancel/'+encodeURIComponent(id),{method:'POST'}).catch(()=>{});
  $('progress-error').textContent=error.message || '查询未能完成，请重新尝试。';
  $('progress-error').hidden=false;
  updateProgressState();
  goStep(3,{replace:true});
}

async function search(event) {
  event?.preventDefault();
  if(state.busy){goStep(3);return;}
  if(!validateTrip() || !validatePreferences())return;
  $('form-error').hidden=true;$('progress-error').hidden=true;
  const payload=collect();
  const generation=++state.generation;
  state.payload=payload;state.result=null;state.selected.clear();state.expanded.clear();
  state.busy=true;state.phase='running';state.job=null;
  updateCompare();updateProgress(0,'准备查询');updateProgressState();
  goStep(3);saveHistory(payload);
  try {
    const {id}=await api('/api/search',{method:'POST',body:JSON.stringify(payload)});
    if(generation!==state.generation){api('/api/cancel/'+encodeURIComponent(id),{method:'POST'}).catch(()=>{});return;}
    state.job=id;
    await poll(id,generation);
  }catch(error){if(generation===state.generation)failSearch(error);}
}

async function poll(id,generation) {
  if(generation!==state.generation)return;
  const job=await api('/api/search/'+encodeURIComponent(id));
  if(generation!==state.generation)return;
  updateProgress(job.progress,job.message);
  if(job.status==='running') {
    state.polling=setTimeout(()=>poll(id,generation).catch(error=>{
      if(generation===state.generation)failSearch(error);
    }),800);return;
  }
  state.job=null;state.busy=false;
  if(job.status==='error')throw new Error(job.error);
  if(job.status==='cancelled'){state.phase='cancelled';updateProgressState();return;}
  state.result=job.result;state.phase='complete';
  $('sort').value=state.payload.mode;
  renderResults();updateProgress(100,'已完成查询');updateProgressState();goStep(4);
}

function renderResults() {
  const result=state.result;
  $('results-heading').textContent=state.payload.origin+' → '+state.payload.destination;
  $('result-summary').textContent=fmtDate(state.payload.earliest)+' '+fmtTime(state.payload.earliest)+' 后出发 · '+fmtDate(state.payload.latest)+' '+fmtTime(state.payload.latest)+' 前到达';
  const valid=result.routes.filter(r=>r.available && r.priced);
  $('result-count').textContent=`${result.routes.length} 条路线 · ${valid.length} 条全程有票且已核价`;
  showFilters(state.payload);
  renderList();
  $('empty-state').hidden=result.routes.length>0;
  $('empty-hint').textContent=result.empty_hint || '可尝试放宽时间、席别或中转限制。';
  const scope=result.scope;
  $('scope-summary').textContent='查询范围与数据说明 · '+fmtTime(result.checked_at)+' 更新';
  $('scope-content').innerHTML=`<p>本次组合 ${scope.candidate_count} 条候选，优先核验 ${scope.verified_candidates} 条。价格排名仅针对本次已核验结果。</p><p>搜索中转站：${esc(scope.hubs.map(h=>h.arrival_station===h.departure_station?h.arrival_station:h.arrival_station+' → '+h.departure_station).join('、')||'未完成中转站扩展')}。</p><ul>${result.warnings.map(w=>'<li>'+esc(w)+'</li>').join('')}</ul>${result.errors.length?'<details class="scope-errors"><summary>未完成的区间</summary><ul>'+result.errors.map(e=>'<li>'+esc(e)+'</li>').join('')+'</ul></details>':''}`;
  $('scope-box').open=false;
}

function renderList() {
  const result=state.result;if(!result)return;
  $('route-list').innerHTML=sortedRoutes().map(route=>{
    const first=route.segments[0],last=route.segments.at(-1);
    const badges=[];
    if(route.early_arrival)badges.push('<span class="badge amber">清晨 6 点前到站</span>');
    if(route.cross_station)badges.push('<span class="badge amber">需要换站</span>');
    if(!route.available)badges.push('<span class="badge amber">未全程确认有票</span>');
    if(!route.priced)badges.push('<span class="badge amber">价格待确认</span>');
    const opened=state.expanded.has(route.id);
    return `<article class="route-card" id="route-${esc(route.id)}"><div class="route-main"><div class="route-time"><strong>${fmtTime(route.depart)}</strong><span>${esc(first.from)}</span><small>${fmtDate(route.depart)}</small></div><div class="journey-summary"><strong>${duration(route.duration)}</strong><span>${route.via?esc(route.via)+'中转 · 等待 '+duration(route.wait):'直达'}</span></div><div class="route-time arrival"><strong>${fmtTime(route.arrive)}</strong><span>${esc(last.to)}</span><small>${fmtDate(route.arrive)}</small></div><div class="route-price">${route.priced?'<strong><small>¥</small>'+fmtMoney(route.price_fen)+'</strong>':'<strong class="unknown">待确认</strong>'}<small>成人票合计</small></div></div><div class="route-secondary"><p>${route.segments.map(s=>esc(s.train)+' '+esc(s.seat)).join(' → ')}${route.rest_minutes?' · 夜间卧铺 '+duration(route.rest_minutes):''}</p><div class="route-badges">${badges.join('')}</div></div><div class="route-card-actions"><label class="compare-check"><input type="checkbox" data-compare="${esc(route.id)}" ${state.selected.has(route.id)?'checked':''}>加入对比</label><button type="button" class="text-button" data-detail="${esc(route.id)}" aria-expanded="${opened}" aria-controls="detail-${esc(route.id)}">${opened?'收起详情':'展开详情'}</button></div><div class="route-detail" id="detail-${esc(route.id)}" ${opened?'':'hidden'}>${opened?detailMarkup(route):''}</div></article>`;
  }).join('');
}

function toggleDetail(id) {
  const route=getRoute(id);if(!route)return;
  if(state.expanded.has(id))state.expanded.delete(id);else state.expanded.add(id);
  const opened=state.expanded.has(id),element=$('detail-'+id);
  element.hidden=!opened; element.innerHTML=opened?detailMarkup(route):'';
  const button=document.querySelector(`[data-detail="${id}"]`);
  button.setAttribute('aria-expanded',String(opened));button.textContent=opened?'收起详情':'展开详情';
}

function updateCompare() {
  $('compare-count').textContent=state.selected.size;
  $('compare-bar').hidden=state.step!==4 || !state.selected.size;
}

async function init() {
  ['origin','destination','via'].forEach(setupAutocomplete);
  try {
    config=await api('/api/config');
    $('date').min=config.today;$('date').max=config.sale_end;
    $('date').value=addDays(config.today,1);$('latest').value=addDays(config.today,2)+'T18:00';
    const shared=new URLSearchParams(location.hash.slice(1)).get('q');
    if(shared){try{restore(JSON.parse(shared));}catch{toast('分享条件无效，已恢复默认设置');}}
    state.ready=true;$('next-preferences').disabled=false;
    goStep(1,{replace:true,skipValidation:true});
  }catch(error){$('trip-error').textContent='无法连接本地服务，请刷新重试。';$('trip-error').hidden=false;}
}

document.querySelectorAll('[data-step]').forEach(button=>button.addEventListener('click',()=>goStep(Number(button.dataset.step))));
$('next-preferences').disabled=true;
$('next-preferences').addEventListener('click',()=>goStep(2));
$('search-form').addEventListener('submit',event=>{event.preventDefault();if(state.step===1)goStep(2);else search();});
$('search-form').addEventListener('input',markDirty);
$('search-form').addEventListener('change',markDirty);
$('date').addEventListener('change',()=>{if($('date').value){$('latest').value=addDays($('date').value,1)+'T18:00';markDirty();}});
$('swap').addEventListener('click',()=>{const value=$('origin').value;$('origin').value=$('destination').value;$('destination').value=value;markDirty();});
document.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>{mode(button.dataset.mode);markDirty();}));
$('preferences').addEventListener('toggle',()=>{$('preferences').querySelector('.disclosure').textContent=$('preferences').open?'收起':'展开';});
$('sort').addEventListener('change',renderList);
$('cancel-button').addEventListener('click',()=>{cancelSearch();updateProgress($('progress').value,'已停止查询');});
$('retry-button').addEventListener('click',()=>search());
$('share').addEventListener('click',()=>{const link=new URL(location.href);link.hash=new URLSearchParams({q:JSON.stringify(collect())}).toString();copy(link.href);});
$('relax').addEventListener('click',()=>goStep(2));
$('history-btn').addEventListener('click',showHistory);
$('clear-history').addEventListener('click',()=>{try{localStorage.removeItem('railway-history');}catch{}$('history-dialog').close();toast('已清除记录');});
$('history-list').addEventListener('click',event=>{
  const button=event.target.closest('[data-history]');if(!button)return;
  const item=readHistory()[Number(button.dataset.history)];
  if(item){cancelSearch();state.result=null;state.payload=null;state.phase='idle';state.selected.clear();state.expanded.clear();restore(item.payload);updateProgress(0,'准备查询');updateProgressState();$('history-dialog').close();goStep(1,{skipValidation:true});}
});
$('route-list').addEventListener('click',event=>{
  const button=event.target.closest('[data-detail]');if(button)toggleDetail(button.dataset.detail);
  const copyButton=event.target.closest('[data-copy-itinerary]');if(copyButton){const route=getRoute(copyButton.dataset.copyItinerary);if(route)copy(itinerary(route));}
  if(event.target.closest('[data-requery]'))search();
});
$('route-list').addEventListener('change',event=>{
  const input=event.target.closest('[data-compare]');if(!input)return;
  if(input.checked){if(state.selected.size>=3){input.checked=false;toast('最多对比 3 条路线');return;}state.selected.add(input.dataset.compare);}else state.selected.delete(input.dataset.compare);
  updateCompare();
});
$('clear-compare').addEventListener('click',()=>{state.selected.clear();updateCompare();renderList();});
$('open-compare').addEventListener('click',openCompare);
document.querySelectorAll('.close-dialog').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}}));
window.addEventListener('popstate',event=>{
  const step=Number(event.state?.wizardStep || new URLSearchParams(location.hash.slice(1)).get('step') || 1);
  goStep(Math.max(1,Math.min(4,step)),{fromHistory:true});
});
init();
