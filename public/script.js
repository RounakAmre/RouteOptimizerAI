
// State
const state = {
  map: null,
  stops: [], // { marker, name, minutes, urgent, twStart, twEnd }
  routeLine: null,
  lastRoute: null,
  lastOrder: null,
  schedule: null,
  pairMetaCache: new Map(), // (a-b) -> { usesAvoided, checkedFor:Set }
};

// Boot
window.addEventListener('load', () => {
  initMap();
  // Pre-fill prompts from localStorage
  qs('#persistentPrompt').value = localStorage.getItem('persistentPrompt') || '';
  qs('#adHocPrompt').value = localStorage.getItem('adHocPrompt') || '';

  // Wire buttons
  qs('#btnOptimize').addEventListener('click', () => optimize(false));
  qs('#btnAiOptimize').addEventListener('click', () => optimize(true));
  qs('#btnAiOptimize2').addEventListener('click', () => optimize(true));
  qs('#btnExport').addEventListener('click', exportGPX);

  qs('#btnSavePersistent').addEventListener('click', () => {
    const text = qs('#persistentPrompt').value || '';
    localStorage.setItem('persistentPrompt', text);   // REPLACE old value
    state.pairMetaCache = new Map(); // reset leg cache when rules might change
    statusBlink('#persistStatus', 'Saved');
  });

  qs('#btnSaveAdHoc').addEventListener('click', () => {
    const text = qs('#adHocPrompt').value || '';
    localStorage.setItem('adHocPrompt', text);        // REPLACE old value
    state.pairMetaCache = new Map();
    statusBlink('#aiStatus', 'Saved');
  });
});

