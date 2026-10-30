const apiBase = window.API_BASE || (window.location.protocol === 'file:' || (['localhost', '127.0.0.1'].includes(window.location.hostname) && window.location.port !== '3000' && window.location.port !== '') ? 'http://localhost:3000' : '');
const TRACKING_COLORS = {
  pending: '#0a0a0a',
  in_transit: '#0ea5e9',
  delivered: '#16a34a',
  paused: '#d97706',
  stopped: '#dc2626',
  archived: '#6b7280',
};
const state = {
  parcels: [],
  markers: [],
  map: null,
  routePolyline: null,
  activeParcelMarker: null,
  progressMarker: null,
  simulationTimer: null,
  selectedParcelId: null,
  startPoint: null,
  endPoint: null,
  searchTimeouts: { start: null, end: null },
};

function getToken() {
  return localStorage.getItem('trackpro_token');
}

function hasValidStoredToken() {
  const token = getToken();
  if (!token || !token.trim()) {
    return false;
  }

  try {
    const payloadPart = token.split('.')[1];
    if (!payloadPart) {
      return false;
    }

    const padded = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const normalized = padded.length % 4 === 0 ? padded : padded + '='.repeat(4 - (padded.length % 4));
    const payload = JSON.parse(atob(normalized));
    if (!payload || typeof payload.exp !== 'number') {
      return true;
    }

    return payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

function getSessionUser() {
  try {
    return JSON.parse(localStorage.getItem('trackpro_session') || 'null');
  } catch {
    return null;
  }
}

function normalizeParcelRow(row) {
  if (!row) return null;
  const rawRoute = row.routegeojson || row.routeGeoJson || row.route;
  let parsedRoute = null;
  if (typeof rawRoute === 'string') {
    try { parsedRoute = JSON.parse(rawRoute); } catch {}
  } else if (rawRoute && typeof rawRoute === 'object') {
    parsedRoute = rawRoute;
  }

  const rawProgress = row.progress !== undefined ? row.progress : 0;
  const rawSpeed = row.simulationspeed !== undefined ? row.simulationspeed : (row.simulationSpeed !== undefined ? row.simulationSpeed : 30);
  const rawDist = row.distancetotal !== undefined ? row.distancetotal : (row.distanceTotal !== undefined ? row.distanceTotal : 0);
  const rawLat = row.currentlatitude !== undefined && row.currentlatitude !== null ? Number(row.currentlatitude) : (row.currentLatitude !== undefined && row.currentLatitude !== null ? Number(row.currentLatitude) : null);
  const rawLng = row.currentlongitude !== undefined && row.currentlongitude !== null ? Number(row.currentlongitude) : (row.currentLongitude !== undefined && row.currentLongitude !== null ? Number(row.currentLongitude) : null);
  const rawRunning = row.isrunning !== undefined ? (Number(row.isrunning) === 1 || row.isrunning === true) : Boolean(row.isRunning);

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
    isRunning: rawRunning,
    routeGeoJson: parsedRoute,
    route: parsedRoute,
    distanceTotal: Number(rawDist) || 0,
    archived: Boolean(row.archived === true || Number(row.archived) === 1),
    createdAt: row.createdat || row.createdAt || new Date().toISOString(),
    updatedAt: row.updatedat || row.updatedAt || new Date().toISOString(),
  };
}

async function supabaseApiFetch(path, options = {}) {
  const supabase = window.trackproSupabase;
  if (!supabase) {
    throw new Error('Supabase n\'est pas initialisé.');
  }

  const method = (options.method || 'GET').toUpperCase();

  if (path === '/api/admin/stats') {
    const { data, error } = await supabase.from('parcels').select('*');
    if (error) throw error;

    const parcels = (data || []).map(normalizeParcelRow).filter(Boolean);
    const summary = {
      total: parcels.length,
      pending: parcels.filter((parcel) => parcel.status === 'pending').length,
      in_transit: parcels.filter((parcel) => parcel.status === 'in_transit').length,
      paused: parcels.filter((parcel) => parcel.status === 'paused').length,
      stopped: parcels.filter((parcel) => parcel.status === 'stopped').length,
      delivered: parcels.filter((parcel) => parcel.status === 'delivered').length,
      archived: parcels.filter((parcel) => parcel.archived).length,
    };

    return { stats: summary, parcels };
  }

  if (path === '/api/admin/parcels' && method === 'GET') {
    const { data, error } = await supabase.from('parcels').select('*').eq('archived', 0).order('createdat', { ascending: false });
    if (error) {
      // Fallback sans filtre archived si besoin
      const { data: fallbackData, error: fbError } = await supabase.from('parcels').select('*').order('createdat', { ascending: false });
      if (fbError) throw fbError;
      return { parcels: (fallbackData || []).map(normalizeParcelRow).filter((p) => !p.archived) };
    }
    return { parcels: (data || []).map(normalizeParcelRow) };
  }

  if (path === '/api/admin/parcels' && method === 'POST') {
    const payload = JSON.parse(options.body || '{}');
    const body = {
      trackingnumber: payload.trackingNumber || payload.trackingnumber,
      recipientname: payload.recipientName || payload.recipientname,
      recipientphone: payload.recipientPhone || payload.recipientphone || null,
      recipientemail: payload.recipientEmail || payload.recipientemail || null,
      deliveryaddress: payload.deliveryAddress || payload.deliveryaddress || '',
      sendername: payload.senderName || payload.sendername || null,
      company: payload.company || 'TrackPro',
      description: payload.description || null,
      origin: payload.origin || null,
      destination: payload.destination || payload.deliveryAddress || payload.deliveryaddress,
      status: payload.status || 'pending',
      progress: Number(payload.progress) || 0,
      simulationspeed: Number(payload.speed || payload.simulationSpeed || payload.simulationspeed || 30),
      routegeojson: payload.route ? JSON.stringify(payload.route) : (payload.routeGeoJson ? JSON.stringify(payload.routeGeoJson) : null),
      distancetotal: Number(payload.distanceTotal || payload.distancetotal || 0),
      archived: 0,
      currentlatitude: payload.currentLatitude ?? payload.currentlatitude ?? null,
      currentlongitude: payload.currentLongitude ?? payload.currentlongitude ?? null,
      isrunning: 0,
    };

    const { data, error } = await supabase.from('parcels').insert([body]).select().single();
    if (error) throw error;
    return { parcel: normalizeParcelRow(data) };
  }

  const parcelMatch = path.match(/^\/api\/admin\/parcels\/(\d+)(?:\/control)?$/);
  if (parcelMatch) {
    const parcelId = Number(parcelMatch[1]);
    if (method === 'DELETE') {
      const { error } = await supabase.from('parcels').update({ archived: 1, updatedat: new Date().toISOString() }).eq('id', parcelId);
      if (error) throw error;
      return { archived: true };
    }

    if (method === 'PATCH') {
      const payload = JSON.parse(options.body || '{}');
      const safePayload = {
        updatedat: new Date().toISOString(),
      };
      if (payload.origin !== undefined) safePayload.origin = payload.origin;
      if (payload.destination !== undefined) safePayload.destination = payload.destination;
      if (payload.deliveryAddress !== undefined || payload.deliveryaddress !== undefined) {
        safePayload.deliveryaddress = payload.deliveryAddress || payload.deliveryaddress;
      }
      if (payload.route || payload.routeGeoJson) {
        safePayload.routegeojson = JSON.stringify(payload.route || payload.routeGeoJson);
      }
      if (payload.status !== undefined) safePayload.status = payload.status;
      if (payload.progress !== undefined) safePayload.progress = Number(payload.progress);
      if (payload.simulationSpeed !== undefined || payload.simulationspeed !== undefined) {
        safePayload.simulationspeed = Number(payload.simulationSpeed ?? payload.simulationspeed);
      }
      if (payload.distanceTotal !== undefined || payload.distancetotal !== undefined) {
        safePayload.distancetotal = Number(payload.distanceTotal ?? payload.distancetotal);
      }
      if (payload.currentLatitude !== undefined || payload.currentlatitude !== undefined) {
        safePayload.currentlatitude = Number(payload.currentLatitude ?? payload.currentlatitude);
      }
      if (payload.currentLongitude !== undefined || payload.currentlongitude !== undefined) {
        safePayload.currentlongitude = Number(payload.currentLongitude ?? payload.currentlongitude);
      }
      if (payload.isRunning !== undefined || payload.isrunning !== undefined) {
        safePayload.isrunning = (payload.isRunning || payload.isrunning) ? 1 : 0;
      }

      const { data, error } = await supabase.from('parcels').update(safePayload).eq('id', parcelId).select().single();
      if (error) throw error;
      return { parcel: normalizeParcelRow(data) };
    }

    if (path.endsWith('/control') && method === 'POST') {
      const payload = JSON.parse(options.body || '{}');
      const { data: currentData, error: currentError } = await supabase.from('parcels').select('*').eq('id', parcelId).single();
      if (currentError) throw currentError;
      const currentParcel = normalizeParcelRow(currentData);

      let nextStatus = currentParcel.status;
      if (payload.action === 'start') nextStatus = 'in_transit';
      if (payload.action === 'pause') nextStatus = 'paused';
      if (payload.action === 'stop') nextStatus = 'stopped';
      if (payload.action === 'reset') nextStatus = 'pending';

      const nextUpdate = {
        status: nextStatus,
        progress: payload.action === 'reset' ? 0 : Number(payload.progress ?? currentParcel.progress ?? 0),
        simulationspeed: Number(payload.speed ?? currentParcel.simulationSpeed ?? 30),
        isrunning: payload.action === 'start' ? 1 : 0,
        updatedat: new Date().toISOString(),
      };

      if (payload.action === 'reset' && currentParcel.route && currentParcel.route.coordinates?.length) {
        const [firstLng, firstLat] = currentParcel.route.coordinates[0];
        nextUpdate.currentlatitude = firstLat;
        nextUpdate.currentlongitude = firstLng;
      }

      const { data, error } = await supabase.from('parcels').update(nextUpdate).eq('id', parcelId).select().single();
      if (error) throw error;

      // Enregistrer l'événement dans parcel_events
      try {
        await supabase.from('parcel_events').insert([{
          parcelid: parcelId,
          type: payload.action,
          status: nextStatus,
          reason: payload.reason || null,
          note: payload.note || `Action ${payload.action}`,
        }]);
      } catch (evErr) {
        // Ignorer si échec d'historisation
      }

      return { parcel: normalizeParcelRow(data), control: payload.action, reason: payload.reason || null };
    }
  }

  throw new Error('Route non prise en charge par Supabase');
}

async function apiFetch(path, options = {}) {
  const supabase = window.trackproSupabase;
  if (supabase && path.startsWith('/api/admin/')) {
    return supabaseApiFetch(path, options);
  }

  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers,
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text || 'Erreur API' };
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      localStorage.removeItem('trackpro_token');
      localStorage.removeItem('trackpro_session');
      window.location.href = 'login.html';
    }
    throw new Error(data.message || 'Une erreur est survenue.');
  }

  return data;
}

