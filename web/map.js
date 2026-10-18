'use strict';
// The map is an optional input surface. Only an explicit confirmation writes
// into the planner form; pan/zoom/preview never invalidate a running query.
(() => {
  const el = id => document.getElementById(id);
  const dialog = el('map-dialog');
  const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const M = {data:null,loading:null,target:'origin',focus:null,pending:null,svg:null,projection:null,transform:null,width:0,height:0,routeKey:'',cameraSerial:0,cityById:new Map(),stationByCode:new Map()};
  const CAMERA_DURATION=650;
  let refreshFrame;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const distance = (a,b) => d3.geoDistance(a,b)*6371;
  const displayStation = s => (s.displayName || s.name)+'站';

  async function load() {
    if(M.data)return M.data;
    if(M.loading)return M.loading;
    M.loading=Promise.all(['provinces','regions','cities','stations','coverage'].map(async name=>{
      const r=await fetch('/map-data/'+name+'.json');
      if(!r.ok)throw new Error('本地地图文件读取失败');
      return r.json();
    })).then(([provinces,regions,cities,stations,coverage])=>{
      M.data={provinces,regions,cities,stations,coverage};
      M.cityById=new Map(cities.map(c=>[c.id,c]));
      M.stationByCode=new Map(stations.map(s=>[s.code,s]));
      M.cityByName=new Map(cities.map(c=>[c.name,c]));
      M.stationByName=new Map(stations.map(s=>[s.name,s]));
      el('map-coverage').textContent=`本地坐标覆盖 ${coverage.mappedStations} / ${coverage.stationTotal} 个 12306 站点，${coverage.cities} 个城市入口。坐标：OpenStreetMap；行政树资料 2023。${coverage.boundaryNote || '城市边界资料正在更新。'}`;
      renderPreview();renderQueryMap();
      return M.data;
    }).catch(error=>{M.loading=null;throw error;});
    return M.loading;
  }

  function resolve(value) {
    value=value.trim();
    const code=M.stationByCode.get(value.toUpperCase());
    if(code)return {...code,kind:'station',label:displayStation(code)};
    if(value.endsWith('站')){
      const s=M.stationByName.get(value.slice(0,-1)) || M.data.stations.find(s=>s.displayName===value.slice(0,-1));
      return s?{...s,kind:'station',label:displayStation(s)}:null;
    }
    const city=M.cityByName.get(value.replace(/市$/,''));
    if(city)return {...city,kind:'city',label:city.name};
    const station=M.stationByName.get(value);
    return station?{...station,kind:'station',label:displayStation(station)}:null;
  }

  function endpoints() {
    return ['origin','destination'].map(id=>resolve(el(id).value));
  }

  function selectionText() {
    const a=el('origin').value.trim(),b=el('destination').value.trim();
    return `${a || '未选出发地'} → ${b || '未选目的地'}`;
  }

  function sync() {
    el('map-origin-value').textContent=el('origin').value || '未选择';
    el('map-destination-value').textContent=el('destination').value || '未选择';
    el('map-selection-summary').textContent=M.awaitDestination?'出发地已选定，下一步请选择目的地':selectionText();
    el('map-preview-summary').textContent=el('origin').value || el('destination').value?selectionText():'选择城市或具体车站';
    el('map-done').disabled=!!M.awaitDestination || !el('origin').value.trim() || !el('destination').value.trim();
    if(M.data){renderPreview();if(dialog.open)renderPoints();}
  }

  function setTarget(target) {
    M.svg?.interrupt('map-camera');
    M.target=target;M.pending=null;
    M.selectionComplete=false;
    document.querySelectorAll('[data-map-target]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mapTarget===target)));
    renderPanel();
    if(M.svg)renderPoints();
  }

  function commit(value) {
    const confirmedTarget=M.target;
    const input=el(confirmedTarget);
    M.awaitDestination=confirmedTarget==='origin';
    M.deferRoute=confirmedTarget==='destination';
    if(M.deferRoute)M.routeKey='';
    if(input.value!==value){input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));}
    sync();
    if(confirmedTarget==='origin'){
      // Always advance, including when an old destination is already filled.
      setTarget('destination');M.focus=null;M.pending=null;
      renderPanel();sync();home();
      document.querySelector('[data-map-target="destination"]').focus({preventScroll:true});
    }else if(!el('origin').value.trim()){
      M.deferRoute=false;setTarget('origin');M.focus=null;renderPanel();home();
      document.querySelector('[data-map-target="origin"]').focus({preventScroll:true});
    }else{
      M.pending=null;M.focus=null;M.selectionComplete=true;
      renderPanel();fitEndpoints();el('map-done').focus({preventScroll:true});
    }
  }

  function localStations() {
    if(!M.focus)return [];
    if(M.localCache?.id===M.focus.id)return M.localCache.items;
    const items=M.data.stations.filter(s=>M.focus.parentId?s.countyId===M.focus.id:s.cityId===M.focus.id);
    M.localCache={id:M.focus.id,items};return items;
  }

  function nearbyStations() {
    if(!M.focus)return [];
    if(M.nearCache?.id===M.focus.id)return M.nearCache.items;
    const locals=localStations(),anchors=locals.length?locals.map(s=>s.coord):[M.focus.coord];
    const codes=new Set(locals.map(s=>s.code));
    const items=M.data.stations.filter(s=>!codes.has(s.code)).map(s=>({s,d:Math.min(...anchors.map(a=>distance(a,s.coord)))})).filter(x=>x.d<=45).sort((a,b)=>a.d-b.d).slice(0,40).map(x=>x.s);
    M.nearCache={id:M.focus.id,items};return items;
  }

  function renderPanel() {
    if(!M.data)return;
    const target=M.target==='origin'?'出发地':'目的地';
    const panel=el('map-place-panel'),list=el('map-station-list');
    if(M.pending){
      const s=M.pending,c=M.cityById.get(s.cityId);
      panel.innerHTML=`<h3>${escape(displayStation(s))}</h3><p>${escape(c?c.province+' · '+c.name:'铁路分组：'+s.railCity)} · 指定车站</p><button type="button" class="primary-button" id="map-confirm-station">设为${target}</button><button type="button" class="text-button" id="map-back-city">返回城市车站</button>`;
      el('map-confirm-station').onclick=()=>commit(s.query);
      el('map-back-city').onclick=()=>{M.pending=null;renderPanel();renderPoints();};
    }else if(M.focus){
      const c=M.focus;
      const queryable=M.data.stations.some(s=>s.railCity===c.name);
      panel.innerHTML=`<h3>${escape(c.name)}</h3><p>${escape(c.province)} · ${c.parentId?escape(c.parentName)+'下辖县级市':c.special?'特别行政区':c.level===1?'直辖市':c.level===3?'省直辖县级入口':'地级行政区'}<br>主色为本市车站，棕色为附近其他车站。${c.boundaryAvailable===false?'<br>暂无细分边界，按铁路分组展示。':''}</p>${queryable?`<button type="button" class="secondary-button" id="map-confirm-city">选择${escape(c.name)} · 同城车站</button>`:'<p>请选择具体车站，或返回主界面输入地点。</p>'}`;
      if(queryable)el('map-confirm-city').onclick=()=>commit(c.name);
    }else if(M.selectionComplete){
      panel.innerHTML=`<h3>两地已选定</h3><p>${escape(selectionText())}</p><p>可拖动地图查看，或切换上方地点继续修改。</p>`;
    }else{
      const oldDestination=el('destination').value.trim();
      panel.innerHTML=`<h3>选择${target}</h3><p>${M.awaitDestination?'出发地已确定。请选择并确认目的地。':'点击城市查看车站。滚轮或双指缩放地图，也可搜索地点。'}</p>${M.awaitDestination && oldDestination?`<button type="button" id="map-keep-destination" class="secondary-button">确认目的地：${escape(oldDestination)}</button>`:''}`;
      if(el('map-keep-destination'))el('map-keep-destination').onclick=()=>commit(oldDestination);
    }
    if(!M.focus){list.innerHTML='';return;}
    const locals=[...localStations()].sort((a,b)=>(a.displayPriority??2)-(b.displayPriority??2)||a.name.localeCompare(b.name,'zh-CN'));
    const nearby=nearbyStations();
    const buttons=(items,near)=>items.map(s=>`<button type="button" class="map-station-button ${!near && s.displayPriority<2?'major-station':''}" data-map-station="${s.code}" aria-pressed="${M.pending?.code===s.code}"><span>${escape(displayStation(s))}</span><small>${escape(near?(M.cityById.get(s.cityId)?.name || s.railCity)+' · '+(s.cityId?'邻近车站':'行政归属待核对'):s.displayPriority<2?'主要客运站':s.membership==='railway-group'?'铁路分组归属':'本市车站')}</small></button>`).join('');
    list.innerHTML=`<h4 class="map-list-heading">本市车站 · ${locals.length}</h4>${locals.length?buttons(locals,false):'<p class="map-empty">此区域暂无已核对坐标，请使用文字输入。</p>'}${nearby.length?`<h4 class="map-list-heading">附近其他城市 · ${nearby.length}</h4>${buttons(nearby,true)}`:''}`;
  }

  function screen(coord) {
    const p=M.projection(coord);
    return M.transform.apply(p);
  }

  function curve(a,b) {
    const dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);
    if(length<1)return `M${a} L${b}`;
    const bend=Math.min(65,length*.13);
    const control=[(a[0]+b[0])/2+dy/length*bend,(a[1]+b[1])/2-dx/length*bend];
    // Stop before the destination dot, keeping the arrowhead visible.
    const tangent=[b[0]-control[0],b[1]-control[1]],norm=Math.hypot(...tangent);
    const inset=Math.min(11,length*.15);
    const end=[b[0]-tangent[0]/norm*inset,b[1]-tangent[1]/norm*inset];
    return `M${a} Q${control} ${end}`;
  }

  function drawRoute(group,project,preview=false) {
    if(!preview){
      group.attr('visibility',M.deferRoute || M.awaitDestination?'hidden':null);
      if(M.deferRoute || M.awaitDestination)return;
    }
    const ends=endpoints();
    const paths=ends.every(Boolean)?[{a:project(ends[0].coord),b:project(ends[1].coord)}]:[];
    const key=ends.map(e=>e?e.kind+':'+(e.code||e.id):'').join('|');
    const changed=key!==M.routeKey;
    const line=group.selectAll('path').data(paths).join(enter=>enter.append('path').attr('class',preview?'map-preview-route':'map-route')).attr('d',r=>curve(r.a,r.b)).attr('pathLength',1).attr('marker-end',preview?'url(#preview-arrow)':'url(#route-arrow)');
    // Explicit screen-space arrowhead also works when a browser scales SVG
    // markers unexpectedly on paths with normalized pathLength.
    group.selectAll('polygon').data(paths).join('polygon').attr('fill','#286441').attr('pointer-events','none').attr('points',()=>{
      const node=line.node(),length=node.getTotalLength();
      if(length<2)return '';
      const end=node.getPointAtLength(length),back=node.getPointAtLength(Math.max(0,length-12));
      const dx=end.x-back.x,dy=end.y-back.y,norm=Math.hypot(dx,dy)||1,size=preview?6:11;
      const bx=end.x-dx/norm*size,by=end.y-dy/norm*size;
      return `${end.x},${end.y} ${bx-dy/norm*size*.48},${by+dx/norm*size*.48} ${bx+dy/norm*size*.48},${by-dx/norm*size*.48}`;
    });
    if(!preview){
      if(changed && paths.length && !reduced()){
        line.classed('reveal',false);
        line.node().getBoundingClientRect();
        group.classed('route-revealing',true);
        line.classed('reveal',true).on('animationend',function(){d3.select(this).classed('reveal',false);group.classed('route-revealing',false);});
      }
      M.routeKey=key;
    }
  }

  function scheduleRender() {
    cancelAnimationFrame(refreshFrame);
    refreshFrame=requestAnimationFrame(renderPoints);
  }

  function renderPoints() {
    if(!M.svg || !M.projection || !M.transform)return;
    const k=M.transform.k;
    const ends=endpoints();
    const selectedCities=new Set(ends.filter(e=>e?.kind==='city').map(e=>e.id));
    const selectedStations=new Set(ends.filter(e=>e?.kind==='station').map(e=>e.code));
    const visible=p=>p[0]>-20 && p[0]<M.width+20 && p[1]>70 && p[1]<M.height-20;
    const cities=M.data.cities.filter(c=>M.selectionComplete?selectedCities.has(c.id):selectedCities.has(c.id) || c.priority===0 || (k>1.65 && !c.parentId) || (k>5 && c.parentId));
    const points=cities.map(c=>({...c,key:'city-'+c.id,kind:'city',selected:selectedCities.has(c.id),p:screen(c.coord),radius:c.level===1?6:c.level===3?3.5:4.5})).filter(c=>visible(c.p));
    let stations=[];
    if(M.focus && k>2.2){
      stations=[...localStations().map(s=>({...s,near:false})),...nearbyStations().map(s=>({...s,near:true}))];
    }
    for(const code of selectedStations){if(!stations.some(s=>s.code===code))stations.push(M.stationByCode.get(code));}
    if(M.pending && !stations.some(s=>s.code===M.pending.code))stations.push(M.pending);
    for(const s of stations){
      const p=screen(s.coord);if(!visible(p))continue;
      points.push({...s,key:'station-'+s.code,kind:'station',p,radius:s.displayPriority===0?7:s.displayPriority===1?5.5:3.5,selected:selectedStations.has(s.code)||M.pending?.code===s.code});
    }
    // Labels are laid out in screen pixels, never scaled with the geography.
    // Keep selected places first; nonselected labels yield to nearby labels.
    points.sort((a,b)=>Number(b.selected)-Number(a.selected)||Number(b.kind==='station')-Number(a.kind==='station')||(a.kind==='station'?(a.displayPriority??2):(a.priority??1))-(b.kind==='station'?(b.displayPriority??2):(b.priority??1)));
    const boxes=[];
    for(const p of points){
      p.label=p.kind==='station'?displayStation(p):p.name;
      const width=p.label.length*12+8;
      const options=[[p.p[0]+9,p.p[1]-6],[p.p[0]+9,p.p[1]+17],[p.p[0]-width-7,p.p[1]-6]];
      let choice=null;
      for(const [x,y] of options){
        const box=[x,y-13,x+width,y+3];
        if(box[0]<4||box[2]>M.width-4||box[1]<65||box[3]>M.height-23)continue;
        if(!boxes.some(b=>b[0]<box[2]&&b[2]>box[0]&&b[1]<box[3]&&b[3]>box[1])){choice=[x,y];boxes.push(box);break;}
      }
      p.labelPosition=choice || (p.selected?options[0]:null);
    }
    const nodes=M.svg.select('.map-points').selectAll('g.map-dot').data([...points].reverse(),p=>p.key).join(enter=>{
      const g=enter.append('g').attr('class','map-dot').attr('role','button').attr('tabindex',0);
      g.append('circle').attr('class','hit').attr('r',12);
      g.append('circle').attr('class','point');g.append('text').attr('class','map-label');g.append('title');
      return g;
    }).order();
    nodes.attr('class',p=>`map-dot ${p.kind}${p.near?' nearby':''}${p.selected?' selected':''}${p.kind==='station' && p.displayPriority<2?' major-station':''}`).attr('data-map-city',p=>p.kind==='city'?p.id:null).attr('data-map-code',p=>p.code||null).attr('aria-label',p=>p.label+(p.kind==='city'?'，查看车站':'，选择车站'));
    nodes.select('.hit').attr('cx',p=>p.p[0]).attr('cy',p=>p.p[1]);
    nodes.select('.point').attr('cx',p=>p.p[0]).attr('cy',p=>p.p[1]).attr('r',p=>p.radius);
    nodes.select('text').text(p=>p.label).attr('display',p=>p.labelPosition && !(p.kind==='city'?selectedCities.has(p.id):selectedStations.has(p.code))?null:'none').attr('x',p=>p.labelPosition?.[0]||0).attr('y',p=>p.labelPosition?.[1]||0);
    nodes.select('title').text(p=>p.label+(p.near?' · 邻市车站':''));
    nodes.on('click',(event,p)=>{event.stopPropagation();if(p.kind==='city')focusCity(M.cityById.get(p.id));else pickStation(M.stationByCode.get(p.code));});
    nodes.on('keydown',(event,p)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();if(p.kind==='city')focusCity(M.cityById.get(p.id));else pickStation(M.stationByCode.get(p.code));}});
    M.svg.select('.map-geography').attr('transform',M.transform);
    M.svg.selectAll('.region-shape').classed('focused',f=>f.properties.id===M.focus?.id).attr('display',f=>k>3 || f.properties.id===M.focus?.id?null:'none');
    drawRoute(M.svg.select('.map-route-layer'),screen);
    const endpointLabels=ends.map((e,i)=>e?{e,i,p:screen(e.coord)}:null).filter(Boolean);
    M.svg.select('.map-endpoints').selectAll('text').data(endpointLabels).join('text').attr('class','map-end-label').attr('text-anchor',d=>d.p[0]>M.width/2?'end':'start').attr('x',d=>d.p[0]+(d.p[0]>M.width/2?-9:9)).attr('y',d=>d.p[1]+29).text(d=>(d.i===0?'出发：':'到达：')+d.e.label);
    el('map-status').textContent=M.focus?`${M.focus.name} · 本市 ${localStations().length} 站，邻近车站用棕色标记`:'点击城市查看车站 · 滚轮或双指缩放';
  }

  function setView(transform,{animate=true}={}) {
    const serial=++M.cameraSerial;
    M.svg.interrupt('map-camera');
    const moving=animate && !reduced();
    M.svg.attr('data-camera-moving',String(moving));
    const settle=()=>{
      if(serial!==M.cameraSerial)return;
      M.svg.attr('data-camera-moving','false');
      if(M.deferRoute){M.deferRoute=false;M.routeKey='';}
      renderPoints();
    };
    if(moving){
      // D3 keeps geography, labels, points and arrow in one projection during
      // the transition. Gestures interrupt the named camera immediately.
      M.svg.transition('map-camera').duration(CAMERA_DURATION).ease(d3.easeCubicInOut)
        .call(M.zoom.transform,transform).on('end.camera interrupt.camera cancel.camera',settle);
    }else{M.svg.call(M.zoom.transform,transform);settle();}
  }

  function fitCoords(coords,padding=90,maxZoom=35) {
    if(!coords.length)return;
    const p=coords.map(c=>M.projection(c));
    const x=d3.extent(p,v=>v[0]),y=d3.extent(p,v=>v[1]);
    const k=Math.max(1,Math.min(maxZoom,(M.width-padding*2)/Math.max(x[1]-x[0],2),(M.height-padding*2)/Math.max(y[1]-y[0],2)));
    setView(d3.zoomIdentity.translate(M.width/2-k*(x[0]+x[1])/2,M.height/2-k*(y[0]+y[1])/2).scale(k));
  }

  function focusCity(c) {
    if(!c)return;
    M.focus=c;M.pending=null;M.selectionComplete=false;
    renderPanel();
    const [x0,y0,x1,y1]=c.bounds;
    fitCoords([[x0-.08,y0-.08],[x1+.08,y1+.08]],70,60);
    renderPoints();
  }

  function pickStation(s) {
    if(!s)return;
    const city=M.cityById.get(s.cityId) || M.cityByName.get(s.railCity);
    const changed=M.focus?.id!==city?.id;
    if(changed && city)focusCity(city);
    if(!city)fitCoords([s.coord],90,24);
    M.pending=s;renderPanel();renderPoints();
    el('map-place-panel').scrollIntoView({block:'nearest'});
  }

  function fitEndpoints() {
    const ends=endpoints().filter(Boolean);
    if(ends.length===2)fitCoords(ends.map(e=>e.coord),95,32);
    else if(ends.length===1){
      const c=ends[0].kind==='city'?ends[0]:M.cityById.get(ends[0].cityId);
      if(c)focusCity(c);else fitCoords([ends[0].coord],90,18);
    }
    else{M.deferRoute=false;renderPoints();}
  }

  function home() {
    M.focus=null;M.pending=null;M.selectionComplete=false;renderPanel();setView(d3.zoomIdentity);renderPoints();
  }

  function buildMap() {
    M.svg?.interrupt('map-camera');
    const wrap=el('rail-map').parentElement;
    const oldCenter=M.projection&&M.transform?M.projection.invert(M.transform.invert([M.width/2,M.height/2])):null;
    const oldZoom=M.transform?.k || 1;
    M.width=wrap.clientWidth;M.height=wrap.clientHeight;
    if(!M.width || !M.height)return;
    M.svg=d3.select('#rail-map').attr('viewBox',`0 0 ${M.width} ${M.height}`);
    M.svg.selectAll('*').remove();
    M.projection=d3.geoMercator().fitExtent([[28,90],[M.width-28,M.height-38]],M.data.provinces);
    const defs=M.svg.append('defs');
    defs.append('marker').attr('id','route-arrow').attr('viewBox','0 0 10 10').attr('refX',9).attr('refY',5).attr('markerWidth',7).attr('markerHeight',7).attr('orient','auto').append('path').attr('d','M0,0 L10,5 L0,10 Z').attr('fill','#286441');
    const geography=M.svg.append('g').attr('class','map-geography');
    const path=d3.geoPath(M.projection);
    geography.selectAll('path.province-shape').data(M.data.provinces.features).join('path').attr('class','province-shape').attr('d',path);
    geography.selectAll('path.region-shape').data(M.data.regions.features).join('path').attr('class','region-shape').attr('d',path).attr('display','none');
    M.svg.append('g').attr('class','map-route-layer');M.svg.append('g').attr('class','map-points');M.svg.append('g').attr('class','map-endpoints');
    M.zoom=d3.zoom().scaleExtent([1,90]).extent([[0,0],[M.width,M.height]]).translateExtent([[-M.width*.3,-M.height*.3],[M.width*1.3,M.height*1.3]]).clickDistance(6).on('zoom',event=>{if(event.sourceEvent)M.svg.interrupt('map-camera');M.transform=event.transform;scheduleRender();});
    M.svg.call(M.zoom).on('dblclick.zoom',null);
    if(oldCenter && oldZoom>1){
      const p=M.projection(oldCenter);
      setView(d3.zoomIdentity.translate(M.width/2-p[0]*oldZoom,M.height/2-p[1]*oldZoom).scale(oldZoom),{animate:false});
    }else setView(d3.zoomIdentity,{animate:false});
    renderPoints();
  }

  function renderPreview() {
    if(!M.data || !window.d3)return;
    const svg=d3.select('#map-preview-svg');svg.selectAll('*').remove();
    const p=d3.geoMercator().fitExtent([[24,15],[576,335]],M.data.provinces);
    svg.append('defs').append('marker').attr('id','preview-arrow').attr('viewBox','0 0 10 10').attr('refX',9).attr('refY',5).attr('markerWidth',6).attr('markerHeight',6).attr('orient','auto').append('path').attr('d','M0,0 L10,5 L0,10 Z').attr('fill','#35744d');
    svg.append('g').selectAll('path').data(M.data.provinces.features).join('path').attr('d',d3.geoPath(p)).attr('fill','#e9f0e9').attr('stroke','#c1d1c2').attr('stroke-width',.7);
    const ends=endpoints().filter(Boolean);
    svg.append('g').selectAll('circle').data(ends).join('circle').attr('cx',e=>p(e.coord)[0]).attr('cy',e=>p(e.coord)[1]).attr('r',4.5).attr('fill','#24563f');
    drawRoute(svg.append('g'),p,true);
  }

  async function openMap() {
    if(!dialog.open)dialog.showModal();
    document.body.classList.add('map-open');
    el('map-status').textContent='正在载入本地地图…';
    try{
      await load();
      if(!dialog.open)return;
      M.awaitDestination=false;M.deferRoute=false;
      setTarget(!el('origin').value.trim()?'origin':!el('destination').value.trim()?'destination':'origin');
      M.selectionComplete=endpoints().every(Boolean);M.focus=null;
      buildMap();renderPanel();sync();
      if(endpoints().some(Boolean))fitEndpoints();
    }catch(error){
      el('map-status').textContent='地图加载失败，可关闭地图后继续文字输入。';
      el('map-place-panel').innerHTML='<h3>地图暂不可用</h3><p>请重试，或关闭地图后在主界面输入城市与车站。</p><button type="button" class="secondary-button" id="map-retry">重新载入</button>';
      el('map-retry').onclick=openMap;
    }
  }


  const Q={origin:'',destination:'',sequence:0,hubs:new Map(),edges:new Map(),phase:'idle',view:null};
  function queryCity(place) {
    if(!place)return null;
    return place.kind==='city'?place:M.cityById.get(place.cityId)||place;
  }
  function queryEnds(){return [Q.origin,Q.destination].map(v=>resolve(v));}
  function renderQueryMap({animate=false}={}) {
    if(!M.data || !window.d3)return;
    const svg=d3.select('#query-map');
    if(svg.empty())return;
    const projection=d3.geoMercator().fitExtent([[22,18],[778,418]],M.data.provinces);
    if(svg.select('.query-land').empty()){
      svg.append('g').attr('class','query-land').selectAll('path').data(M.data.provinces.features).join('path').attr('d',d3.geoPath(projection));
      svg.append('defs').append('marker').attr('id','query-arrow').attr('viewBox','0 0 10 10').attr('refX',9).attr('refY',5).attr('markerWidth',6).attr('markerHeight',6).attr('orient','auto').append('path').attr('d','M0,0 L10,5 L0,10 Z').attr('fill','#286441');
      svg.append('g').attr('class','query-links');svg.append('g').attr('class','query-dots');
    }
    const ends=queryEnds().filter(Boolean),dots=new Map();
    for(const e of ends)dots.set(e.code||e.id,{...e,endpoint:true});
    for(const [key,hub] of Q.hubs)if(!dots.has(key))dots.set(key,hub);
    const nodes=svg.select('.query-dots').selectAll('g').data([...dots],d=>d[0]).join(enter=>{
      const g=enter.append('g');g.append('circle').attr('class','query-halo').attr('r',13);g.append('circle').attr('class','query-point');return g;
    }).attr('data-query-place',d=>d[0]).classed('endpoint',d=>!!d[1].endpoint);
    nodes.select('.query-point').attr('r',d=>d[1].endpoint?5:4);
    nodes.each(function(d){
      const halo=d3.select(this).select('.query-halo');
      if(!d[1].endpoint && !d[1].pulsed){
        d[1].pulsed=true;
        if(animate && Q.phase==='running' && !el('step-3').hidden && !reduced())halo.classed('pulse',true).on('animationend',()=>halo.classed('pulse',false));
      }
    });
    const canAnimate=animate && Q.phase==='running' && !reduced() && !el('step-3').hidden;
    const links=svg.select('.query-links').selectAll('path').data([...Q.edges],d=>d[0]).join(enter=>enter.append('path').attr('class','query-link').attr('pathLength',1).attr('marker-end','url(#query-arrow)'))
      .attr('data-query-edge',d=>d[0]);
    // Fit the places being searched, keeping dot sizes in screen pixels.
    // Bounds include all discovered hubs, so adding a city never crops an old one.
    const coords=[...dots.values()].map(place=>projection(place.coord));
    let target=[1,0,0];
    if(coords.length){
      const [x0,x1]=d3.extent(coords,p=>p[0]),[y0,y1]=d3.extent(coords,p=>p[1]);
      const k=Math.max(1,Math.min(64,656/Math.max(x1-x0,1),288/Math.max(y1-y0,1)));
      target=[k,400-k*(x0+x1)/2,220-k*(y0+y1)/2];
    }
    svg.interrupt('query-camera');
    const previous=Q.view;
    const paint=view=>{
      Q.view=view;
      const project=coord=>{const p=projection(coord);return [p[0]*view[0]+view[1],p[1]*view[0]+view[2]];};
      svg.select('.query-land').attr('transform',`translate(${view[1]},${view[2]}) scale(${view[0]})`);
      nodes.attr('transform',d=>`translate(${project(d[1].coord)})`);
      links.attr('d',d=>curve(project(d[1].a.coord),project(d[1].b.coord)));
    };
    const changed=previous && target.some((value,index)=>Math.abs(value-previous[index])>.001);
    if(changed && canAnimate){
      const interpolate=d3.interpolateArray(previous,target);
      svg.attr('data-camera-moving','true');
      paint(previous);
      svg.transition('query-camera').duration(CAMERA_DURATION).ease(d3.easeCubicInOut)
        .tween('view',()=>t=>paint(interpolate(t)))
        .on('end.camera interrupt.camera cancel.camera',()=>svg.attr('data-camera-moving','false'));
    }else{paint(target);svg.attr('data-camera-moving','false');}
    let delay=0;
    links.each(function(d){
      if(d[1].drawn)return;
      d[1].drawn=true;
      if(canAnimate){
        this.style.animationDelay=delay+'ms';delay+=650;
        d3.select(this).classed('drawing',true).on('animationend',function(){d3.select(this).classed('drawing',false);});
      }
    });
  }
  function applyQueryEvents(events) {
    if(!M.data)return;
    for(const event of events){
      if(event.sequence<=Q.sequence)continue;
      Q.sequence=event.sequence;
      if(event.type==='hub'){
        const station=M.stationByCode.get(event.station);
        const city=station?queryCity({...station,kind:'station'}):M.cityByName.get(event.city);
        if(city){const key=city.id||city.code;if(!Q.hubs.has(key))Q.hubs.set(key,{...city});}
      }
      if(event.type==='verify'){
        const ends=queryEnds();
        const places=(event.stops||[]).map(code=>{const station=M.stationByCode.get(code);return station?queryCity({...station,kind:'station'}):null;});
        // Use the selected city/station for endpoints; transfer dots use cities.
        if(places.length){places[0]=ends[0]||places[0];places[places.length-1]=ends[1]||places.at(-1);}
        for(const place of places.slice(1,-1))if(place){const key=place.id||place.code;if(!Q.hubs.has(key))Q.hubs.set(key,{...place});}
        for(let i=1;i<places.length;i++){
          const a=places[i-1],b=places[i];if(!a||!b||distance(a.coord,b.coord)<.1)continue;
          const key=(a.code||a.id)+'>'+ (b.code||b.id);
          if(!Q.edges.has(key))Q.edges.set(key,{a,b});
        }
      }
    }
    renderQueryMap({animate:true});
  }
  window.addEventListener('rail:query-reset',event=>{
    Object.assign(Q,{origin:event.detail.origin,destination:event.detail.destination,sequence:0,hubs:new Map(),edges:new Map(),phase:'running',pending:[],view:null});
    d3.select('#query-map').interrupt('query-camera').selectAll('*').remove();
    el('query-map-fallback').hidden=true;
    load().then(()=>{renderQueryMap();applyQueryEvents(Q.pending||[]);}).catch(()=>{el('query-map-fallback').hidden=false;});
  });
  window.addEventListener('rail:query-events',event=>{
    if(Q.phase!=='running')return;
    Q.pending=event.detail.events;
    applyQueryEvents(event.detail.events);
  });
  window.addEventListener('rail:query-state',event=>{
    Q.phase=event.detail.phase;
    if(Q.phase==='stale'){
      Q.hubs.clear();Q.edges.clear();Q.pending=[];Q.origin='';Q.destination='';renderQueryMap();
    }
    if(Q.phase!=='running'){
      d3.select('#query-map').interrupt('query-camera');renderQueryMap();
    }
    if(Q.phase!=='running')d3.select('#query-map').selectAll('.pulse,.drawing').classed('pulse',false).classed('drawing',false);
  });
  window.addEventListener('rail:step',event=>{
    if(event.detail.step===3)renderQueryMap();
    else {d3.select('#query-map').interrupt('query-camera').selectAll('.pulse,.drawing').classed('pulse',false).classed('drawing',false);}
  });

  el('open-map').addEventListener('click',openMap);
  el('close-map').addEventListener('click',()=>dialog.close());
  el('map-done').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{M.svg?.interrupt('map-camera');document.body.classList.remove('map-open');el('open-map').focus({preventScroll:true});});
  document.querySelectorAll('[data-map-target]').forEach(b=>b.addEventListener('click',()=>setTarget(b.dataset.mapTarget)));
  document.querySelectorAll('[data-map-clear]').forEach(button=>button.addEventListener('click',()=>{
    const target=button.dataset.mapClear,input=el(target);
    M.awaitDestination=false;M.deferRoute=false;M.routeKey='';M.focus=null;M.pending=null;
    setTarget(target);
    if(input.value){input.value='';input.dispatchEvent(new Event('change',{bubbles:true}));}
    sync();home();document.querySelector(`[data-map-target="${target}"]`).focus({preventScroll:true});
  }));
  el('map-home').addEventListener('click',()=>M.svg&&home());
  el('map-fit-route').addEventListener('click',()=>M.svg&&fitEndpoints());
  el('map-zoom-in').addEventListener('click',()=>{M.svg?.interrupt('map-camera');M.svg?.call(M.zoom.scaleBy,1.6);});
  el('map-zoom-out').addEventListener('click',()=>{M.svg?.interrupt('map-camera');M.svg?.call(M.zoom.scaleBy,1/1.6);});
  el('map-station-list').addEventListener('click',event=>{
    const b=event.target.closest('[data-map-station]');if(b)pickStation(M.stationByCode.get(b.dataset.mapStation));
  });
  el('map-search').addEventListener('input',()=>{
    if(!M.data)return;
    const q=el('map-search').value.trim().toLowerCase().replace(/站$/,''),results=el('map-search-results');
    if(!q){results.innerHTML='';return;}
    const cities=M.data.cities.filter(c=>c.name.includes(q.replace(/市$/,''))||c.id===q).slice(0,6);
    const stations=M.data.stations.filter(s=>s.name.includes(q)||s.code.toLowerCase()===q||s.displayName?.includes(q)).slice(0,12);
    results.innerHTML=cities.map(c=>`<button type="button" data-find-city="${c.id}">${escape(c.name)}<small>${escape(c.province)} · 城市</small></button>`).join('')+stations.map(s=>`<button type="button" data-find-station="${s.code}">${escape(displayStation(s))}<small>${escape(M.cityById.get(s.cityId)?.name||s.railCity)} · 车站</small></button>`).join('') || '<p class="map-empty">未找到已定位地点，请使用主界面文字输入。</p>';
  });
  el('map-search-results').addEventListener('click',event=>{
    const c=event.target.closest('[data-find-city]'),s=event.target.closest('[data-find-station]');
    if(c)focusCity(M.cityById.get(c.dataset.findCity));
    if(s)pickStation(M.stationByCode.get(s.dataset.findStation));
    if(c||s){el('map-search-results').innerHTML='';el('map-search').value='';}
  });
  el('rail-map').addEventListener('keydown',event=>{
    if(event.target!==el('rail-map') || !M.svg)return;
    M.svg.interrupt('map-camera');
    const moves={ArrowLeft:[55,0],ArrowRight:[-55,0],ArrowUp:[0,55],ArrowDown:[0,-55]};
    if(moves[event.key]){event.preventDefault();M.svg.call(M.zoom.translateBy,...moves[event.key].map(v=>v/M.transform.k));}
    if(event.key==='+'||event.key==='='){event.preventDefault();M.svg.call(M.zoom.scaleBy,1.5);}
    if(event.key==='-'){event.preventDefault();M.svg.call(M.zoom.scaleBy,1/1.5);}
    if(event.key==='Home'){event.preventDefault();home();}
  });
  new ResizeObserver(()=>{
    const wrap=el('rail-map').parentElement;
    if(dialog.open && M.data && (wrap.clientWidth!==M.width || wrap.clientHeight!==M.height))buildMap();
  }).observe(el('rail-map').parentElement);
  window.addEventListener('rail:places',sync);
  sync();
  if(window.d3)load().catch(()=>{el('map-preview-summary').textContent='打开地图，或继续文字输入';});
})();