function initMap(){
  const center = [32.7767, -96.7970];
  state.map = L.map('map').setView(center, 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(state.map);
  state.map.on('click', e => addStop(e.latlng));
}

function addStop(latlng){
  const idx = state.stops.length;
  const marker = L.marker(latlng, { draggable: true, icon: baseDivIcon('•', true) }).addTo(state.map);
  marker.on('dragend', render);
  const stop = { marker, name: `Stop ${idx+1}`, minutes: 5, urgent: false, twStart: null, twEnd: null };
  state.stops.push(stop);
  marker.bindPopup(() => popupHtml(stop));
  render();
}

function popupHtml(s){
  const {lat,lng} = s.marker.getLatLng();
  const tw = (s.twStart!=null && s.twEnd!=null) ? `${secToHHMM(s.twStart)}–${secToHHMM(s.twEnd)}` : 'any time';
  return `<b>${escapeHtml(s.name)}</b><br/>${lat.toFixed(5)}, ${lng.toFixed(5)}<br/>`+
         `${s.urgent ? '🚩 Urgent' : 'Normal'} · ${s.minutes} min · ${tw}`;
}

function render(){
  const list = qs('#stopList'); list.innerHTML='';
  state.stops.forEach((s, i) => {
    const row = document.createElement('div'); row.className='stop';
    const {lat,lng} = s.marker.getLatLng();
    row.innerHTML = `
      <div class="grid">
        <input type="text" value="${escapeAttr(s.name)}" data-i="${i}" data-f="name" placeholder="Stop name"/>
        <input type="number" min="0" step="1" value="${s.minutes}" data-i="${i}" data-f="minutes" title="Service minutes"/>
        <input type="time" value="${s.twStart!=null ? secToHHMM(s.twStart) : ''}" data-i="${i}" data-f="twStart" title="Window from"/>
        <input type="time" value="${s.twEnd!=null ? secToHHMM(s.twEnd) : ''}" data-i="${i}" data-f="twEnd" title="Window to"/>
        <label><input type="checkbox" ${s.urgent?'checked':''} data-i="${i}" data-f="urgent"/> Urgent</label>
        <button class="del" data-i="${i}" title="Remove">✕</button>
      </div>
      <div class="coords">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
      <div class="coords" id="sch-${i}"></div>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll('input,button').forEach(el => {
    if (el.tagName === 'BUTTON') el.addEventListener('click', onDelete);
    else { el.addEventListener('input', onEdit); el.addEventListener('change', onEdit); }
  });

  // Update buttons
  qs('#btnOptimize').disabled = state.stops.length < 2;
  qs('#btnAiOptimize').disabled = state.stops.length < 2;
  qs('#btnAiOptimize2').disabled = state.stops.length < 2;
  qs('#btnExport').disabled = !state.lastRoute;

  refreshMarkerNumbers();
}

function onDelete(e){
  const i = Number(e.target.dataset.i);
  state.map.removeLayer(state.stops[i].marker);
  state.stops.splice(i,1);
  state.lastOrder = null; state.schedule = null;
  render();
}
function onEdit(e){
  const i = Number(e.target.dataset.i);
  const f = e.target.dataset.f;
  if (f === 'name') state.stops[i].name = e.target.value;
  if (f === 'minutes') state.stops[i].minutes = Math.max(0, Number(e.target.value||0));
  if (f === 'urgent') state.stops[i].urgent = e.target.checked;
  if (f === 'twStart') state.stops[i].twStart = e.target.value ? hhmmToSec(e.target.value) : null;
  if (f === 'twEnd') state.stops[i].twEnd = e.target.value ? hhmmToSec(e.target.value) : null;
  state.stops[i].marker.setPopupContent(() => popupHtml(state.stops[i]));
  render();
}

// Optimize
async function optimize(useAI){
  if (state.stops.length < 2) return;
  toggleBusy(true);
  try{
    const coords = state.stops.map(s => s.marker.getLatLng());
    const coordStr = coords.map(c => `${c.lng},${c.lat}`).join(';');

    // OSRM matrix
    const tRes = await fetch(`https://router.project-osrm.org/table/v1/driving/${coordStr}?annotations=duration`);
    if (!tRes.ok) throw new Error('Matrix request failed');
    const matrix = await tRes.json();
    if (!matrix.durations) throw new Error('Matrix missing durations');
    const dur = matrix.durations;

    const startSec = hhmmToSec(qs('#routeStart').value || '08:00');
    let built;
    if (useAI){
      const ai = await getAIRules();
      qs('#aiPreview').textContent = JSON.stringify(ai, null, 2);
      built = await buildOrderAI(dur, startSec, ai);
    } else {
      built = buildWindowAwareOrder(dur, startSec);
    }

    state.lastOrder = built.order;
    state.schedule = built.schedule;

    // Draw route for that order
    const orderedStr = state.lastOrder.map(i => `${coords[i].lng},${coords[i].lat}`).join(';');
    const routeUrl = `https://router.project-osrm.org/route/v1/driving/${orderedStr}?overview=full&geometries=geojson`;
    const rRes = await fetch(routeUrl);
    if (!rRes.ok) throw new Error('Route request failed');
    const rData = await rRes.json();
    state.lastRoute = rData;
    drawRoute(rData.routes[0].geometry.coordinates);

  } catch (err){
    alert('Routing failed: ' + err.message);
    console.error(err);
  } finally {
    toggleBusy(false);
    render();
  }
}

// Get AI rules (persistent + ad hoc). Replace stored prompts when saving.
async function getAIRules(){
  const persistent = (qs('#persistentPrompt').value || localStorage.getItem('persistentPrompt') || '').trim();
  const adhoc = (qs('#adHocPrompt').value || localStorage.getItem('adHocPrompt') || '').trim();
  const context = {
    stops: state.stops.map((s,i)=> ({
      idx: i, name: s.name, urgent: !!s.urgent,
      minutes: s.minutes || 0,
      window: (s.twStart!=null && s.twEnd!=null) ? [secToHHMM(s.twStart), secToHHMM(s.twEnd)] : null
    }))
  };
  qs('#aiStatus').textContent = 'Contacting AI…';
  try{
    const res = await fetch('/ai/interpret', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ persistent, adhoc, context })
    });
    if (!res.ok) throw new Error('AI server not available');
    const data = await res.json();
    const ai = normalizeAIRules(data);
    state.pairMetaCache = new Map(); // reset leg cache
    qs('#aiStatus').textContent = 'AI applied';
    setTimeout(()=>qs('#aiStatus').textContent='', 1000);
    return ai;
  } catch(e){
    console.error('AI call failed:', e);
    const fb = fallbackInterpret(persistent + '\n' + adhoc);
    state.pairMetaCache = new Map();
    qs('#aiStatus').textContent = 'AI offline → fallback';
    setTimeout(()=>qs('#aiStatus').textContent='', 1500);
    return fb;
  }
}