function ensureSession() {
  if (!hasValidStoredToken()) {
    localStorage.removeItem('trackpro_token');
    localStorage.removeItem('trackpro_session');
    window.location.href = 'login.html';
    return false;
  }
  return true;
}

function parseRouteCoordinates(parcel) {
  const raw = parcel.routeGeoJson || parcel.route;
  if (!raw) {
    return [];
  }

  try {
    const route = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (route.type === 'LineString' && Array.isArray(route.coordinates)) {
      return route.coordinates.map(([lng, lat]) => [Number(lng), Number(lat)]);
    }
  } catch {
    // ignore
  }

  return [];
}

function asLeafletLatLngCoordinates(routeCoordinates) {
  return routeCoordinates.map(([lng, lat]) => [Number(lat), Number(lng)]);
}

function resolveParcelCoordinates(parcel) {
  const coords = parseRouteCoordinates(parcel);
  if (coords.length >= 2) {
    const [lng, lat] = coords[0];
    return [lat, lng];
  }

  if (Number.isFinite(parcel.currentLatitude) && Number.isFinite(parcel.currentLongitude)) {
    return [parcel.currentLatitude, parcel.currentLongitude];
  }

  return [46.2276, 2.2137];
}

function statusLabel(status) {
  const map = {
    pending: 'En attente',
    in_transit: 'En transit',
    delivered: 'Livré',
    paused: 'En pause',
    stopped: 'Arrêté',
    archived: 'Archivé',
  };
  return map[status] || 'Inactif';
}

function statusClass(status) {
  const normalized = (status || 'pending').toString().trim().toLowerCase();
  return `status-${normalized === 'transit' ? 'in_transit' : normalized}`;
}

function getRouteColor(status) {
  const normalized = (status || 'pending').toString().trim().toLowerCase();
  return TRACKING_COLORS[normalized === 'transit' ? 'in_transit' : normalized] || TRACKING_COLORS.pending;
}

