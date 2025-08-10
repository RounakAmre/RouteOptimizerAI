
/* Flow:
 * 1) Heuristic optimization to get base order.
 * 2) AI Post-Adjust: stable-partition urgent, then local adjacent swaps to reduce avoided-road legs.
 * 3) Draw final route in that order only. For each leg, try OSRM alternatives and pick the route
 *    with least avoided-road usage + travel time score.
 */
const state = {
  map: null,
  stops: [],
  routeLine: null,
  lastRoute: null,
  baseOrder: null,
  finalOrder: null,
  pairMetaCache: new Map(),
  lastCacheBuster: null,
};

function initMap(){
  const c = [32.7767, -96.7970];
  state.map = L.map('map').setView(c, 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(state.map);
  state.map.on('click', e => addStop(e.latlng));

  q('#btnOptimize').addEventListener('click', optimizeHeuristic);
  q('#btnAiAdjust').addEventListener('click', aiPostAdjust);
  q('#btnClear').addEventListener('click', clearAll);

  q('#btnSavePersistent').addEventListener('click', ()=>{
    localStorage.setItem('persistentPrompt', q('#persistentPrompt').value || '');
    toast('Persistent saved');
  });
  q('#btnSaveAdhoc').addEventListener('click', ()=>{
    localStorage.setItem('adHocPrompt', q('#adHocPrompt').value || '');
    toast('Ad hoc saved');
  });

  q('#persistentPrompt').value = localStorage.getItem('persistentPrompt') || '';
  q('#adHocPrompt').value = localStorage.getItem('adHocPrompt') || '';

  render();
}

function baseIcon(h, ghost=false){ return L.divIcon({className:'num-icon', html:`<div class="bubble ${ghost?'ghost':''}">${h}</div>`, iconSize:[26,26], iconAnchor:[13,26], popupAnchor:[0,-28]}); }

function addStop(latlng){
  const i = state.stops.length;
  const m = L.marker(latlng,{draggable:true,icon:baseIcon('•',true)}).addTo(state.map);
  m.on('dragend', render);
  const s = { marker: m, name: `Stop ${i+1}`, minutes: 5, urgent: false, twStart: null, twEnd: null };
  state.stops.push(s);
  m.bindPopup(()=> popupHtml(s));
  render();
}

function popupHtml(s){
  const {lat,lng} = s.marker.getLatLng();
  const tw = (s.twStart!=null&&s.twEnd!=null) ? `${secToHHMM(s.twStart)}–${secToHHMM(s.twEnd)}` : 'any time';
  return `<b>${esc(s.name)}</b><br/>${lat.toFixed(5)}, ${lng.toFixed(5)}<br/>${s.urgent?'🚩 Urgent':'Normal'} · ${s.minutes} min · ${tw}`;
}

function clearAll(){
  state.stops.forEach(s => state.map.removeLayer(s.marker));
  state.stops = [];
  state.baseOrder = null; state.finalOrder = null;
  if (state.routeLine){ state.map.removeLayer(state.routeLine); state.routeLine = null; }
  q('#avoidHits').innerHTML='';
  render();
}

function render(){
  const list = q('#stopList'); list.innerHTML='';
  q('#stopCount').textContent = state.stops.length;

  state.stops.forEach((s,i)=>{
    const r = document.createElement('div'); r.className='stop';
    const {lat,lng} = s.marker.getLatLng();
    r.innerHTML = `<div class="grid">
      <input type="text" value="${attr(s.name)}" data-i="${i}" data-f="name" placeholder="Stop name"/>
      <input type="number" min="0" step="1" value="${s.minutes}" data-i="${i}" data-f="minutes"/>
      <input type="time" value="${s.twStart!=null?secToHHMM(s.twStart):''}" data-i="${i}" data-f="twStart"/>
      <input type="time" value="${s.twEnd!=null?secToHHMM(s.twEnd):''}" data-i="${i}" data-f="twEnd"/>
      <label><input type="checkbox" ${s.urgent?'checked':''} data-i="${i}" data-f="urgent"/> Urgent</label>
      <button class="del" data-i="${i}">✕</button>
    </div>
    <div class="tiny muted">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>`;
    list.appendChild(r);
  });

  list.querySelectorAll('input,button').forEach(el => {
    if (el.tagName === 'BUTTON') el.addEventListener('click', onDelete);
    else { el.addEventListener('input', onEdit); el.addEventListener('change', onEdit); }
  });

  refreshMarkerNumbers();
}

function onDelete(e){
  const i = +e.target.dataset.i;
  state.map.removeLayer(state.stops[i].marker);
  state.stops.splice(i,1);
  state.baseOrder = null; state.finalOrder = null;
  render();
}
function onEdit(e){
  const i = +e.target.dataset.i;
  const f = e.target.dataset.f;
  if (f==='name') state.stops[i].name = e.target.value;
  if (f==='minutes') state.stops[i].minutes = Math.max(0, +e.target.value||0);
  if (f==='urgent') state.stops[i].urgent = e.target.checked;
  if (f==='twStart') state.stops[i].twStart = e.target.value ? hhmmToSec(e.target.value) : null;
  if (f==='twEnd') state.stops[i].twEnd = e.target.value ? hhmmToSec(e.target.value) : null;
  state.stops[i].marker.setPopupContent(()=> popupHtml(state.stops[i]));
  render();
}

async function optimizeHeuristic(){
  if (state.stops.length < 2) return toast('Add at least 2 stops');
  toggleBusy(true);
  try {
    const coords = state.stops.map(s => s.marker.getLatLng());
    const coordStr = coords.map(c => `${c.lng},${c.lat}`).join(';');
    const tRes = await fetch(`https://router.project-osrm.org/table/v1/driving/${coordStr}?annotations=duration`);
    if (!tRes.ok) throw new Error('Matrix request failed');
    const matrix = await tRes.json();
    const dur = matrix.durations;
    const startSec = hhmmToSec(q('#routeStart').value || '08:00');
    const built = buildGreedy(dur, startSec);
    state.baseOrder = built.order;
    await drawWholeRouteSimple(state.baseOrder);
    toast('Heuristic route created');
  } catch(e){ alert('Optimize failed: ' + e.message); }
  finally{ toggleBusy(false); render(); }
}

// simple greedy
function buildGreedy(dur, startSec){
  const N = state.stops.length;
  const order = [0]; let current = 0;
  const remaining = new Set(Array.from({length:N}, (_,i)=>i).filter(i=>i!==0));
  while (remaining.size){
    let best=null,bestT=Infinity;
    remaining.forEach(i=>{ const t=dur[current][i]; if (t < bestT){ bestT=t; best=i; } });
    order.push(best); remaining.delete(best); current=best;
  }
  if (q('#roundTrip').checked) order.push(order[0]);
  return { order };
}

async function aiPostAdjust(){
  if (!state.baseOrder) return toast('Run heuristic first');
  toggleBusy(true);
  try{
    const ai = await getAIRules();
    // clear cache if rules changed
    if (state.lastCacheBuster !== ai.cache_buster){
      state.pairMetaCache = new Map();
      state.lastCacheBuster = ai.cache_buster;
    }

    let order = state.baseOrder.slice();
    // 1) urgent stable partition
    if (ai.priority === 'urgent'){
      const urgent = order.filter(i => state.stops[i].urgent);
      const normal = order.filter(i => !state.stops[i].urgent);
      // keep start as first if exists
      if (order[0] === 0){
        order = [0, ...urgent.filter(i=>i!==0), ...normal.filter(i=>i!==0)];
      } else {
        order = [...urgent, ...normal];
      }
    }
    // 2) local swaps to avoid avoided roads
    if (ai.avoidRoadNames?.length){
      order = await localSwapAvoid(order, ai);
    }

    state.finalOrder = order;
    await drawWholeRouteAlternatives(order, ai); // check alternatives per leg to avoid roads
    await listAvoidHits(order, ai.avoidRoadNames || []);
    toast('AI post‑adjust applied');
  } catch(e){ alert('AI adjust failed: ' + e.message); }
  finally{ toggleBusy(false); render(); }
}

async function localSwapAvoid(order, ai){
  for (let k=0;k<order.length-1;k++){
    const a=order[k], b=order[k+1];
    const uses = await legUsesAvoidedRoad(a,b, ai.avoidRoadNames);
    if (!uses) continue;
    if (k+2 < order.length){
      const c = order[k+2];
      const scoreAB = await legScoreByAlternatives(a,b,ai);
      const scoreAC = await legScoreByAlternatives(a,c,ai) + await legScoreByAlternatives(c,b,ai);
      const scoreABC = scoreAB + await legScoreByAlternatives(b,c,ai);
      if (scoreAC < scoreABC){
        const tmp = order[k+1]; order[k+1]=order[k+2]; order[k+2]=tmp;
      }
    }
  }
  return order;
}

// ==== Final map drawing ====

// Draw entire route in fixed order via a single OSRM request (no alternatives)
async function drawWholeRouteSimple(order){
  const coords = order.map(i => state.stops[i].marker.getLatLng());
  const orderedStr = coords.map(c => `${c.lng},${c.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${orderedStr}?overview=full&geometries=geojson`;
  const r = await fetch(url); const j = await r.json();
  const geom = j.routes?.[0]?.geometry;
  if (!geom) throw new Error('No route');
  drawPolyline(geom.coordinates.map(([x,y])=>[y,x]));
}

function drawPolyline(latlngs){
  if (state.routeLine) state.map.removeLayer(state.routeLine);
  state.routeLine = L.polyline(latlngs, {weight:5,opacity:.95}).addTo(state.map);
  state.map.fitBounds(state.routeLine.getBounds(), {padding:[30,30]});
  refreshMarkerNumbers();
}

// Build route by leg, try alternatives per leg, pick best for avoided roads
async function drawWholeRouteAlternatives(order, ai){
  const latlngsAll = [];
  for (let k=0;k<order.length-1;k++){
    const a = order[k], b = order[k+1];
    const seg = await bestLegGeometry(a, b, ai);
    if (!seg.length) continue;
    if (latlngsAll.length) seg.shift(); // avoid duplicate join point
    latlngsAll.push(...seg);
  }
  if (!latlngsAll.length) throw new Error('No route segments');
  drawPolyline(latlngsAll);
}

async function bestLegGeometry(aIdx, bIdx, ai){
  const A = state.stops[aIdx].marker.getLatLng();
  const B = state.stops[bIdx].marker.getLatLng();
  const url = `https://router.project-osrm.org/route/v1/driving/${A.lng},${A.lat};${B.lng},${B.lat}?overview=full&steps=true&alternatives=true&geometries=geojson`;
  const r = await fetch(url); if (!r.ok) return [];
  const j = await r.json();
  const routes = j.routes || [];
  if (!routes.length) return [];

  // choose by (duration + penalty if uses avoided roads)
  let best = null, bestScore = Infinity;
  for (const rt of routes){
    const steps = rt.legs?.[0]?.steps || [];
    const uses = stepsUseAvoid(steps, ai.avoidRoadNames || []);
    const duration = rt.duration || 0;
    const penalty = uses ? (ai.weights?.avoidRoadPenalty || 1200) : 0;
    const score = duration + penalty;
    if (score < bestScore){ best=rt; bestScore=score; }
  }
  const coords = best.geometry.coordinates.map(([x,y])=>[y,x]);
  return coords;
}

function stepsUseAvoid(steps, avoidList){
  const norm = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'').replace(/1(?=\d{2,})/g,'i');
  const hay = steps.map(s => (s.name||'') + (s.ref ? ' '+s.ref : '')).join('|');
  const H = norm(hay);
  return avoidList.some(raw => {
    const q = norm(raw);
    return q.length >= 4 && H.includes(q);
  });
}

async function listAvoidHits(order, avoidList){
  const ul = q('#avoidHits'); ul.innerHTML='';
  if (!avoidList?.length) return;
  for (let k=0;k<order.length-1;k++){
    const a = order[k], b = order[k+1];
    const A = state.stops[a].marker.getLatLng();
    const B = state.stops[b].marker.getLatLng();
    const url = `https://router.project-osrm.org/route/v1/driving/${A.lng},${A.lat};${B.lng},${B.lat}?steps=true&overview=false`;
    try{
      const r = await fetch(url); if (!r.ok) continue;
      const j = await r.json();
      const steps = j.routes?.[0]?.legs?.[0]?.steps || [];
      if (stepsUseAvoid(steps, avoidList)){
        const li = document.createElement('li');
        li.textContent = `Leg ${k+1}: ${state.stops[a].name} → ${state.stops[b].name}`;
        ul.appendChild(li);
      }
    }catch{}
  }
}

// === AI client ===
async function getAIRules(){
  const persistent = (q('#persistentPrompt').value || '').trim();
  const adhoc = (q('#adHocPrompt').value || '').trim();
  localStorage.setItem('persistentPrompt', persistent);
  localStorage.setItem('adHocPrompt', adhoc);
  const context = { stops: state.stops.map((s,i)=>({ idx:i, name:s.name, urgent:!!s.urgent, minutes:s.minutes||0 })) };
  q('#aiStatus').textContent = 'Contacting AI…';
  try{
    const res = await fetch('/ai/interpret',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ persistent, adhoc, context }) });
    const data = await res.json();
    const ai = normalizeAIRules(data);
    if (state.lastCacheBuster !== ai.cache_buster){
      state.pairMetaCache = new Map();
      state.lastCacheBuster = ai.cache_buster;
    }
    q('#aiPreview').textContent = JSON.stringify(ai, null, 2);
    q('#aiStatus').textContent = 'AI rules applied';
    setTimeout(()=> q('#aiStatus').textContent = '', 1500);
    return ai;
  } catch(e){
    q('#aiStatus').textContent = 'AI offline → using fallback';
    const fb = fallbackInterpret(persistent + '\n' + adhoc);
    q('#aiPreview').textContent = JSON.stringify(fb, null, 2);
    return fb;
  }
}

