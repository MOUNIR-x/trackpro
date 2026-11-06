let clientMapInstance = null;
let clientMarker = null;
let clientRoutePolyline = null;
let trackingRefreshTimer = null;
let activeTrackingNumber = '';

const apiBase = window.API_BASE || (window.location.protocol === 'file:' || (['localhost', '127.0.0.1'].includes(window.location.hostname) && window.location.port !== '3000' && window.location.port !== '') ? 'http://localhost:3000' : '');

function normalizePublicParcel(row) {
  if (!row) return null;
  const rawRoute = row.routegeojson || row.routeGeoJson || row.route;
  let parsedRoute = null;
  if (typeof rawRoute === 'string') {
    try { parsedRoute = JSON.parse(rawRoute); } catch { }
  } else if (rawRoute && typeof rawRoute === 'object') {
    parsedRoute = rawRoute;
  }

  const rawProgress = row.progress !== undefined ? row.progress : 0;
  const rawSpeed = row.simulationspeed !== undefined ? row.simulationspeed : (row.simulationSpeed !== undefined ? row.simulationSpeed : 30);
  const rawDist = row.distancetotal !== undefined ? row.distancetotal : (row.distanceTotal !== undefined ? row.distanceTotal : 0);
  const rawLat = row.currentlatitude !== undefined && row.currentlatitude !== null ? Number(row.currentlatitude) : (row.currentLatitude !== undefined && row.currentLatitude !== null ? Number(row.currentLatitude) : null);
  const rawLng = row.currentlongitude !== undefined && row.currentlongitude !== null ? Number(row.currentlongitude) : (row.currentLongitude !== undefined && row.currentLongitude !== null ? Number(row.currentLongitude) : null);

  return {
    id: Number(row.id),
    trackingNumber: row.trackingnumber || row.trackingNumber || '',
    recipientName: row.recipientname || row.recipientName || '',
    recipientPhone: row.recipientphone || row.recipientPhone || '',
    recipientEmail: row.recipientemail || row.recipientEmail || '',
    deliveryAddress: row.deliveryaddress || row.deliveryAddress || '',
    senderName: row.sendername || row.senderName || '',
    company: row.company || 'TrackPro',
    description: row.description || '',
    origin: row.origin || '',
    destination: row.destination || '',
    status: (row.status || 'pending').toLowerCase(),
    currentLatitude: rawLat,
    currentLongitude: rawLng,
    progress: Number(rawProgress) || 0,
    simulationSpeed: Number(rawSpeed) || 30,
    routeGeoJson: parsedRoute,
    route: parsedRoute,
    distanceTotal: Number(rawDist) || 0,
    createdAt: row.createdat || row.createdAt || new Date().toISOString(),
    updatedAt: row.updatedat || row.updatedAt || new Date().toISOString(),
  };
}

async function fetchPublicParcelByTrackingNumber(trackingNumber) {
  const supabase = window.trackproSupabase;
  if (supabase) {
    let { data, error } = await supabase.from('parcels').select('*').eq('trackingnumber', trackingNumber).maybeSingle();
    if (error || !data) {
      const fallback = await supabase.from('parcels').select('*').eq('trackingNumber', trackingNumber).maybeSingle();
      if (!fallback.error && fallback.data) {
        data = fallback.data;
      }
    }
    if (!data) throw new Error('Colis introuvable avec ce numéro de suivi');

    const parcel = normalizePublicParcel(data);
    let eventsData = [];
    try {
      const { data: evs } = await supabase.from('parcel_events').select('*').eq('parcelid', parcel.id).order('createdat', { ascending: true });
      eventsData = evs || [];
    } catch { /* ignore */ }

    return { parcel: { ...parcel, timeline: eventsData } };
  }

  const response = await fetch(`${apiBase}/api/public/track/${encodeURIComponent(trackingNumber)}`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || 'Colis introuvable');
  }
  return data;
}