function initAdminPage() {
  if (!ensureSession()) return;
  renderUserProfile();
  bindNav();
  initMap();
  loadDashboard();
  // Rafraîchissement léger des stats et liste (pas la carte) toutes les 5s
  if (!window.__trackproLiveRefresh) {
    window.__trackproLiveRefresh = setInterval(() => {
      // Ne pas recharger si une simulation est en cours (le tick s'en charge)
      if (!state.simulationTimer) {
        loadDashboard().catch(() => {});
      }
    }, 5000);
  }
}

function renderUserProfile() {
  const user = getSessionUser();
  if (!user) return;
  const fullName = user.name || 'Admin';
  const email = user.email || 'admin@trackpro.com';
  const company = user.company || user.entreprise || 'TrackPro';

  const avatar = document.getElementById('userAvatar');
  const nameEl = document.getElementById('userName');
  const emailEl = document.getElementById('userEmail');
  const settingsName = document.getElementById('settingsName');
  const settingsEmail = document.getElementById('settingsEmail');
  const settingsCompany = document.getElementById('settingsCompany');

  if (avatar) avatar.textContent = fullName.charAt(0).toUpperCase();
  if (nameEl) nameEl.textContent = fullName;
  if (emailEl) emailEl.textContent = email;
  if (settingsName) settingsName.value = fullName;
  if (settingsEmail) settingsEmail.value = email;
  if (settingsCompany) settingsCompany.value = company;
}

function bindNav() {
  document.querySelectorAll('.nav-item[data-section]').forEach((item) => {
    item.removeEventListener('click', item.__navClickHandler);
    item.__navClickHandler = (event) => {
      event.preventDefault();
      showSection(item.dataset.section);
    };
    item.addEventListener('click', item.__navClickHandler);
  });
}

function showSection(section) {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  document.querySelectorAll('.mobile-nav-item').forEach((m) => m.classList.remove('active'));
  document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));

  const navItem = document.querySelector(`.nav-item[data-section="${section}"]`);
  if (navItem) navItem.classList.add('active');

  const mobileNavItem = document.querySelector(`.mobile-nav-item[data-section="${section}"]`);
  if (mobileNavItem) mobileNavItem.classList.add('active');

  const target = document.getElementById(`section-${section}`);
  if (target) target.classList.add('active');

  const titles = {
    dashboard: 'Tableau de bord',
    colis: 'Mes colis',
    map: 'Carte live',
    settings: 'Paramètres',
  };

  const pageTitle = document.getElementById('pageTitle');
  if (pageTitle) pageTitle.textContent = titles[section] || 'Tableau de bord';

  if (section === 'map' && state.map) {
    setTimeout(() => state.map.invalidateSize(), 150);
  }
}

async function loadDashboard() {
  try {
    const [statsData, parcelsData] = await Promise.all([
      apiFetch('/api/admin/stats'),
      apiFetch('/api/admin/parcels'),
    ]);

    state.parcels = parcelsData.parcels || [];
    renderStats(statsData.stats || {});
    renderRecentColis();
    renderColisList();
    renderActivity();
    renderSelectOptions();
    renderMapMarkers();
  } catch (error) {
    alert(error.message || 'Impossible de charger les colis.');
  }
}

function renderStats(stats) {
  const total = Number(stats.total || state.parcels.length || 0);
  const transit = Number(stats.in_transit || 0);
  const delivered = Number(stats.delivered || 0);
  const distance = Number(stats.distance || 0);

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  setText('statTotal', String(total));
  setText('statTransit', String(transit));
  setText('statDelivered', String(delivered));
  setText('statDistance', `${distance || Math.round(total * 120)} km`);
}

function renderRecentColis() {
  const container = document.getElementById('recentColisList');
  if (!container) return;

  container.innerHTML = '';

  state.parcels.slice(0, 4).forEach((parcel) => {
    const item = document.createElement('div');
    item.className = 'colis-item';
    item.innerHTML = `
      <div class="colis-item-header">
        <strong>${parcel.trackingNumber}</strong>
        <span class="colis-status ${statusClass(parcel.status)}">${statusLabel(parcel.status)}</span>
      </div>
      <div>${parcel.recipientName || '-'}</div>
      <div class="text-muted">${parcel.deliveryAddress || parcel.destination || '-'}</div>
    `;
    container.appendChild(item);
  });
}

function renderColisList() {
  const container = document.getElementById('colisFullList');
  if (!container) return;

  container.innerHTML = '';

  state.parcels.forEach((parcel) => {
    const item = document.createElement('div');
    item.className = 'colis-full-item';
    item.innerHTML = `
      <div class="colis-full-header">
        <div><strong>${parcel.trackingNumber}</strong></div>
        <span class="colis-status ${statusClass(parcel.status)}">${statusLabel(parcel.status)}</span>
      </div>
      <div><strong>Destinataire :</strong> ${parcel.recipientName || '-'}</div>
      <div><strong>Livraison :</strong> ${parcel.deliveryAddress || '-'}</div>
    `;
    item.addEventListener('click', () => {
      const select = document.getElementById('selectedColis');
      if (select) select.value = String(parcel.id);
      selectParcel(parcel.id);
      showSection('map');
    });
    container.appendChild(item);
  });
}

function renderActivity() {
  const container = document.getElementById('activityLog');
  if (!container) return;

  const events = [];
  state.parcels.forEach((parcel) => {
    const safeStatus = statusLabel(parcel.status);
    events.push({
      text: `${parcel.trackingNumber} — ${safeStatus}`,
      time: parcel.updatedAt || parcel.createdAt,
    });
  });

  container.innerHTML = '';
  events.slice(0, 6).forEach((event) => {
    const row = document.createElement('div');
    row.className = 'colis-item';
    row.innerHTML = `<div>${event.text}</div><div class="text-muted">${new Date(event.time).toLocaleString('fr-FR')}</div>`;
    container.appendChild(row);
  });
}

function renderSelectOptions() {
  const select = document.getElementById('selectedColis');
  if (!select) return;

  const previousSelection = state.selectedParcelId || select.value || (state.parcels[0] ? String(state.parcels[0].id) : '');
  select.innerHTML = '<option value="">Sélectionner un colis...</option>';

  state.parcels.forEach((parcel) => {
    const option = document.createElement('option');
    option.value = String(parcel.id);
    option.textContent = `${parcel.trackingNumber} · ${parcel.recipientName || 'Client'}`;
    if (String(parcel.id) === String(previousSelection)) {
      option.selected = true;
    }
    select.appendChild(option);
  });

  if (previousSelection) {
    select.value = String(previousSelection);
  }

  state.selectedParcelId = select.value || null;
}

function clampProgress(value) {
  return Math.min(100, Math.max(0, Number(value) || 0));
}

function getSelectedParcelId() {
  const select = document.getElementById('selectedColis');
  if (select && select.value) {
    state.selectedParcelId = select.value;
    return String(select.value);
  }
  return state.selectedParcelId ? String(state.selectedParcelId) : null;
}

