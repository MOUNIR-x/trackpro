(function () {
  const root = typeof window !== 'undefined' ? window : globalThis;

  function normalizeSupabaseUrl(value) {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/\/+$/, '');
  }

  function resolveSupabaseConfig(overrides = {}) {
    const source = {
      ...(typeof process !== 'undefined' && process.env ? process.env : {}),
      ...(typeof window !== 'undefined' ? window : {}),
      ...(overrides || {}),
    };

    const url = normalizeSupabaseUrl(
      source.SUPABASE_URL || source.NEXT_PUBLIC_SUPABASE_URL || '',
    );
    const key = (source.SUPABASE_ANON_KEY || source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '').trim();

    return { url, key };
  }

  const config = resolveSupabaseConfig();

  root.API_BASE = root.API_BASE || (typeof window !== 'undefined' && window.location && (window.location.protocol === 'file:' || (['localhost', '127.0.0.1'].includes(window.location.hostname) && window.location.port !== '3000' && window.location.port !== '')) ? 'http://localhost:3000' : '');
  root.SUPABASE_URL = config.url;
  root.SUPABASE_ANON_KEY = config.key;

  if (typeof window !== 'undefined') {
    if (window.supabase && typeof window.supabase.createClient === 'function' && config.url && config.key) {
      window.trackproSupabase = window.supabase.createClient(config.url, config.key, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      });
    } else {
      window.trackproSupabase = null;
    }
  } else {
    root.trackproSupabase = null;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { resolveSupabaseConfig };
  }
})();

if (typeof window !== 'undefined') {
  function safeSetText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function safeSetDisplay(id, display) {
    const el = document.getElementById(id);
    if (el) el.style.display = display;
  }

  function getStoredParcels() {
    try {
      return JSON.parse(localStorage.getItem('trackpro_colis') || '[]');
    } catch {
      return [];
    }
  }

  function saveStoredParcels(parcels) {
    localStorage.setItem('trackpro_colis', JSON.stringify(parcels));
  }

  function seedDemoParcels() {
    const existing = getStoredParcels();
    if (existing.length) return existing;

    const parcels = [
      {
        id: 1,
        trackingNumber: 'COL-2026-001',
        destinataire: 'Jean Dupont',
        telephone: '+33600000000',
        email: 'jean@example.com',
        adresse: '12 rue de la Paix, Paris',
        expediteur: 'Acme Logistics',
        entreprise: 'Acme Logistics',
        description: 'Électronique',
        status: 'transit',
        lat: 48.8566,
        lng: 2.3522,
        speed: 70,
        currentAddress: 'Paris',
        comments: [
          { time: new Date().toISOString(), text: 'Colis pris en charge', type: 'info' },
          { time: new Date().toISOString(), text: 'En transit vers Lyon', type: 'info' }
        ],
        route: {
          type: 'LineString',
          coordinates: [
            [2.3522, 48.8566],
            [4.8357, 45.7640]
          ],
          startPoint: { lat: 48.8566, lng: 2.3522, name: 'Paris' },
          endPoint: { lat: 45.7640, lng: 4.8357, name: 'Lyon' },
          currentStep: 1,
          distance: 500000,
          duration: 3600,
        },
        createdAt: new Date().toISOString(),
        milestones: { 25: true }
      },
      {
        id: 2,
        trackingNumber: 'COL-2026-002',
        destinataire: 'Marie Curie',
        telephone: '+33700000000',
        email: 'marie@example.com',
        adresse: '18 avenue de la République, Marseille',
        expediteur: 'Transports Sud',
        entreprise: 'Transports Sud',
        description: 'Textile',
        status: 'delivered',
        lat: 43.2965,
        lng: 5.3698,
        speed: 0,
        currentAddress: 'Marseille',
        comments: [
          { time: new Date().toISOString(), text: 'Colis livré', type: 'success' }
        ],
        route: {
          type: 'LineString',
          coordinates: [
            [5.3698, 43.2965],
            [5.3698, 43.2965]
          ],
          startPoint: { lat: 43.2965, lng: 5.3698, name: 'Marseille' },
          endPoint: { lat: 43.2965, lng: 5.3698, name: 'Marseille' },
          currentStep: 1,
          distance: 0,
          duration: 0,
        },
        createdAt: new Date().toISOString(),
        milestones: { 100: true }
      },
      {
        id: 3,
        trackingNumber: 'COL-2026-003',
        destinataire: 'Paul Martin',
        telephone: '+33800000000',
        email: 'paul@example.com',
        adresse: '7 boulevard du Nord, Lille',
        expediteur: 'Euro Ship',
        entreprise: 'Euro Ship',
        description: 'Documents',
        status: 'paused',
        lat: 50.6292,
        lng: 3.0573,
        speed: 15,
        currentAddress: 'Lille',
        comments: [
          { time: new Date().toISOString(), text: 'Pause technique', type: 'warning' }
        ],
        route: {
          type: 'LineString',
          coordinates: [
            [3.0573, 50.6292],
            [2.3499, 48.8566]
          ],
          startPoint: { lat: 50.6292, lng: 3.0573, name: 'Lille' },
          endPoint: { lat: 48.8566, lng: 2.3499, name: 'Paris' },
          currentStep: 1,
          distance: 400000,
          duration: 1800,
        },
        createdAt: new Date().toISOString(),
        milestones: { 50: true }
      }
    ];

    localStorage.setItem('trackpro_colis', JSON.stringify(parcels));
    return parcels;
  }

  function logout() {
    localStorage.removeItem('trackpro_token');
    localStorage.removeItem('trackpro_session');
    window.location.href = 'login.html';
  }

  async function reverseGeocode(lat, lng) {
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`);
      const data = await response.json();
      return data.display_name || 'Position actuelle';
    } catch {
      return 'Position actuelle';
    }
  }

  function getSessionUser() {
    try {
      return JSON.parse(localStorage.getItem('trackpro_session') || 'null');
    } catch {
      return null;
    }
  }

  function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '0 min';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return hrs > 0 ? `${hrs}h ${mins}min` : `${mins} min`;
  }

  window.appHelpers = {
    API_BASE: window.API_BASE,
    getStoredParcels,
    saveStoredParcels,
    seedDemoParcels,
    logout,
    reverseGeocode,
    getSessionUser,
    formatDuration,
  };
}
