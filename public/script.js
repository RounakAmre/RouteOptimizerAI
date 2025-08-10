
/* Route Optimizer with AI prompts (persistent + ad hoc) and GPT-3.5 proxy.
 * - Persistent rules saved to localStorage and always considered.
 * - Ad hoc prompt used when clicking AI Optimize; both are sent to the AI server.
 * - Fallback regex parser handles 'avoid <road name>' and 'prioritize urgent' if AI is offline.
 */
const state = {
  map: null,
  stops: [], // { marker, name, minutes, urgent, twStart, twEnd }
  routeLine: null,
  lastRoute: null,
  lastOrder: null,
  schedule: null,
  pairMetaCache: new Map(), // key "a-b" -> {usesAvoided:boolean, checkedFor:Set(road) }
};

function initMap(){
  const center = [32.7767, -96.7970];
  state.map = L.map('map').setView(center, 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(state.map);
  state.map.on('click', e => addStop(e.latlng));

  // Buttons
  qs('#btnOptimize').addEventListener('click', () => optimize(false));
  qs('#btnAiOptimize').addEventListener('click', () => optimize(true));
  qs('#btnAiOptimize2').addEventListener('click', () => optimize(true));
  qs('#btnClear').addEventListener('click', clearAll);
  qs('#btnExport').addEventListener('click', exportGPX);
  qs('#showNumbers').addEventListener('change', refreshMarkerNumbers);

  // Persistent prompt
  const saved = localStorage.getItem('persistentPrompt') || '';
  qs('#persistentPrompt').value = saved;
  qs('#btnSavePersistent').addEventListener('click', () => {
    localStorage.setItem('persistentPrompt', qs('#persistentPrompt').value);
    qs('#persistStatus').textContent = 'Saved';
    setTimeout(()=>qs('#persistStatus').textContent='', 1200);
  });

  render();
}

function baseDivIcon(html, ghost=false){
  return L.divIcon({
    className:'num-icon',
    html:`<div class="bubble ${ghost?'ghost':''}">${html}</div>`,
    iconSize:[26,26], iconAnchor:[13,26], popupAnchor:[0,-28],
  });
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
  return `<b>${escapeHtml(s.name)}</b><br/>${lat.toFixed(5)}, ${lng.toFixed(5)}<br/>
    <span>${s.urgent ? '🚩 Urgent' : 'Normal'}</span> · ${s.minutes} min · ${tw}`;
}

function clearAll(){
  state.stops.forEach(s => state.map.removeLayer(s.marker));
  state.stops = [];
  state.lastOrder = null; state.schedule = null;
  if (state.routeLine){ state.map.removeLayer(state.routeLine); state.routeLine = null; }
  render();
}

function render(){
  qs('#stopCount').textContent = state.stops.length;
  const list = qs('#stopList'); list.innerHTML = '';
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

  const drive = state.lastRoute?.routes?.[0];
  const driveDurMin = drive ? Math.round(drive.duration/60) : null;
  const driveDist = drive ? (drive.distance/1000).toFixed(1)+' km' : '—';
  const serviceMin = state.stops.reduce((a,s)=>a + (Number(s.minutes)||0), 0);
  const infeasible = state.schedule?.filter(x => !x.feasible).length || 0;
  qs('#driveDuration').textContent = driveDurMin!=null ? (driveDurMin+' min') : '—';
  qs('#totalDistance').textContent = driveDist;
  qs('#serviceDuration').textContent = serviceMin ? (serviceMin+' min') : '0 min';
  qs('#totalDuration').textContent = driveDurMin!=null ? (driveDurMin+serviceMin)+' min' : '—';
  qs('#infeasibleCount').textContent = String(infeasible);

  if (state.lastOrder && state.schedule){
    state.lastOrder.forEach((idx, k) => {
      const el = qs('#sch-'+idx);
      const sch = state.schedule[k];
      if (!el || !sch) return;
      el.innerHTML = `${sch.feasible?'✅':'⚠️'} Arr ${secToHHMM(sch.arrive)} · Start ${secToHHMM(sch.start)} · Leave ${secToHHMM(sch.depart)}`;
    });
  }

  // GMaps
  const order = state.lastOrder ?? state.stops.map((_,i)=>i);
  const coords = order.map(i => state.stops[i].marker.getLatLng());
  const link = buildGmapsLink(coords, qs('#roundTrip').checked);
  const a = qs('#googleMapsLink');
  if (coords.length >= 2){ a.href = link; a.removeAttribute('disabled'); }
  else { a.removeAttribute('href'); a.setAttribute('disabled','true'); }

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

function buildGmapsLink(coords, roundTrip){
  if (coords.length < 2) return '#';
  const base = 'https://www.google.com/maps/dir/?api=1';
  const origin = `&origin=${coords[0].lat},${coords[0].lng}`;
  const destCoord = roundTrip ? coords[0] : coords[coords.length-1];
  const dest = `&destination=${destCoord.lat},${destCoord.lng}`;
  const waypointsCoords = roundTrip ? coords.slice(1) : coords.slice(1,-1);
  const waypoints = waypointsCoords.map(c => `${c.lat},${c.lng}`).join('|');
  return base + origin + dest + '&travelmode=driving&waypoints=' + encodeURIComponent(waypoints);
}

async function optimize(useAI){
  if (state.stops.length < 2) return;
  toggleBusy(true);
  try{
    const coords = state.stops.map(s => s.marker.getLatLng());
    const coordStr = coords.map(c => `${c.lng},${c.lat}`).join(';');
    // OSRM matrix
    const tableUrl = `https://router.project-osrm.org/table/v1/driving/${coordStr}?annotations=duration`;
    const tRes = await fetch(tableUrl);
    if (!tRes.ok) throw new Error('Matrix request failed');
    const matrix = await tRes.json();
    if (!matrix.durations) throw new Error('Matrix missing durations');
    const dur = matrix.durations;

    const startSec = hhmmToSec(qs('#routeStart').value || '08:00');
    let built;
    if (useAI){
      const ai = await getAIRules();
      built = await buildOrderAI(dur, startSec, ai);
      qs('#aiPreview').textContent = JSON.stringify(ai, null, 2);
    } else {
      built = buildWindowAwareOrder(dur, startSec);
    }

    state.lastOrder = built.order;
    state.schedule = built.schedule;

    // Route for that order
    const orderedStr = state.lastOrder.map(i => `${coords[i].lng},${coords[i].lat}`).join(';');
    const avoid = qs('#avoidFerries').checked ? '&exclude=ferry' : '';
    const routeUrl = `https://router.project-osrm.org/route/v1/driving/${orderedStr}?overview=full&geometries=geojson${avoid}`;
    const rRes = await fetch(routeUrl);
    if (!rRes.ok) throw new Error('Route request failed');
    const rData = await rRes.json();
    if (!rData.routes || !rData.routes[0]) throw new Error('No route found');
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

// ===== AI integration =====
async function getAIRules(){
  const persistent = (qs('#persistentPrompt').value || localStorage.getItem('persistentPrompt') || '').trim();
  const adhoc = (qs('#adHocPrompt').value || '').trim();
  const context = {
    stops: state.stops.map((s,i)=> ({
      idx: i,
      name: s.name,
      urgent: !!s.urgent,
      minutes: s.minutes||0,
      window: (s.twStart!=null && s.twEnd!=null) ? [secToHHMM(s.twStart), secToHHMM(s.twEnd)] : null
    }))
  };
  qs('#aiStatus').textContent = 'Contacting AI…';
  try{
    const res = await fetch('/ai/interpret', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ persistent, adhoc, context })
    });
    if (!res.ok) throw new Error('AI server not running');
    const data = await res.json();
    qs('#aiStatus').textContent = 'AI applied';
    return normalizeAIRules(data);
  } catch (e){
    // fallback: regex parse
    const fb = fallbackInterpret(persistent + '\n' + adhoc);
    qs('#aiStatus').textContent = 'AI offline → using fallback';
    return fb;
  } finally {
    setTimeout(()=>qs('#aiStatus').textContent='', 1500);
  }
}

function normalizeAIRules(r){
  return {
    priority: (r.priority || 'balanced').toLowerCase(),
    avoidRoadNames: Array.isArray(r.avoid_road_names) ? r.avoid_road_names.map(String) : [],
    weights: {
      urgent: Number(r.urgent_weight ?? 1.0),
      lateness: Number(r.lateness_weight ?? 1.0),
      wait: Number(r.wait_weight ?? 0.1),
      avoidRoadPenalty: Number(r.avoid_road_penalty ?? 300), // seconds penalty if avoided road on leg
    }
  };
}

function fallbackInterpret(text){
  const avoid = [];
  const m = text.match(/avoid\s+([^\n]+)/ig);
  if (m){
    m.forEach(line => {
      const names = line.replace(/avoid\s+/i,'').split(/[;,]| and /i).map(s=>s.trim()).filter(Boolean);
      avoid.push(...names);
    });
  }
  let priority = /prioriti(s|z)e\s+urgent/i.test(text) ? 'urgent'
                : /prioriti(s|z)e\s+(time|window)/i.test(text) ? 'timewindow' : 'balanced';
  return normalizeAIRules({ priority, avoid_road_names: avoid });
}

// ===== Heuristics =====
function buildWindowAwareOrder(dur, startSec){
  const urgent = new Set(state.stops.map((s,i)=> s.urgent? i : -1).filter(i=>i>=0));
  const normal = new Set(state.stops.map((s,i)=> s.urgent? -1: i).filter(i=>i>=0));
  const order = []; const schedule = [];
  let current = 0; let clock = startSec;
  order.push(current);
  const svc0 = (state.stops[current].minutes||0)*60;
  schedule.push({idx: current, arrive: startSec, start: startSec, depart: startSec+svc0, feasible: windowFeasible(state.stops[current], startSec)});
  clock += svc0; urgent.delete(current); normal.delete(current);

  while (urgent.size || normal.size){
    const pool = urgent.size ? urgent : normal;
    let best = null, bestScore = Infinity, bestArrival=0, bestDepart=0, bestFeasible=false;
    pool.forEach(i => {
      const travel = dur[current][i] || Infinity;
      const arrive = clock + travel;
      const {feasible, startSrv, depart} = applyWindow(state.stops[i], arrive);
      const lateness = feasible ? 0 : Math.max(0, arrive - (state.stops[i].twEnd ?? arrive));
      const wait = Math.max(0, (state.stops[i].twStart ?? arrive) - arrive);
      const score = (feasible ? 0 : 1e6) + lateness + 0.001*travel + 0.0001*wait;
      if (score < bestScore){ best = i; bestScore = score; bestArrival=arrive; bestDepart=depart; bestFeasible=feasible; }
    });
    if (best==null) break;
    order.push(best);
    schedule.push({idx: best, arrive: bestArrival, start: bestDepart - (state.stops[best].minutes||0)*60, depart: bestDepart, feasible: bestFeasible});
    current = best; clock = bestDepart; urgent.delete(best); normal.delete(best);
  }
  if (qs('#roundTrip').checked && order[order.length-1] !== order[0]){
    order.push(order[0]); const travel = dur[current][order[0]] || 0; const arrive = clock + travel;
    schedule.push({idx: order[0], arrive, start: arrive, depart: arrive, feasible: true});
  }
  return {order, schedule};
}

// AI-aware builder that penalizes avoided roads and tunes weights/priority.
async function buildOrderAI(dur, startSec, ai){
  const order = []; const schedule = [];
  const urgentSet = new Set(state.stops.map((s,i)=> s.urgent? i : -1).filter(i=>i>=0));
  const normalSet = new Set(state.stops.map((s,i)=> s.urgent? -1: i).filter(i=>i>=0));

  let current = 0; let clock = startSec;
  order.push(current);
  const svc0 = (state.stops[current].minutes||0)*60;
  schedule.push({idx: current, arrive: startSec, start: startSec, depart: startSec+svc0, feasible: windowFeasible(state.stops[current], startSec)});
  clock += svc0; urgentSet.delete(current); normalSet.delete(current);

  while (urgentSet.size || normalSet.size){
    // choose pool based on AI priority
    let pool = (ai.priority==='urgent' && urgentSet.size) ? urgentSet
             : (ai.priority==='timewindow' && normalSet.size ? normalSet : (urgentSet.size ? urgentSet : normalSet));
    let best=null, bestScore=Infinity, bestArrival=0, bestDepart=0, bestFeasible=false;

    const promises = [];
    pool.forEach(i => {
      promises.push((async () => {
        const travel = dur[current][i] || Infinity;
        const arrive = clock + travel;
        const {feasible, startSrv, depart} = applyWindow(state.stops[i], arrive);
        const lateness = feasible ? 0 : Math.max(0, arrive - (state.stops[i].twEnd ?? arrive));
        const wait = Math.max(0, (state.stops[i].twStart ?? arrive) - arrive);
        // check avoided roads on this leg
        let avoidPenalty = 0;
        if (ai.avoidRoadNames?.length){
          const usesAvoid = await legUsesAvoidedRoad(current, i, ai.avoidRoadNames);
          if (usesAvoid) avoidPenalty = ai.weights?.avoidRoadPenalty ?? 300; // seconds
        }
        // weighted score
        const urgentBoost = (state.stops[i].urgent ? - (ai.weights?.urgent ?? 1.0) * 60 : 0); // subtract to prefer urgent
        const score = (feasible ? 0 : 1e6)
          + (ai.weights?.lateness ?? 1.0) * lateness
          + 0.001*travel
          + (ai.weights?.wait ?? 0.1) * wait
          + avoidPenalty
          + urgentBoost;
        return {i, score, arrive, depart, feasible};
      })());
    });

    const results = await Promise.all(promises);
    results.forEach(r => {
      if (r.score < bestScore){ bestScore=r.score; best=r.i; bestArrival=r.arrive; bestDepart=r.depart; bestFeasible=r.feasible; }
    });
    if (best==null) break;
    order.push(best);
    schedule.push({idx: best, arrive: bestArrival, start: bestDepart - (state.stops[best].minutes||0)*60, depart: bestDepart, feasible: bestFeasible});
    if (urgentSet.has(best)) urgentSet.delete(best); else normalSet.delete(best);
    current = best; clock = bestDepart;
  }

  if (qs('#roundTrip').checked && order[order.length-1] !== order[0]){
    order.push(order[0]);
    const travel = dur[current][order[0]] || 0; const arrive = clock + travel;
    schedule.push({idx: order[0], arrive, start: arrive, depart: arrive, feasible: true});
  }
  return {order, schedule};
}

// Fetch once per (a,b) pair and check if any step name matches avoided list.
async function legUsesAvoidedRoad(a, b, avoidList){
  const key = `${a}-${b}`;
  const cached = state.pairMetaCache.get(key);
  if (cached && cached.checkedFor){
    // If we've already checked for at least these roads, assume valid
    let allCovered = true;
    avoidList.forEach(name => { if (!cached.checkedFor.has(name.toLowerCase())) allCovered = false; });
    if (allCovered) return cached.usesAvoided;
  }
  const A = state.stops[a].marker.getLatLng();
  const B = state.stops[b].marker.getLatLng();
  const url = `https://router.project-osrm.org/route/v1/driving/${A.lng},${A.lat};${B.lng},${B.lat}?steps=true&overview=false`;
  try{
    const res = await fetch(url); if (!res.ok) throw 0;
    const data = await res.json();
    const steps = data.routes?.[0]?.legs?.[0]?.steps || [];
    const names = steps.map(s => (s.name || '') + ' ' + (s.ref || '')).join('|').toLowerCase();
    const found = avoidList.some(r => names.includes(String(r).toLowerCase()));
    const checkedFor = new Set(avoidList.map(x => String(x).toLowerCase()));
    state.pairMetaCache.set(key, { usesAvoided: found, checkedFor });
    return found;
  } catch(e){
    return false;
  }
}

// ===== helpers =====
function windowFeasible(stop, arrive){ if (stop.twStart==null || stop.twEnd==null) return true; return arrive <= stop.twEnd; }
function applyWindow(stop, arrive){
  const svc = (stop.minutes||0)*60;
  let feasible = true, startSrv = arrive;
  if (stop.twStart!=null && arrive < stop.twStart) startSrv = stop.twStart;
  if (stop.twEnd!=null && startSrv > stop.twEnd){ feasible = false; startSrv = arrive; }
  const depart = startSrv + svc;
  return {feasible, startSrv, depart};
}
function drawRoute(geojsonCoords){
  const latlngs = geojsonCoords.map(([lon,lat]) => [lat,lon]);
  if (state.routeLine) state.map.removeLayer(state.routeLine);
  state.routeLine = L.polyline(latlngs, { weight: 5, opacity: .95 }).addTo(state.map);
  state.map.fitBounds(state.routeLine.getBounds(), { padding: [30,30] });
}
function exportGPX(){
  if (!state.lastRoute) return;
  const coords = state.lastRoute.routes[0].geometry.coordinates;
  const gpxPoints = coords.map(([lng,lat]) => `<trkpt lat="${lat}" lon="${lng}"></trkpt>`).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Route Optimizer" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Optimized Route</name><trkseg>${gpxPoints}</trkseg></trk>
</gpx>`;
  const blob = new Blob([gpx], {type: 'application/gpx+xml'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'optimized-route.gpx';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function refreshMarkerNumbers(){
  const show = qs('#showNumbers').checked; const order = state.lastOrder;
  if (!order || !show){ state.stops.forEach(s => s.marker.setIcon(baseDivIcon('•', true))); return; }
  order.forEach((idx, k) => {
    const isLastDuplicate = (k === order.length-1) && (order[0] === idx) && order.length > 1;
    const label = isLastDuplicate ? '⮌' : String(k+1);
    state.stops[idx].marker.setIcon(baseDivIcon(label, false));
  });
}
function toggleBusy(b){
  ['#btnOptimize','#btnAiOptimize','#btnAiOptimize2'].forEach(sel => {
    const btn = qs(sel); if (!btn) return;
    btn.textContent = b ? 'Optimizing…' : (sel==='#btnAiOptimize2' ? 'Use AI + Optimize' : (sel==='#btnAiOptimize' ? 'AI Optimize (Persistent + Ad Hoc)' : 'Optimize (Heuristic)'));
    btn.disabled = b || state.stops.length < 2;
  });
}
function qs(sel){ return document.querySelector(sel); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function escapeAttr(s){ return escapeHtml(s).replace(/"/g,'&quot;'); }
function hhmmToSec(str){ const [h,m]=str.split(':').map(Number); return (h*3600 + m*60)|0; }
function secToHHMM(sec){ sec=Math.max(0,Math.floor(sec)); const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60); return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0'); }

window.addEventListener('load', initMap);
