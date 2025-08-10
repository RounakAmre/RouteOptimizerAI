
const state = {
  map: null,
  stops: [],
  baseOrder: null,
  finalOrder: null,
  routeLine: null,
  lastCacheBuster: null
};

function initMap(){
  const c = [32.7767, -96.7970];
  state.map = L.map('map').setView(c, 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(state.map);
  state.map.on('click', e => addStop(e.latlng));

  qs('#btnOptimize').addEventListener('click', () => mainOptimize(false));
  qs('#btnAdhocOptimize').addEventListener('click', () => mainOptimize(true));
  qs('#btnClear').addEventListener('click', clearAll);
  qs('#btnSavePersistent').addEventListener('click', () => {
    localStorage.setItem('persistentPrompt', qs('#persistentPrompt').value || '');
    qs('#persistStatus').textContent = 'Saved';
    setTimeout(()=>qs('#persistStatus').textContent='', 1200);
  });

  qs('#persistentPrompt').value = localStorage.getItem('persistentPrompt') || '';
  qs('#adHocPrompt').value = localStorage.getItem('adHocPrompt') || '';

  render();
}

function addStop(latlng){
  const i = state.stops.length;
  const marker = L.marker(latlng,{draggable:true,icon:iconBubble('•', true)}).addTo(state.map);
  marker.on('dragend', render);
  const stop = { marker, name: `Stop ${i+1}`, minutes: 5, urgent: false };
  state.stops.push(stop);
  marker.bindPopup(() => popupHtml(stop));
  render();
}

function clearAll(){
  state.stops.forEach(s => state.map.removeLayer(s.marker));
  state.stops = []; state.baseOrder = null; state.finalOrder = null;
  if (state.routeLine){ state.map.removeLayer(state.routeLine); state.routeLine = null; }
  render();
}

function render(){
  const list = qs('#stopList'); list.innerHTML='';
  state.stops.forEach((s,i) => {
    const {lat,lng} = s.marker.getLatLng();
    const row = document.createElement('div'); row.className='stop';
    row.innerHTML = `<div class="grid">
      <input type="text" value="${attr(s.name)}" data-i="${i}" data-f="name" placeholder="Stop name"/>
      <input type="number" min="0" step="1" value="${s.minutes}" data-i="${i}" data-f="minutes"/>
      <label><input type="checkbox" ${s.urgent?'checked':''} data-i="${i}" data-f="urgent"/> Urgent</label>
      <button class="del" data-i="${i}">✕</button>
    </div>
    <div class="tiny muted">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>`;
    list.appendChild(row);
  });
  list.querySelectorAll('input,button').forEach(el => {
    if (el.tagName==='BUTTON') el.addEventListener('click', onDelete);
    else { el.addEventListener('input', onEdit); el.addEventListener('change', onEdit); }
  });

  refreshMarkerNumbers();
  updateGmapsLink();
}

function onDelete(e){
  const i = +e.target.dataset.i;
  state.map.removeLayer(state.stops[i].marker);
  state.stops.splice(i,1);
  state.baseOrder = null; state.finalOrder = null;
  render();
}
function onEdit(e){
  const i = +e.target.dataset.i, f = e.target.dataset.f;
  if (f==='name') state.stops[i].name = e.target.value;
  if (f==='minutes') state.stops[i].minutes = Math.max(0, +e.target.value || 0);
  if (f==='urgent') state.stops[i].urgent = e.target.checked;
  state.stops[i].marker.setPopupContent(() => popupHtml(state.stops[i]));
  render();
}

function popupHtml(s){
  const {lat,lng} = s.marker.getLatLng();
  return `<b>${esc(s.name)}</b><br/>${lat.toFixed(5)}, ${lng.toFixed(5)}<br/>${s.urgent?'🚩 Urgent':'Normal'} · ${s.minutes} min`;
}

// MAIN FLOW
async function mainOptimize(useAdhoc){
  if (state.stops.length < 2) return alert('Add at least 2 stops');
  toggleBusy(true);
  try{
    // 1) heuristic baseline using OSRM table
    const coords = state.stops.map(s => s.marker.getLatLng());
    const coordStr = coords.map(c => `${c.lng},${c.lat}`).join(';');
    const tRes = await fetch(`https://router.project-osrm.org/table/v1/driving/${coordStr}?annotations=duration`);
    if (!tRes.ok) throw new Error('Matrix request failed');
    const matrix = await tRes.json();
    const dur = matrix.durations;
    const base = greedyOrder(dur);
    state.baseOrder = base.slice();

    // 2) decide if AI should be applied
    const persistent = (qs('#persistentPrompt').value || '').trim();
    const adhoc = useAdhoc ? (qs('#adHocPrompt').value || '').trim() : '';
    if (useAdhoc) { localStorage.setItem('adHocPrompt', adhoc); qs('#adhocStatus').textContent='Saved'; setTimeout(()=>qs('#adhocStatus').textContent='',1000); }

    if (!persistent && !adhoc){
      state.finalOrder = base.slice();
      await drawOrder(state.finalOrder);
      qs('#aiPreview').textContent = '';
      return;
    }

    // 3) AI rules -> minimal reordering
    const ai = await getAIRules(persistent, adhoc);
    qs('#aiPreview').textContent = JSON.stringify(ai, null, 2);
    const reordered = await reorderWithAI(base, ai);
    state.finalOrder = reordered;
    await drawOrder(state.finalOrder);
  }catch(e){
    console.error(e);
    alert('Optimize failed: ' + e.message);
  }finally{
    toggleBusy(false);
    render();
  }
}

// heuristic greedy NN starting at index 0
function greedyOrder(dur){
  const N = state.stops.length;
  const order = [0];
  const remaining = new Set(Array.from({length:N}, (_,i)=>i).filter(i=>i!==0));
  let current = 0;
  while (remaining.size){
    let best=null, bestT=Infinity;
    remaining.forEach(i => { const t = dur[current][i]; if (t < bestT){ bestT=t; best=i; } });
    order.push(best); remaining.delete(best); current = best;
  }
  return order;
}

// AI minimal reordering: urgent stable-first + local swaps for avoided roads
async function reorderWithAI(baseOrder, ai){
  let order = baseOrder.slice();
  if (ai.priority === 'urgent'){
    const urgent = order.filter(i => state.stops[i].urgent);
    const normal = order.filter(i => !state.stops[i].urgent);
    if (order[0] === 0){
      order = [0, ...urgent.filter(i=>i!==0), ...normal.filter(i=>i!==0)];
    } else {
      order = [...urgent, ...normal];
    }
  }
  if (ai.avoidRoadNames?.length){
    order = await localAdjSwaps(order, ai);
  }
  return order;
}

async function localAdjSwaps(order, ai){
  for (let k=0;k<order.length-1;k++){
    const a=order[k], b=order[k+1];
    const useAB = await legUsesAvoidedRoad(a,b, ai.avoidRoadNames);
    if (!useAB) continue;
    // try swapping pair
    const useBA = await legUsesAvoidedRoad(b,a, ai.avoidRoadNames);
    if (!useBA && useAB){
      const tmp = order[k]; order[k] = order[k+1]; order[k+1] = tmp;
    }
  }
  return order;
}

// Draw route EXACTLY in given order (no optimization)
async function drawOrder(order){
  const coords = order.map(i => state.stops[i].marker.getLatLng());
  const orderedStr = coords.map(c => `${c.lng},${c.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${orderedStr}?overview=full&geometries=geojson`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Route request failed');
  const j = await r.json();
  const geom = j.routes?.[0]?.geometry;
  if (!geom) throw new Error('No route found');
  const latlngs = geom.coordinates.map(([x,y])=>[y,x]);
  if (state.routeLine) state.map.removeLayer(state.routeLine);
  state.routeLine = L.polyline(latlngs, {weight:5,opacity:.95}).addTo(state.map);
  state.map.fitBounds(state.routeLine.getBounds(), {padding:[30,30]});
  refreshMarkerNumbers(order);
}

// --- AI API ---
async function getAIRules(persistent, adhoc){
  const context = { stops: state.stops.map((s,i)=>({ idx:i, name:s.name, urgent:!!s.urgent, minutes:s.minutes||0 })) };
  const res = await fetch('/ai/interpret', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ persistent, adhoc, context })
  });
  if (!res.ok) throw new Error('AI server error');
  const obj = await res.json();
  return normalizeAIRules(obj);
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