function getSelectedParcel() {
  const selectedId = getSelectedParcelId();
  if (!selectedId) return null;
  return state.parcels.find((parcel) => String(parcel.id) === String(selectedId)) || null;
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

function updateTrackingInfo(parcel) {
  const trackingInfo = document.getElementById('trackingInfo');
  if (!trackingInfo) return;

  if (!parcel) {
    trackingInfo.style.display = 'none';
    return;
  }

  const progress = clampProgress(parcel.progress);
  const routeDistance = Number(parcel.distanceTotal) || 0;
  const remainingDistance = Math.max(0, routeDistance * (1 - progress / 100));
  const speed = Math.max(10, Math.min(1000, Number(parcel.simulationSpeed) || 90));
  const remainingMinutes = remainingDistance > 0 && speed > 0 ? (remainingDistance / speed) * 60 : 0;

  const progressValue = `${Math.round(progress)}%`;
  const currentAddress = parcel.currentAddress || parcel.deliveryAddress || parcel.destination || 'Position actuelle';

  const progressPercent = document.getElementById('progressPercent');
  const progressBar = document.getElementById('progressBar');
  const manualProgress = document.getElementById('manualProgress');
  const manualProgressValue = document.getElementById('manualProgressValue');
  const simSpeedInput = document.getElementById('simSpeed');
  const simSpeedValue = document.getElementById('simSpeedValue');
  const popupDistance = document.getElementById('distanceRemaining');
  const popupTime = document.getElementById('timeRemaining');
  const popupCurrentAddress = document.getElementById('currentAddress');

  if (popupCurrentAddress) popupCurrentAddress.textContent = currentAddress;
  if (popupDistance) popupDistance.textContent = `${remainingDistance.toFixed(1)} km`;
  if (popupTime) popupTime.textContent = formatDuration(remainingMinutes);
  if (progressPercent) progressPercent.textContent = progressValue;
  if (progressBar) progressBar.style.width = `${Math.round(progress)}%`;
  if (manualProgress && document.activeElement !== manualProgress) {
    manualProgress.value = Math.round(progress);
  }
  if (manualProgressValue) manualProgressValue.textContent = `${Math.round(progress)}%`;
  if (simSpeedInput && document.activeElement !== simSpeedInput) {
    simSpeedInput.value = speed;
  }
  if (simSpeedValue) simSpeedValue.textContent = speed;

  // Afficher badges d'itinéraire si disponibles
  if (parcel.origin) {
    const startBadge = document.getElementById('startLocation');
    if (startBadge) {
      startBadge.innerHTML = `<strong>🟢 Départ :</strong> ${parcel.origin}`;
      startBadge.style.display = 'block';
    }
    const startInput = document.getElementById('startSearch');
    if (startInput && !startInput.value) startInput.value = parcel.origin.split(',')[0];
  }
  if (parcel.destination) {
    const endBadge = document.getElementById('endLocation');
    if (endBadge) {
      endBadge.innerHTML = `<strong>🔴 Arrivée :</strong> ${parcel.destination}`;
      endBadge.style.display = 'block';
    }
    const endInput = document.getElementById('endSearch');
    if (endInput && !endInput.value) endInput.value = parcel.destination.split(',')[0];
  }

  if (routeDistance > 0) {
    const distEl = document.getElementById('routeDistance');
    const durEl = document.getElementById('routeDuration');
    const infoEl = document.getElementById('routeInfo');
    if (distEl) distEl.textContent = `${routeDistance.toFixed(1)} km`;
    if (durEl) durEl.textContent = formatDuration((routeDistance / speed) * 60);
    if (infoEl) infoEl.style.display = 'block';
  }

  trackingInfo.style.display = 'block';
}

function updateSimSpeed() {
  const speedInput = document.getElementById('simSpeed');
  if (!speedInput) return;
  const speed = Math.max(10, Math.min(1000, Number(speedInput.value) || 90));
  const speedValEl = document.getElementById('simSpeedValue');
  if (speedValEl) speedValEl.textContent = speed;

  const parcel = getSelectedParcel();
  if (!parcel) return;

  parcel.simulationSpeed = speed;
  const idx = state.parcels.findIndex((p) => String(p.id) === String(parcel.id));
  if (idx !== -1) {
    state.parcels[idx].simulationSpeed = speed;
  }

  // Mettre à jour l'estimation de temps restant et durée
  updateTrackingInfo(parcel);

  // Sauvegarder dans Supabase avec un léger debounce
  if (state.speedTimeout) clearTimeout(state.speedTimeout);
  state.speedTimeout = setTimeout(() => {
    apiFetch(`/api/admin/parcels/${parcel.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ simulationSpeed: speed }),
    }).catch(() => {});
  }, 350);
}

function routePointAtProgress(parcel, progress) {
  const route = parseRouteCoordinates(parcel);
  if (route.length < 2) {
    return resolveParcelCoordinates(parcel);
  }

  const safeProgress = clampProgress(progress);
  const totalSteps = route.length - 1;
  const indexPosition = (safeProgress / 100) * totalSteps;
  const lowerIndex = Math.floor(indexPosition);
  const upperIndex = Math.min(route.length - 1, lowerIndex + 1);
  const ratio = totalSteps === 0 ? 0 : indexPosition - lowerIndex;

  const [lngA, latA] = route[lowerIndex];
  const [lngB, latB] = route[upperIndex];

  const lat = latA + ((latB - latA) * ratio);
  const lng = lngA + ((lngB - lngA) * ratio);

  return [lat, lng];
}

function getRouteDistanceKm(parcel) {
  const route = parseRouteCoordinates(parcel);
  if (route.length < 2) {
    return Number(parcel.distanceTotal) || 0;
  }

  let totalDistance = 0;
  for (let index = 0; index < route.length - 1; index += 1) {
    const [lng1, lat1] = route[index];
    const [lng2, lat2] = route[index + 1];
    const earthRadiusKm = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    totalDistance += earthRadiusKm * c;
  }

  return Number.isFinite(totalDistance) ? totalDistance : Number(parcel.distanceTotal) || 0;
}

function renderHighlightedRoute(parcel) {
  if (!state.map || !parcel) return;

  const route = parseRouteCoordinates(parcel);
  if (route.length < 2) return;

  if (state.routePolyline && state.map.hasLayer(state.routePolyline)) {
    state.map.removeLayer(state.routePolyline);
  }

  const latLngRoute = asLeafletLatLngCoordinates(route);
  state.routePolyline = L.polyline(latLngRoute, {
    color: getRouteColor(parcel.status),
    weight: 5,
    opacity: 0.9,
    dashArray: parcel.status === 'paused' ? '10 12' : '0',
    lineCap: 'round',
  }).addTo(state.map);
}

function initMap() {
  const mapNode = document.getElementById('map');
  if (!mapNode) return;

  state.map = L.map('map', { zoomControl: true }).setView([46.2276, 2.2137], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    subdomains: 'abc',
    maxZoom: 19,
    noWrap: false,
  }).addTo(state.map);

  requestAnimationFrame(() => {
    if (state.map) {
      state.map.invalidateSize();
    }
  });

  setTimeout(() => {
    if (state.map) {
      state.map.invalidateSize();
    }
  }, 250);
}

function renderMapMarkers(preserveView = false) {
  if (!state.map) return;

  state.markers.forEach((marker) => state.map.removeLayer(marker));
  state.markers = [];

  if (state.progressMarker && state.map.hasLayer(state.progressMarker)) {
    state.map.removeLayer(state.progressMarker);
  }
  state.progressMarker = null;

  if (!state.parcels.length) {
    return;
  }

  const activeParcelId = getSelectedParcelId() || String(state.parcels[0].id);
  const activeParcel = state.parcels.find((parcel) => String(parcel.id) === String(activeParcelId)) || state.parcels[0];

  state.parcels.forEach((parcel) => {
    const [lat, lng] = resolveParcelCoordinates(parcel);
    const isSelected = String(parcel.id) === String(activeParcelId);
    const marker = L.marker([lat, lng], {
      icon: makeMarkerIcon(parcel.status || 'pending', isSelected),
      keyboard: true,
    })
      .addTo(state.map)
      .bindPopup(`
        <div style="min-width:180px;">
          <div style="font-weight:700; margin-bottom:6px;">${parcel.trackingNumber}</div>
          <div>${parcel.recipientName || '-'}</div>
          <div style="color:#6b7280; font-size:12px; margin-top:4px;">${parcel.deliveryAddress || '-'}</div>
          <div style="margin-top:8px;"><strong>Statut :</strong> ${statusLabel(parcel.status)}</div>
        </div>
      `);

    marker.on('click', () => {
      state.selectedParcelId = String(parcel.id);
      const selectEl = document.getElementById('selectedColis');
      if (selectEl) selectEl.value = String(parcel.id);
      renderMapMarkers();
      showSection('map');
    });

    state.markers.push(marker);
  });

  const selectedParcel = activeParcel || state.parcels[0];
  const progressPoint = routePointAtProgress(selectedParcel, clampProgress(selectedParcel.progress));
  const progressMarker = L.circleMarker(progressPoint, {
    radius: 9,
    color: '#111111',
    weight: 3,
    fillColor: '#111111',
    fillOpacity: 1,
    pane: 'markerPane',
  }).addTo(state.map);
  state.progressMarker = progressMarker;

  updateTrackingInfo(selectedParcel);
  renderHighlightedRoute(selectedParcel);

  if (!preserveView) {
    const boundsPoints = parseRouteCoordinates(selectedParcel);
    if (boundsPoints.length >= 2) {
      const latLngBounds = asLeafletLatLngCoordinates(boundsPoints);
      state.map.fitBounds(latLngBounds, { padding: [35, 35] });
    } else {
      state.map.setView(progressPoint, 6);
    }
  }
}

function stopSimulation() {
  if (state.simulationTimer) {
    clearInterval(state.simulationTimer);
    state.simulationTimer = null;
  }
}

// Met à jour directement le marqueur Leaflet et les infos sans refetch
function applyProgressToMap(parcel, nextProgress, nextPoint) {
  // Mettre à jour le marqueur de progression sur la carte
  if (state.progressMarker) {
    state.progressMarker.setLatLng(nextPoint);
  }

  // Mettre à jour le marqueur principal du colis
  const parcelIdx = state.markers.findIndex((_, i) => {
    const p = state.parcels[i];
    return p && String(p.id) === String(parcel.id);
  });
  if (parcelIdx !== -1 && state.markers[parcelIdx]) {
    state.markers[parcelIdx].setLatLng(nextPoint);
  }

  // Mettre à jour les données en mémoire
  const idx = state.parcels.findIndex((p) => String(p.id) === String(parcel.id));
  if (idx !== -1) {
    state.parcels[idx] = {
      ...state.parcels[idx],
      progress: nextProgress,
      currentLatitude: nextPoint[0],
      currentLongitude: nextPoint[1],
      status: 'in_transit',
    };
  }

  // Mettre à jour l'UI de tracking sans recharger
  const updatedParcel = state.parcels[idx !== -1 ? idx : 0];
  if (updatedParcel) updateTrackingInfo(updatedParcel);
}

async function advanceSimulationTick() {
  const parcel = getSelectedParcel();
  if (!parcel) return;

  if (parcel.status !== 'in_transit' && !parcel.isRunning) {
    stopSimulation();
    return;
  }

  const currentProgress = clampProgress(parcel.progress);
  if (currentProgress >= 100) {
    stopSimulation();
    try {
      await apiFetch(`/api/admin/parcels/${parcel.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'delivered', progress: 100, isRunning: 0 }),
      });
    } catch { /* ignore */ }
    await loadDashboard();
    return;
  }

  const speed = Math.max(10, Math.min(1000, Number(parcel.simulationSpeed) || 90));
  const routeDistanceKm = Math.max(0.1, getRouteDistanceKm(parcel) || Number(parcel.distanceTotal) || 1);
  const distanceMovedKm = (speed / 3600) * 1;
  const increment = (distanceMovedKm / routeDistanceKm) * 100;
  const nextProgress = clampProgress(currentProgress + increment);
  const nextPoint = routePointAtProgress(parcel, nextProgress);

  applyProgressToMap(parcel, nextProgress, nextPoint);

  apiFetch(`/api/admin/parcels/${parcel.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'in_transit',
      progress: nextProgress,
      currentLatitude: nextPoint[0],
      currentLongitude: nextPoint[1],
      isRunning: 1,
      simulationSpeed: speed,
    }),
  }).catch(() => { /* ignore */ });
}

function onManualProgressInput(value) {
  const parcel = getSelectedParcel();
  if (!parcel) return;
  const progress = clampProgress(value);
  const nextPoint = routePointAtProgress(parcel, progress);
  applyProgressToMap(parcel, progress, nextPoint);
}

async function onManualProgressChange(value) {
  const parcel = getSelectedParcel();
  if (!parcel) return;
  const progress = clampProgress(value);
  const nextPoint = routePointAtProgress(parcel, progress);
  applyProgressToMap(parcel, progress, nextPoint);

  try {
    await apiFetch(`/api/admin/parcels/${parcel.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        progress,
        currentLatitude: nextPoint[0],
        currentLongitude: nextPoint[1],
        status: progress >= 100 ? 'delivered' : 'in_transit',
      }),
    });
  } catch { /* ignore */ }
}