// Normalize both snake_case and camelCase
function normalizeAIRules(r){
  const pick = (snake, camel, d) => (r?.[snake] !== undefined ? r[snake] : (r?.[camel] !== undefined ? r[camel] : d));
  const priority = String(pick('priority','priority','balanced')).toLowerCase();
  const avoidRaw = pick('avoid_road_names','avoidRoadNames', []);
  const avoidRoadNames = Array.isArray(avoidRaw) ? avoidRaw.map(String) : [];
  const weights = {
    urgent: Number(pick('urgent_weight','urgent', 1.0)),
    lateness: Number(pick('lateness_weight','lateness', 1.0)),
    wait: Number(pick('wait_weight','wait', 0.1)),
    avoidRoadPenalty: Number(pick('avoid_road_penalty','avoidRoadPenalty', 300))
  };
  return { priority, avoidRoadNames, weights };
}

// Fallback: parse simple "avoid X" and "prioritize urgent"
function fallbackInterpret(text){
  const avoid = [];
  const m = text.match(/avoid\s+([^\n]+)/ig);
  if (m){
    m.forEach(line => {
      const names = line.replace(/avoid\s+/i,'').split(/[;,]| and /i).map(s=>s.trim()).filter(Boolean);
      avoid.push(...names);
    });
  }
  const priority = /prioriti(s|z)e\s+urgent/i.test(text) ? 'urgent'
        : /prioriti(s|z)e\s+(time|window)/i.test(text) ? 'timewindow' : 'balanced';
  state.pairMetaCache = new Map();
  return { priority, avoidRoadNames: avoid, weights: { urgent: 1, lateness: 1, wait: 0.1, avoidRoadPenalty: 300 } };
}

// Heuristic (no AI), still urgent-first pool
function buildWindowAwareOrder(dur, startSec){
  const urgent = new Set(state.stops.map((s,i)=> s.urgent ? i : -1).filter(i=>i>=0));
  const normal = new Set(state.stops.map((s,i)=> s.urgent ? -1 : i).filter(i=>i>=0));
  const order = [], schedule = [];
  let current = 0, clock = startSec;
  order.push(0);
  const svc0 = (state.stops[0].minutes||0)*60;
  schedule.push({idx:0, arrive:startSec, start:startSec, depart:startSec+svc0, feasible: windowFeasible(state.stops[0], startSec)});
  clock += svc0; urgent.delete(0); normal.delete(0);

  while (urgent.size || normal.size){
    const pool = urgent.size ? urgent : normal;
    let best=null, bestScore=Infinity, bestArrival=0, bestDepart=0, bestFeasible=false;
    pool.forEach(i => {
      const travel = dur[current][i] ?? Infinity;
      const arrive = clock + travel;
      const {feasible, startSrv, depart} = applyWindow(state.stops[i], arrive);
      const lateness = feasible ? 0 : Math.max(0, arrive - (state.stops[i].twEnd ?? arrive));
      const wait = Math.max(0, (state.stops[i].twStart ?? arrive) - arrive);
      const score = (feasible ? 0 : 1e6) + lateness + 0.001*travel + 0.0001*wait;
      if (score < bestScore){ best=i; bestScore=score; bestArrival=arrive; bestDepart=depart; bestFeasible=feasible; }
    });
    if (best==null) break;
    order.push(best);
    schedule.push({idx:best, arrive:bestArrival, start:bestDepart-(state.stops[best].minutes||0)*60, depart:bestDepart, feasible:bestFeasible});
    current = best; clock = bestDepart;
    urgent.delete(best); normal.delete(best);
  }
  if (qs('#roundTrip')?.checked && order[order.length-1] !== order[0]){
    order.push(order[0]); const travel = dur[current][order[0]] || 0; const arrive = clock + travel;
    schedule.push({idx:order[0], arrive, start:arrive, depart:arrive, feasible:true});
  }
  return { order, schedule };
}