function normalizeAIRules(r){
  const pick = (snake, camel, d) => (r?.[snake] !== undefined ? r[snake] : (r?.[camel] !== undefined ? r[camel] : d));
  const priority = String(pick('priority','priority','balanced')).toLowerCase();
  const avoidRaw = pick('avoid_road_names','avoidRoadNames', []);
  const avoidRoadNames = Array.isArray(avoidRaw) ? avoidRaw.map(String) : [];
  let urgent = +pick('urgent_weight','urgent', 1.0);
  let lateness = +pick('lateness_weight','lateness', 1.0);
  let wait = +pick('wait_weight','wait', 0.1);
  let avoidRoadPenalty = +pick('avoid_road_penalty','avoidRoadPenalty', 1200);
  if (!Number.isFinite(avoidRoadPenalty) || avoidRoadPenalty < 300) avoidRoadPenalty = 1200;
  if (!Number.isFinite(urgent) || urgent <= 0) urgent = 1;
  if (!Number.isFinite(lateness) || lateness <= 0) lateness = 1;
  if (!Number.isFinite(wait) || wait < 0.05) wait = 0.1;
  return { priority, avoidRoadNames, weights: { urgent, lateness, wait, avoidRoadPenalty }, cache_buster: r.cache_buster || Date.now() };
}