function initializeClientPage() {
  const trackingInput = document.getElementById('trackingNumber');
  if (trackingInput) {
    trackingInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') trackColis();
    });
  }
}

function statusLabel(status) {
  const map = {
    pending: 'En attente',
    in_transit: 'En transit',
    delivered: 'Livré',
    paused: 'En pause',
    stopped: 'Arrêté',
  };
  return map[status] || 'En attente';
}

function statusClass(status) {
  const map = {
    pending: 'status-pending',
    in_transit: 'status-in_transit',
    delivered: 'status-delivered',
    paused: 'status-paused',
    stopped: 'status-stopped',
    archived: 'status-archived',
  };
  return map[status] || 'status-pending';
}

function parseRouteCoordinates(parcel) {
  const routeRaw = parcel.route || parcel.routeGeoJson;
  if (!routeRaw) return [];

  try {
    const route = typeof routeRaw === 'string' ? JSON.parse(routeRaw) : routeRaw;
    if (route.type === 'LineString' && Array.isArray(route.coordinates)) {
      return route.coordinates.map(([lng, lat]) => [Number(lng), Number(lat)]);
    }
  } catch {
    // ignore
  }

  return [];
}

function asLatLngFromRoute(routeCoordinates) {
  return routeCoordinates.map(([lng, lat]) => [Number(lat), Number(lng)]);
}

function resolveMapCenter(parcel) {
  const points = parseRouteCoordinates(parcel);
  if (points.length >= 2) {
    const [lng, lat] = points[0];
    return [lat, lng];
  }

  if (Number.isFinite(parcel.currentLatitude) && Number.isFinite(parcel.currentLongitude)) {
    return [parcel.currentLatitude, parcel.currentLongitude];
  }

  return [46.2276, 2.2137];
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function formatDistance(value) {
  if (!Number.isFinite(Number(value))) return '—';
  const distance = Number(value);
  return distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance)} m`;
}

function formatLastUpdate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function initializeClientPage() {
  const trackingInput = document.getElementById('trackingNumber');
  if (trackingInput) {
    trackingInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') trackColis();
    });
  }

  // Auto-suivi si numéro présent dans l'URL (?tracking=XYZ ou #XYZ)
  const urlParams = new URLSearchParams(window.location.search);
  const paramTracking = urlParams.get('tracking') || window.location.hash.replace('#', '').trim();
  if (paramTracking && trackingInput) {
    trackingInput.value = paramTracking;
    trackColis();
  }
}

function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0 min';
  const totalMins = Math.round(minutes);
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;

  if (days > 0) {
    return `${days}j ${hours}h ${mins}min`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}min`;
  }
  return `${mins} min`;
}

// --- Mise à jour silencieuse : ne touche que les éléments qui changent vraiment ---
function updateTrackingResultSilently(parcel) {
  const progress = Math.max(0, Math.min(100, Number(parcel.progress) || 0));
  const totalDistance = Number(parcel.distanceTotal) || 0;
  const distanceRemaining = Math.max(0, totalDistance * (1 - progress / 100));
  const speed = Number(parcel.simulationSpeed) || 30;

  // Barre de progression (smooth)
  const progressBar = document.getElementById('resultProgressBar');
  if (progressBar) progressBar.style.width = `${Math.round(progress)}%`;
  setText('resultProgressText', `${Math.round(progress)}%`);
  setText('resultDistanceRemaining', distanceRemaining > 0 ? `${distanceRemaining.toFixed(1)} km` : (parcel.status === 'delivered' ? '0 km' : '—'));

  // ETA : on recrée le countdown SEULEMENT si la vitesse/distance a changé significativement
  const newEtaSec = distanceRemaining > 0 && speed > 0 ? Math.ceil((distanceRemaining / speed) * 3600) : 0;
  const diff = Math.abs(newEtaSec - (window._etaLastSec || 0));
  // On resynchronise si décalage > 10s (nouveau poll avec vraies données)
  if (diff > 10 || window._etaLastSec === undefined) {
    window._etaLastSec = newEtaSec;
    if (window.etaCountdownInterval) {
      clearInterval(window.etaCountdownInterval);
      window.etaCountdownInterval = null;
    }
    if (parcel.status === 'delivered') {
      setText('resultEta', 'Livré');
    } else if (newEtaSec > 0) {
      let remaining = newEtaSec;
      const updateEta = () => {
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        setText('resultEta', `ETA ${mins}m ${secs < 10 ? '0' : ''}${secs}s`);
      };
      updateEta();
      window.etaCountdownInterval = setInterval(() => {
        if (remaining <= 0) {
          clearInterval(window.etaCountdownInterval);
          window.etaCountdownInterval = null;
          setText('resultEta', 'ETA —');
          return;
        }
        remaining--;
        window._etaLastSec = remaining;
        updateEta();
      }, 1000);
    } else {
      setText('resultEta', 'ETA —');
    }
  }

  // Status badge (seulement si changé)
  const badge = document.getElementById('resultStatus');
  if (badge && badge.dataset.status !== parcel.status) {
    badge.textContent = statusLabel(parcel.status);
    badge.className = `status-badge ${statusClass(parcel.status)}`;
    badge.dataset.status = parcel.status;
  }
}