function makeMarkerIcon(status, selected = false) {
  const color = getRouteColor(status);
  const size = selected ? 28 : 20;
  const border = selected ? '4px solid #ffffff' : '3px solid #ffffff';
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="background:${color};width:${size}px;height:${size}px;border-radius:50%;border:${border};box-shadow:0 4px 12px rgba(0,0,0,0.35);"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function selectParcel(id) {
  const selectedId = id ?? getSelectedParcelId();
  const selected = state.parcels.find((item) => String(item.id) === String(selectedId));
  if (!selected) return;

  state.selectedParcelId = String(selected.id);
  const selectEl = document.getElementById('selectedColis');
  if (selectEl) selectEl.value = String(selected.id);

  renderMapMarkers();
  updateTrackingInfo(selected);
  showSection('map');
}

function showAddColisModal() {
  const modal = document.getElementById('addColisModal');
  if (modal) modal.classList.add('open');
}

function closeModal() {
  const modal = document.getElementById('addColisModal');
  if (modal) modal.classList.remove('open');
}

async function addColis() {
  const trackingNumber = document.getElementById('newTrackingNumber')?.value.trim();
  const recipientName = document.getElementById('newDestinataire')?.value.trim();
  const deliveryAddress = document.getElementById('newAdresse')?.value.trim();
  const senderName = document.getElementById('newExpediteur')?.value.trim();
  const description = document.getElementById('newDescription')?.value.trim();

  if (!trackingNumber || !recipientName || !deliveryAddress || !senderName) {
    alert('Veuillez remplir les champs requis');
    return;
  }

  try {
    const payload = {
      trackingNumber,
      recipientName,
      recipientPhone: '+33600000000',
      recipientEmail: `${recipientName.toLowerCase().replace(/\s+/g, '.')}@example.com`,
      deliveryAddress,
      senderName,
      company: senderName,
      description: description || 'Livraison standard',
      origin: senderName || 'Point de départ',
      destination: deliveryAddress,
      status: 'pending',
      progress: 0,
      speed: 35,
    };

    await apiFetch('/api/admin/parcels', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    closeModal();
    await loadDashboard();
    alert(`Colis ${trackingNumber} créé avec succès ! Sélectionnez-le dans la Carte Live pour définir son itinéraire.`);
  } catch (error) {
    alert(error.message || 'Impossible de créer le colis.');
  }
}

function debounceSearch(type) {
  clearTimeout(state.searchTimeouts[type]);
  const input = document.getElementById(type === 'start' ? 'startSearch' : 'endSearch');
  if (!input || input.value.trim().length < 2) return;

  state.searchTimeouts[type] = setTimeout(() => {
    fetchSearchResults(type, input.value.trim());
  }, 250);
}

async function geocodeAddress(query) {
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1&accept-language=fr`);
    const data = await response.json();
    if (data && data[0]) {
      return {
        lat: Number(data[0].lat),
        lng: Number(data[0].lon),
        name: data[0].display_name,
      };
    }
  } catch { /* ignore */ }
  return null;
}

async function fetchSearchResults(type, query) {
  const resultsEl = document.getElementById(type === 'start' ? 'startResults' : 'endResults');
  if (!resultsEl) return;

  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=6&addressdetails=1&accept-language=fr`);
    const data = await response.json();

    resultsEl.innerHTML = '';
    resultsEl.classList.add('active');

    data.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'search-result-item';
      row.innerHTML = `<div class="search-result-title">${item.display_name.split(',')[0]}</div><div class="search-result-detail">${item.display_name}</div>`;
      row.addEventListener('click', () => {
        const coords = { lat: Number(item.lat), lng: Number(item.lon), name: item.display_name };

        if (type === 'start') {
          state.startPoint = coords;
          document.getElementById('startSearch').value = item.display_name.split(',')[0];
          const badge = document.getElementById('startLocation');
          if (badge) {
            badge.innerHTML = `<strong>🟢 Départ :</strong> ${item.display_name}`;
            badge.style.display = 'block';
          }
        } else {
          state.endPoint = coords;
          document.getElementById('endSearch').value = item.display_name.split(',')[0];
          const badge = document.getElementById('endLocation');
          if (badge) {
            badge.innerHTML = `<strong>🔴 Arrivée :</strong> ${item.display_name}`;
            badge.style.display = 'block';
          }
        }

        resultsEl.classList.remove('active');
      });

      resultsEl.appendChild(row);
    });
  } catch {
    resultsEl.innerHTML = '<div class="search-result-item">Recherche indisponible.</div>';
  }
}