// AI-aware builder
async function buildOrderAI(dur, startSec, ai){
  const order = [], schedule = [];
  const urgentSet = new Set(state.stops.map((s,i)=> s.urgent ? i : -1).filter(i=>i>=0));
  const normalSet = new Set(state.stops.map((s,i)=> s.urgent ? -1 : i).filter(i=>i>=0));

  let current = 0, clock = startSec;
  order.push(0);
  const svc0 = (state.stops[0].minutes||0)*60;
  schedule.push({idx:0, arrive:startSec, start:startSec, depart:startSec+svc0, feasible: windowFeasible(state.stops[0], startSec)});
  clock += svc0; urgentSet.delete(0); normalSet.delete(0);

  while (urgentSet.size || normalSet.size){
    let pool = (ai.priority === 'urgent' && urgentSet.size) ? urgentSet
             : (urgentSet.size ? urgentSet : normalSet);
    let best=null, bestScore=Infinity, bestArrival=0, bestDepart=0, bestFeasible=false;

    const results = await Promise.all([...pool].map(async i => {
      const travel = dur[current][i] ?? Infinity;
      const arrive = clock + travel;
      const {feasible, startSrv, depart} = applyWindow(state.stops[i], arrive);
      const lateness = feasible ? 0 : Math.max(0, arrive - (state.stops[i].twEnd ?? arrive));
      const wait = Math.max(0, (state.stops[i].twStart ?? arrive) - arrive);

      // Avoided road penalty
      let avoidPenalty = 0;
      if (ai.avoidRoadNames?.length){
        const usesAvoid = await legUsesAvoidedRoad(current, i, ai.avoidRoadNames);
        if (usesAvoid) avoidPenalty = ai.weights.avoidRoadPenalty;
      }

      // Strong urgency boost
      const urgentBoost = state.stops[i].urgent ? - (Math.max(1, ai.weights.urgent) * 600) : 0;

      const score = (feasible ? 0 : 1e6)
        + (ai.weights.lateness * lateness)
        + 0.001 * travel
        + (ai.weights.wait * wait)
        + avoidPenalty
        + urgentBoost;

      return { i, score, arrive, depart, feasible };
    }));

    results.forEach(r => { if (r.score < bestScore){ bestScore=r.score; best=r.i; bestArrival=r.arrive; bestDepart=r.depart; bestFeasible=r.feasible; } });
    if (best==null) break;

    order.push(best);
    schedule.push({idx:best, arrive:bestArrival, start:bestDepart-(state.stops[best].minutes||0)*60, depart:bestDepart, feasible:bestFeasible});
    if (urgentSet.has(best)) urgentSet.delete(best); else normalSet.delete(best);
    current = best; clock = bestDepart;
  }

  if (qs('#roundTrip')?.checked && order[order.length-1] !== order[0]){
    order.push(order[0]); const travel = dur[current][order[0]] || 0; const arrive = clock + travel;
    schedule.push({idx:order[0], arrive, start:arrive, depart:arrive, feasible:true});
  }
  return { order, schedule };
}