function displayTrackingResult(parcel) {
  const resultSection = document.getElementById('trackingResult');
  if (resultSection) resultSection.style.display = 'block';

  const badge = document.getElementById('resultStatus');
  if (badge) {
    badge.textContent = statusLabel(parcel.status);
    badge.className = `status-badge ${statusClass(parcel.status)}`;
    badge.dataset.status = parcel.status;
  }

  const progress = Math.max(0, Math.min(100, Number(parcel.progress) || 0));
  const totalDistance = Number(parcel.distanceTotal) || 0;
  const distanceRemaining = Math.max(0, totalDistance * (1 - progress / 100));
  const speed = Number(parcel.simulationSpeed) || 30;
  const etaMinutes = distanceRemaining > 0 && speed > 0 ? (distanceRemaining / speed) * 60 : 0;

  const lastEvent = Array.isArray(parcel.timeline) && parcel.timeline.length ? parcel.timeline[parcel.timeline.length - 1] : null;
  const statusReason = parcel.statusReason || (lastEvent && (lastEvent.reason || lastEvent.note)) || 'En cours';

  setText('resultTrackingNumber', parcel.trackingNumber || '-');
  setText('resultExpediteur', parcel.senderName || parcel.company || '-');
  setText('resultDestinataire', parcel.recipientName || '-');
  setText('resultOrigin', parcel.origin || 'Position de départ');
  setText('resultDestination', parcel.destination || parcel.deliveryAddress || '—');
  setText('resultAdresse', parcel.deliveryAddress || '-');
  setText('resultUpdatedAt', formatLastUpdate(parcel.updatedAt || parcel.createdAt));
  setText('resultDistanceRemaining', distanceRemaining > 0 ? `${distanceRemaining.toFixed(1)} km` : (parcel.status === 'delivered' ? '0 km' : '—'));
  setText('resultSpeed', `${speed} km/h`);
  setText('resultProgressText', `${Math.round(progress)}%`);
  setText('resultLastEvent', lastEvent ? `${lastEvent.type || lastEvent.status || 'Mise à jour'} • ${lastEvent.note || 'Aucune note'}` : "Colis en cours d'acheminement");
  setText('resultStatusReason', statusReason);

  const progressBar = document.getElementById('resultProgressBar');
  if (progressBar) progressBar.style.width = `${Math.round(progress)}%`;

  // Countdown ETA (plein affichage initial)
  window._etaLastSec = undefined; // force recréation au premier affichage
  updateTrackingResultSilently(parcel);

  const timeline = document.getElementById('trackingTimeline');
  if (timeline) {
    timeline.innerHTML = '';
    const events = Array.isArray(parcel.timeline) && parcel.timeline.length ? parcel.timeline : [
      { type: 'created', note: 'Colis enregistré', status: parcel.status, createdAt: parcel.createdAt },
      { type: 'in_transit', note: 'Transport en cours', status: parcel.status, createdAt: parcel.updatedAt },
    ];

    [...events].slice(-5).reverse().forEach((event) => {
      const item = document.createElement('div');
      item.className = 'timeline-item done';
      const title = event.type || event.status || 'Mise à jour';
      const note = event.note || event.reason || 'Transport';
      item.innerHTML = `
        <div class="timeline-dot"></div>
        <div>
          <div class="timeline-title">${title}</div>
          <div class="timeline-desc">${note}</div>
          <div class="timeline-desc">${formatLastUpdate(event.createdAt || parcel.updatedAt || parcel.createdAt)}</div>
        </div>
      `;
      timeline.appendChild(item);
    });
  }
}