function fallbackInterpret(text){
  const avoid = [];
  const m = text.match(/avoid\s+([^\n]+)/ig);
  if (m){ m.forEach(line => {
    const names = line.replace(/avoid\s+/i,'').split(/[;,]| and /i).map(s=>s.trim()).filter(Boolean);
    avoid.push(...names);
  }); }
  return normalizeAIRules({ priority:'urgent', avoid_road_penalty:1200, avoid_road_names: avoid });
}

// === helpers ===
function refreshMarkerNumbers(){
  const show = q('#showNumbers').checked;
  const order = state.finalOrder ?? state.baseOrder;
  if (!order || !show){ state.stops.forEach(s => s.marker.setIcon(baseIcon('•',true))); return; }
  order.forEach((idx,k)=>{
    const dup = (k===order.length-1) && (order[0]===idx) && order.length>1;
    const label = dup ? '⮌' : String(k+1);
    state.stops[idx].marker.setIcon(baseIcon(label,false));
  });
}
function q(s){ return document.querySelector(s); }
function esc(s){ return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function attr(s){ return esc(s).replace(/"/g,'&quot;'); }
function hhmmToSec(str){ const [h,m]=str.split(':').map(Number); return (h*3600+m*60)|0; }
function secToHHMM(sec){ sec=Math.max(0,Math.floor(sec)); const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60); return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0'); }
function toast(msg){ q('#aiStatus').textContent = msg; setTimeout(()=> q('#aiStatus').textContent = '', 1400); }

window.addEventListener('load', initMap);