// Check if a leg uses any avoided road name via OSRM steps
async function legUsesAvoidedRoad(a, b, avoidList){
  const key = `${a}-${b}`;
  const cached = state.pairMetaCache.get(key);
  if (cached){
    let covered = true;
    avoidList.forEach(n => { if (!cached.checkedFor.has(String(n).toLowerCase())) covered = false; });
    if (covered) return cached.usesAvoided;
  }
  const A = state.stops[a].marker.getLatLng();
  const B = state.stops[b].marker.getLatLng();
  const url = `https://router.project-osrm.org/route/v1/driving/${A.lng},${A.lat};${B.lng},${B.lat}?steps=true&overview=false`;
  try{
    const res = await fetch(url);
    if (!res.ok) return false;
    const data = await res.json();
    const steps = data.routes?.[0]?.legs?.[0]?.steps || [];
    const names = steps.map(s => ((s.name||'') + ' ' + (s.ref||''))).join('|').toLowerCase();
    const found = avoidList.some(r => names.includes(String(r).toLowerCase()));
    state.pairMetaCache.set(key, { usesAvoided: found, checkedFor: new Set(avoidList.map(x => String(x).toLowerCase())) });
    return found;
  } catch(e){
    return false;
  }
}

// Helpers
function windowFeasible(stop, arrive){ if (stop.twStart==null || stop.twEnd==null) return true; return arrive <= stop.twEnd; }
function applyWindow(stop, arrive){
  const svc = (stop.minutes||0)*60;
  let feasible = true, startSrv = arrive;
  if (stop.twStart!=null && arrive < stop.twStart) startSrv = stop.twStart;
  if (stop.twEnd!=null && startSrv > stop.twEnd){ feasible = false; startSrv = arrive; }
  const depart = startSrv + svc;
  return {feasible, startSrv, depart};
}
function drawRoute(geojson){
  const latlngs = geojson.map(([lon,lat]) => [lat,lon]);
  if (state.routeLine) state.map.removeLayer(state.routeLine);
  state.routeLine = L.polyline(latlngs, { weight: 5, opacity: .95 }).addTo(state.map);
  state.map.fitBounds(state.routeLine.getBounds(), { padding: [30,30] });
  refreshMarkerNumbers();
}
function exportGPX(){
  if (!state.lastRoute) return;
  const coords = state.lastRoute.routes[0].geometry.coordinates;
  const pts = coords.map(([lng,lat]) => `<trkpt lat="${lat}" lon="${lng}"></trkpt>`).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Route Optimizer" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Optimized Route</name><trkseg>${pts}</trkseg></trk></gpx>`;
  const blob = new Blob([gpx], {type: 'application/gpx+xml'}); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'optimized-route.gpx'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function refreshMarkerNumbers(){
  const show = qs('#showNumbers')?.checked;
  const order = state.lastOrder;
  if (!order || !show){ state.stops.forEach(s => s.marker.setIcon(baseDivIcon('•',true))); return; }
  order.forEach((idx, k) => {
    const dup = (k === order.length-1) && (order[0] === idx) && order.length > 1;
    const label = dup ? '⮌' : String(k+1);
    state.stops[idx].marker.setIcon(baseDivIcon(label, false));
  });
}
function baseDivIcon(html, ghost=false){
  return L.divIcon({ className:'num-icon', html:`<div class="bubble ${ghost?'ghost':''}">${html}</div>`, iconSize:[26,26], iconAnchor:[13,26], popupAnchor:[0,-28] });
}
function toggleBusy(b){
  ['#btnOptimize','#btnAiOptimize','#btnAiOptimize2'].forEach(sel => {
    const btn = qs(sel); if (!btn) return;
    btn.textContent = b ? 'Optimizing…' : (sel==='#btnAiOptimize2' || sel==='#btnAiOptimize' ? 'Use AI + Optimize' : 'Optimize (Heuristic)');
    btn.disabled = b || state.stops.length < 2;
  });
}
function statusBlink(sel, msg){ const el = qs(sel); if (!el) return; el.textContent = msg; setTimeout(()=>el.textContent='', 1000); }
function qs(s){ return document.querySelector(s); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function escapeAttr(s){ return escapeHtml(s).replace(/"/g,'&quot;'); }
function hhmmToSec(str){ const [h,m]=str.split(':').map(Number); return (h*3600 + m*60)|0; }
function secToHHMM(sec){ sec=Math.max(0,Math.floor(sec)); const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60); return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0'); }