function initClientMap(parcel) {
  const mapElement = document.getElementById('clientMap');
  if (!mapElement) return;

  if (clientMapInstance) {
    clientMapInstance.remove();
    clientMapInstance = null;
    clientMarker = null;
    clientRoutePolyline = null;
  }

  const [lat, lng] = resolveMapCenter(parcel);
  clientMapInstance = L.map('clientMap').setView([lat, lng], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    subdomains: 'abc',
    maxZoom: 19,
    noWrap: false,
  }).addTo(clientMapInstance);

  const routePoints = asLatLngFromRoute(parseRouteCoordinates(parcel));
  if (routePoints.length > 1) {
    const statusKey = (parcel.status || 'pending').toString().trim().toLowerCase();
    const routeColor = {
      pending: '#0a0a0a',
      in_transit: '#0ea5e9',
      delivered: '#16a34a',
      paused: '#d97706',
      stopped: '#dc2626',
      archived: '#6b7280',
    }[statusKey] || '#0ea5e9';
    clientRoutePolyline = L.polyline(routePoints, {
      color: routeColor,
      weight: 5,
      opacity: parcel.status === 'paused' || parcel.status === 'stopped' ? 0.55 : 0.9,
      dashArray: parcel.status === 'paused' ? '8 12' : '',
    }).addTo(clientMapInstance);
    clientMapInstance.fitBounds(clientRoutePolyline.getBounds(), { padding: [40, 40] });
  }

  const progress = Math.max(0, Math.min(100, Number(parcel.progress) || 0));
  const coords = parseRouteCoordinates(parcel);
  let currentPos = [lat, lng];
  if (coords.length >= 2) {
    const totalSteps = coords.length - 1;
    const indexPos = (progress / 100) * totalSteps;
    const lower = Math.floor(indexPos);
    const upper = Math.min(coords.length - 1, lower + 1);
    const ratio = indexPos - lower;
    const [lngA, latA] = coords[lower];
    const [lngB, latB] = coords[upper];
    currentPos = [latA + (latB - latA) * ratio, lngA + (lngB - lngA) * ratio];
  } else if (Number.isFinite(parcel.currentLatitude) && Number.isFinite(parcel.currentLongitude)) {
    currentPos = [parcel.currentLatitude, parcel.currentLongitude];
  }

  clientMarker = L.circleMarker(currentPos, {
    radius: 11,
    color: '#ffffff',
    weight: 3,
    fillColor: '#0ea5e9',
    fillOpacity: 1,
  }).addTo(clientMapInstance);
  clientMarker.bindPopup(`<strong>${parcel.trackingNumber}</strong><br>${parcel.recipientName || '-'}<br>${statusLabel(parcel.status)}`);
}