// Fuzzy leg avoid detection
async function legUsesAvoidedRoad(aIdx, bIdx, avoidList){
  if (!avoidList?.length) return false;
  const A = state.stops[aIdx].marker.getLatLng();
  const B = state.stops[bIdx].marker.getLatLng();
  const url = `https://router.project-osrm.org/route/v1/driving/${A.lng},${A.lat};${B.lng},${B.lat}?steps=true&overview=false`;
  const norm = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'').replace(/1(?=\d{2,})/g,'i');
  try{
    const r = await fetch(url); if (!r.ok) return false;
    const j = await r.json();
    const steps = j.routes?.[0]?.legs?.[0]?.steps || [];
    const hay = steps.map(s=> (s.name||'') + (s.ref? ' '+s.ref : '')).join('|');
    const H = norm(hay);
    return avoidList.some(raw => {
      const q = norm(raw);
      return q.length >= 4 && H.includes(q);
    });
  }catch{ return false; }
}

// Helpers
function refreshMarkerNumbers(orderOpt){
  const order = orderOpt || state.finalOrder || state.baseOrder;
  if (!order){ state.stops.forEach(s=>s.marker.setIcon(iconBubble('•',true))); return; }
  order.forEach((idx, k) => {
    const label = String(k+1);
    state.stops[idx].marker.setIcon(iconBubble(label,false));
  });
}
function iconBubble(html, ghost=false){
  return L.divIcon({ className:'num-icon', html:`<div class="bubble ${ghost?'ghost':''}">${html}</div>`, iconSize:[26,26], iconAnchor:[13,26], popupAnchor:[0,-28] });
}
function qs(sel){ return document.querySelector(sel); }
function esc(s){ return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function attr(s){ return esc(s).replace(/"/g,'&quot;'); }

function toggleBusy(isBusy){
  const btns = [
    ['#btnOptimize', 'Optimize'],
    ['#btnAdhocOptimize', 'Optimize with Ad Hoc'],
    ['#btnClear', 'Clear'],
    ['#btnSavePersistent', 'Save Persistent']
  ];
  btns.forEach(([sel, label]) => {
    const el = qs(sel);
    if (!el) return;
    el.disabled = isBusy;
    if (sel === '#btnOptimize') el.textContent = isBusy ? 'Optimizing…' : label;
    if (sel === '#btnAdhocOptimize') el.textContent = isBusy ? 'Optimizing…' : label;
  });
}

function updateGmapsLink(){
  const order = state.finalOrder ?? state.baseOrder ?? state.stops.map((_,i)=>i);
  const coords = order.map(i => state.stops[i].marker.getLatLng());
  const link = gmapsLink(coords);
  const a = document.querySelector('#googleMapsLink');
  if (coords.length >= 2){ a.href = link; a.removeAttribute('disabled'); }
  else { a.removeAttribute('href'); a.setAttribute('disabled','true'); }
}
function gmapsLink(coords){
  if (coords.length<2) return '#';
  const base='https://www.google.com/maps/dir/?api=1';
  const origin=`&origin=${coords[0].lat},${coords[0].lng}`;
  const dest=`&destination=${coords[coords.length-1].lat},${coords[coords.length-1].lng}`;
  const waypoints=coords.slice(1,-1).map(c=>`${c.lat},${c.lng}`).join('|');
  return base + origin + dest + '&travelmode=driving&waypoints=' + encodeURIComponent(waypoints);
}

window.addEventListener('load', initMap);