// Calcul d'arc géodésique / Grand Cercle pour routes intercontinentales ou maritimes
function generateGreatCirclePoints(start, end, numPoints = 50) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  const phi1 = toRad(start.lat);
  const lambda0 = toRad(start.lng);
  const phi2 = toRad(end.lat);
  const lambda1 = toRad(end.lng);

  const dLat = phi2 - phi1;
  const dLng = lambda1 - lambda0;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLng / 2) ** 2;
  const d = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const earthRadiusKm = 6371;
  const distanceKm = Math.round(d * earthRadiusKm * 10) / 10;

  if (d === 0) {
    return { coordinates: [[start.lat, start.lng]], distanceKm: 0 };
  }

  const coordinates = [];
  for (let i = 0; i <= numPoints; i++) {
    const f = i / numPoints;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(phi1) * Math.cos(lambda0) + B * Math.cos(phi2) * Math.cos(lambda1);
    const y = A * Math.cos(phi1) * Math.sin(lambda0) + B * Math.cos(phi2) * Math.sin(lambda1);
    const z = A * Math.sin(phi1) + B * Math.sin(phi2);
    const lat = toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)));
    const lng = toDeg(Math.atan2(y, x));
    coordinates.push([Number(lat.toFixed(5)), Number(lng.toFixed(5))]);
  }

  return { coordinates, distanceKm };
}