function updateClientMap(parcel) {
  if (!clientMapInstance || !clientMarker) {
    initClientMap(parcel);
    return;
  }

  const progress = Math.max(0, Math.min(100, Number(parcel.progress) || 0));
  const coords = parseRouteCoordinates(parcel);
  let currentPos = null;
  if (coords.length >= 2) {
    const totalSteps = coords.length - 1;
    const indexPos = (progress / 100) * totalSteps;
    const lower = Math.floor(indexPos);
    const upper = Math.min(coords.length - 1, lower + 1);
    const ratio = indexPos - lower;
    const [lngA, latA] = coords[lower];
    const [lngB, latB] = coords[upper];
    currentPos = [latA + (latB - latA) * ratio, lngA + (lngB - lngA) * ratio];

    // Vérifier si la polyline doit être créée ou mise à jour
    const routePoints = asLatLngFromRoute(coords);
    if (!clientRoutePolyline) {
      clientRoutePolyline = L.polyline(routePoints, {
        color: '#0ea5e9',
        weight: 5,
        opacity: 0.9,
      }).addTo(clientMapInstance);
      clientMapInstance.fitBounds(clientRoutePolyline.getBounds(), { padding: [40, 40] });
    }
  } else if (Number.isFinite(parcel.currentLatitude) && Number.isFinite(parcel.currentLongitude)) {
    currentPos = [parcel.currentLatitude, parcel.currentLongitude];
  }

  if (currentPos) {
    clientMarker.setLatLng(currentPos);
    if (parcel.status === 'in_transit') {
      clientMapInstance.panTo(currentPos, { animate: true, duration: 1.2 });
    }
  }

  if (clientRoutePolyline) {
    const statusKey = (parcel.status || 'pending').toString().trim().toLowerCase();
    const routeColor = {
      pending: '#0a0a0a',
      in_transit: '#0ea5e9',
      delivered: '#16a34a',
      paused: '#d97706',
      stopped: '#dc2626',
    }[statusKey] || '#0ea5e9';
    clientRoutePolyline.setStyle({
      color: routeColor,
      dashArray: parcel.status === 'paused' ? '8 12' : '',
    });
  }

  clientMarker.bindPopup(`<strong>${parcel.trackingNumber}</strong><br>${parcel.recipientName || '-'}<br>${statusLabel(parcel.status)}`);
}

function renderClientMap(parcel) {
  initClientMap(parcel);
}

function makeMarkerIcon(status) {
  const colors = {
    pending: '#0a0a0a',
    in_transit: '#0ea5e9',
    delivered: '#16a34a',
    paused: '#d97706',
    stopped: '#dc2626',
    archived: '#6b7280',
  };

  const color = colors[(status || 'pending').toString().trim().toLowerCase()] || '#0ea5e9';
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="background:${color};width:22px;height:22px;border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.25);"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

async function loadTrackingParcel(trackingNumber, isRefresh = false) {
  try {
    const data = await fetchPublicParcelByTrackingNumber(trackingNumber);
    const payload = data.parcel || data;
    const parcel = payload.parcel || payload;
    if (!parcel) throw new Error('Colis introuvable');

    activeTrackingNumber = trackingNumber;

    if (isRefresh) {
      // Refresh silencieux : uniquement barre de progression + marqueur carte
      updateTrackingResultSilently(parcel);
      updateClientMap(parcel);
    } else {
      // Premier affichage : tout afficher
      displayTrackingResult(parcel);
      initClientMap(parcel);
    }
  } catch (error) {
    if (!isRefresh) alert(error.message || 'Impossible de trouver ce colis.');
  }
}

async function trackColis() {
  const value = document.getElementById('trackingNumber')?.value.trim();
  if (!value) {
    alert('Veuillez entrer un numéro de suivi');
    return;
  }

  if (trackingRefreshTimer) {
    clearInterval(trackingRefreshTimer);
    trackingRefreshTimer = null;
  }

  await loadTrackingParcel(value, false);

  // Polling toutes les 30s : sync silencieuse (uniquement barre de progression + carte)
  trackingRefreshTimer = setInterval(() => {
    if (activeTrackingNumber) {
      loadTrackingParcel(activeTrackingNumber, true).catch(() => { });
    }
  }, 30000);
}

window.addEventListener('load', initializeClientPage);
window.trackColis = trackColis;