function generateRoadLikeRoute(start, end, numPoints = 26) {
  const direct = generateGreatCirclePoints(start, end, numPoints);
  const points = direct.coordinates;
  if (points.length < 2) {
    return points;
  }

  const latDiff = end.lat - start.lat;
  const lngDiff = end.lng - start.lng;
  const lateralScale = Math.min(0.18, Math.max(0.04, Math.hypot(latDiff, lngDiff) * 0.09));
  const lateralDirLat = -lngDiff * lateralScale;
  const lateralDirLng = latDiff * lateralScale;
  const turnBias = Math.sign(latDiff || 1) * 0.4;
  const roadPoints = [];

  for (let i = 0; i < points.length; i++) {
    const f = i / (points.length - 1);
    const baseLat = points[i][0];
    const baseLng = points[i][1];
    const bend = Math.sin(f * Math.PI) * turnBias;
    const curve = Math.sin(f * Math.PI * 2) * 0.35;
    const offsetLat = (lateralDirLat * (0.3 + curve)) + (bend * (Math.abs(latDiff) > 0.1 ? 0.12 : 0.05));
    const offsetLng = (lateralDirLng * (0.3 + curve)) + (bend * (Math.abs(lngDiff) > 0.1 ? 0.12 : 0.05));

    roadPoints.push([
      Number((baseLat + offsetLat).toFixed(5)),
      Number((baseLng + offsetLng).toFixed(5)),
    ]);
  }

  return roadPoints;
}

async function calculateRoute() {
  const selectedParcel = getSelectedParcel();
  if (!selectedParcel) {
    alert('Veuillez d\'abord sélectionner un colis dans la liste au-dessus de la carte.');
    return;
  }

  const startInput = document.getElementById('startSearch')?.value.trim();
  const endInput = document.getElementById('endSearch')?.value.trim();

  // Si non encore géocodé, géocoder directement depuis les champs
  if (!state.startPoint && startInput) {
    state.startPoint = await geocodeAddress(startInput);
  }
  if (!state.endPoint && endInput) {
    state.endPoint = await geocodeAddress(endInput);
  }

  if (!state.startPoint || !state.endPoint) {
    alert('Veuillez saisir et sélectionner le point de départ et le point d\'arrivée.');
    return;
  }

  let coordinates = [];
  let distanceKm = 0;
  let durationMinutes = 0;

  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${state.startPoint.lng},${state.startPoint.lat};${state.endPoint.lng},${state.endPoint.lat}?overview=full&geometries=geojson`;
    const result = await fetch(url);
    const data = await result.json();

    if (data.routes && data.routes[0]) {
      const route = data.routes[0];
      coordinates = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      distanceKm = Math.round((route.distance / 1000) * 10) / 10;
      durationMinutes = Math.round(route.duration / 60);
    }
  } catch { /* OSRM fail, fallback grand cercle */ }

  if (!coordinates.length) {
    const gc = generateRoadLikeRoute(state.startPoint, state.endPoint, 40);
    coordinates = gc;
    distanceKm = Math.round((generateGreatCirclePoints(state.startPoint, state.endPoint, 2).distanceKm || 0) * 10) / 10;
    durationMinutes = Math.round((distanceKm / 80) * 60);
  }

  if (!coordinates.length) {
    alert('Impossible de calculer l\'itinéraire pour ces coordonnées.');
    return;
  }

  // Tracer sur la carte
  if (state.routePolyline && state.map) {
    state.map.removeLayer(state.routePolyline);
  }

  state.routePolyline = L.polyline(coordinates, {
    color: '#0ea5e9',
    weight: 4,
    opacity: 0.9,
    lineCap: 'round',
  }).addTo(state.map);

  state.map.fitBounds(state.routePolyline.getBounds(), { padding: [40, 40] });

  document.getElementById('routeDistance').textContent = `${distanceKm} km`;
  document.getElementById('routeDuration').textContent = `${durationMinutes} min`;
  document.getElementById('routeInfo').style.display = 'block';

  // 3. PERSISTER DANS SUPABASE pour le colis sélectionné !
  const geoJsonRoute = {
    type: 'LineString',
    coordinates: coordinates.map(([lat, lng]) => [lng, lat]),
  };

  const originName = state.startPoint.name || startInput || 'Départ';
  const destinationName = state.endPoint.name || endInput || 'Arrivée';

  try {
    await apiFetch(`/api/admin/parcels/${selectedParcel.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        origin: originName,
        destination: destinationName,
        route: geoJsonRoute,
        distanceTotal: distanceKm,
        currentLatitude: coordinates[0][0],
        currentLongitude: coordinates[0][1],
        progress: 0,
        status: 'in_transit',
      }),
    });

    // Mettre à jour l'objet local
    selectedParcel.origin = originName;
    selectedParcel.destination = destinationName;
    selectedParcel.route = geoJsonRoute;
    selectedParcel.routeGeoJson = geoJsonRoute;
    selectedParcel.distanceTotal = distanceKm;
    selectedParcel.currentLatitude = coordinates[0][0];
    selectedParcel.currentLongitude = coordinates[0][1];
    selectedParcel.progress = 0;
    selectedParcel.status = 'in_transit';

    renderMapMarkers();
    updateTrackingInfo(selectedParcel);

    alert(`✅ Itinéraire enregistré pour le colis ${selectedParcel.trackingNumber} !\nOrigine : ${originName.split(',')[0]}\nDestination : ${destinationName.split(',')[0]}\nDistance : ${distanceKm} km`);
  } catch (saveError) {
    alert('Erreur lors de l\'enregistrement dans Supabase : ' + saveError.message);
  }
}

function clearRoute() {
  if (state.routePolyline && state.map) {
    state.map.removeLayer(state.routePolyline);
    state.routePolyline = null;
  }

  state.startPoint = null;
  state.endPoint = null;

  const startInput = document.getElementById('startSearch');
  const endInput = document.getElementById('endSearch');
  if (startInput) startInput.value = '';
  if (endInput) endInput.value = '';

  const startLocation = document.getElementById('startLocation');
  const endLocation = document.getElementById('endLocation');
  if (startLocation) startLocation.style.display = 'none';
  if (endLocation) endLocation.style.display = 'none';

  const routeInfo = document.getElementById('routeInfo');
  if (routeInfo) routeInfo.style.display = 'none';
}

function updateSimSpeed() {
  const input = document.getElementById('simSpeed');
  const valueEl = document.getElementById('simSpeedValue');
  const val = Math.max(10, Math.min(1000, Number(input?.value || 90)));
  if (valueEl) valueEl.textContent = val;

  const parcel = getSelectedParcel();
  if (parcel) {
    parcel.simulationSpeed = val;
    updateTrackingInfo(parcel);
    apiFetch(`/api/admin/parcels/${parcel.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ simulationSpeed: val }),
    }).catch(() => {});
  }
}

function startSimulation() {
  const selectedParcel = getSelectedParcel();
  if (!selectedParcel) {
    alert('Sélectionnez un colis.');
    return;
  }

  stopSimulation();

  selectedParcel.status = 'in_transit';
  selectedParcel.isRunning = true;
  const idx = state.parcels.findIndex((p) => String(p.id) === String(selectedParcel.id));
  if (idx !== -1) {
    state.parcels[idx] = { ...state.parcels[idx], status: 'in_transit', isRunning: true };
  }
  renderMapMarkers(true);
  updateTrackingInfo(selectedParcel);

  const speedVal = Number(document.getElementById('simSpeed')?.value || selectedParcel.simulationSpeed || 90);

  updateParcelControl('start').finally(() => {
    state.simulationTimer = setInterval(() => {
      advanceSimulationTick().catch(() => {});
    }, 1000); // 1 tick = 1 seconde
  });
}

// Bouton Pause : arrêt immédiat du colis sans bloquer
async function pauseSimulation() {
  const parcel = getSelectedParcel();
  if (!parcel) {
    alert('Sélectionnez un colis.');
    return;
  }

  // 1. Arrêter immédiatement le timer
  stopSimulation();

  // 2. Mettre à jour en mémoire
  parcel.status = 'paused';
  parcel.isRunning = false;
  const idx = state.parcels.findIndex((p) => String(p.id) === String(parcel.id));
  if (idx !== -1) {
    state.parcels[idx] = { ...state.parcels[idx], status: 'paused', isRunning: false };
  }

  // 3. Rafraîchir l'interface sans faire sauter la carte
  renderMapMarkers(true);
  updateTrackingInfo(parcel);

  // 4. Mettre à jour Supabase
  try {
    await apiFetch(`/api/admin/parcels/${parcel.id}/control`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'pause',
        note: 'Colis mis en pause',
        speed: Number(document.getElementById('simSpeed')?.value || parcel.simulationSpeed || 90),
      }),
    });
  } catch (err) {
    console.error('Erreur pause:', err);
  }
}

// Bouton Arrêter : arrêt immédiat du colis
async function stopParcel() {
  const parcel = getSelectedParcel();
  if (!parcel) {
    alert('Sélectionnez un colis.');
    return;
  }

  // 1. Arrêter immédiatement le timer
  stopSimulation();

  // 2. Mettre à jour en mémoire
  parcel.status = 'stopped';
  parcel.isRunning = false;
  const idx = state.parcels.findIndex((p) => String(p.id) === String(parcel.id));
  if (idx !== -1) {
    state.parcels[idx] = { ...state.parcels[idx], status: 'stopped', isRunning: false };
  }

  // 3. Rafraîchir l'interface sans faire sauter la carte
  renderMapMarkers(true);
  updateTrackingInfo(parcel);

  // 4. Mettre à jour Supabase
  try {
    await apiFetch(`/api/admin/parcels/${parcel.id}/control`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'stop',
        note: 'Colis arrêté',
        speed: Number(document.getElementById('simSpeed')?.value || parcel.simulationSpeed || 90),
      }),
    });
  } catch (err) {
    console.error('Erreur arrêt:', err);
  }
}

// Bouton Reset : réinitialise la progression à 0% et replace le marqueur au départ
async function resetParcel() {
  const parcel = getSelectedParcel();
  if (!parcel) {
    alert('Sélectionnez un colis.');
    return;
  }

  stopSimulation();

  parcel.progress = 0;
  parcel.status = 'pending';
  parcel.isRunning = false;

  const startPoint = routePointAtProgress(parcel, 0);
  parcel.currentLatitude = startPoint[0];
  parcel.currentLongitude = startPoint[1];

  const idx = state.parcels.findIndex((p) => String(p.id) === String(parcel.id));
  if (idx !== -1) {
    state.parcels[idx] = { ...parcel };
  }

  applyProgressToMap(parcel, 0, startPoint);
  renderMapMarkers(true);
  updateTrackingInfo(parcel);

  try {
    await apiFetch(`/api/admin/parcels/${parcel.id}/control`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'reset',
        progress: 0,
        note: 'Colis réinitialisé',
      }),
    });
  } catch (err) {
    console.error('Erreur reset:', err);
  }
}

function showReasonModal(title, description, callback) {
  const modal = document.getElementById('reasonModal');
  const titleEl = document.getElementById('reasonTitle');
  const descEl = document.getElementById('reasonDescription');
  const input = document.getElementById('reasonText');
  const confirmBtn = document.getElementById('reasonConfirmBtn');

  if (titleEl) titleEl.textContent = title;
  if (descEl) descEl.textContent = description;
  if (input) input.value = '';
  if (modal) modal.classList.add('open');

  if (confirmBtn) {
    confirmBtn.onclick = () => {
      const reason = input ? input.value.trim() : '';
      if (modal) modal.classList.remove('open');
      callback(reason || 'Action manuelle');
    };
  }
}

function closeReasonModal() {
  const modal = document.getElementById('reasonModal');
  if (modal) modal.classList.remove('open');
}

async function updateParcelControl(action, reason) {
  const selected = document.getElementById('selectedColis')?.value;
  if (!selected) return;

  if (['pause', 'stop', 'reset'].includes(action)) {
    stopSimulation();
  }

  try {
    const result = await apiFetch(`/api/admin/parcels/${selected}/control`, {
      method: 'POST',
      body: JSON.stringify({
        action,
        reason,
        note: reason ? `Action ${action} : ${reason}` : `Action ${action} exécutée`,
        speed: Number(document.getElementById('simSpeed')?.value || 90),
      }),
    });
    if (result?.parcel) {
      state.selectedParcelId = String(result.parcel.id);
      const selectEl = document.getElementById('selectedColis');
      if (selectEl) {
        selectEl.value = String(result.parcel.id);
      }
    }
  } catch (error) {
    console.error('Action control impossible:', error);
  }
}

window.showSection = showSection;
window.onSelectColis = selectParcel;
window.onManualProgressInput = onManualProgressInput;
window.onManualProgressChange = onManualProgressChange;
window.calculateRoute = calculateRoute;
window.clearRoute = clearRoute;
window.updateSimSpeed = updateSimSpeed;
window.startSimulation = startSimulation;
window.pauseSimulation = pauseSimulation;
window.stopParcel = stopParcel;
window.resetParcel = resetParcel;
window.pauseWithReason = pauseSimulation;
window.stopWithReason = stopParcel;
window.resetWithReason = resetParcel;
window.closeReasonModal = closeReasonModal;
window.showAddColisModal = showAddColisModal;
window.closeModal = closeModal;
window.addColis = addColis;
window.debounceSearch = debounceSearch;
window.addEventListener('load', initAdminPage);
window.logout = () => {
  localStorage.removeItem('trackpro_token');
  localStorage.removeItem('trackpro_session');
  window.location.href = 'login.html';
};
window.addEventListener('beforeunload', () => {
  if (state.map) state.map.remove();
});
