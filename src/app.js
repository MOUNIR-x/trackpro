const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('node:path');

const { createDatabase, initializeDatabase, isPostgresDatabase, createUser, findUserByEmail, findUserById, createParcel, listParcels, getParcelByTrackingNumber, getParcelById, updateParcel, archiveParcel, appendParcelEvent, listParcelEvents, getParcelStats, shouldRetryWithLocalSqlite } = require('./db');
const { hashPassword, comparePassword, signToken, requireAuth, requireRole } = require('./auth');

const VALID_STATUSES = new Set(['pending', 'in_transit', 'paused', 'stopped', 'delivered']);

function parseRoute(rawRoute) {
  if (!rawRoute) {
    return null;
  }

  if (typeof rawRoute === 'string') {
    try {
      return JSON.parse(rawRoute);
    } catch {
      return null;
    }
  }

  return rawRoute;
}

function sanitizeText(value, fallback = '') {
  if (typeof value !== 'string') {
    return fallback;
  }

  return value.trim();
}

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isStrongPassword(password) {
  return typeof password === 'string' && password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

function normalizeStatus(value, fallback = 'pending') {
  const status = sanitizeText(value, fallback).toLowerCase();
  return VALID_STATUSES.has(status) ? status : fallback;
}

function validateRouteObject(route) {
  const parsed = parseRoute(route);
  if (!parsed || parsed.type !== 'LineString' || !Array.isArray(parsed.coordinates) || parsed.coordinates.length < 2) {
    return { valid: false, message: 'Le parcours doit être un GeoJSON LineString avec au moins deux points.' };
  }

  const validCoordinates = parsed.coordinates.every((point) => Array.isArray(point) && point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])));
  if (!validCoordinates) {
    return { valid: false, message: 'Les coordonnées de route doivent être des paires [longitude, latitude] valides.' };
  }

  return { valid: true, route: parsed };
}

function validateParcelPayload(payload) {
  const trackingNumber = sanitizeText(payload.trackingNumber);
  const recipientName = sanitizeText(payload.recipientName);
  const deliveryAddress = sanitizeText(payload.deliveryAddress);
  const destination = sanitizeText(payload.destination);

  if (!trackingNumber || trackingNumber.length < 6) {
    return { valid: false, message: 'Le numéro de suivi est requis et doit contenir au moins 6 caractères.' };
  }

  if (!recipientName || recipientName.length < 2) {
    return { valid: false, message: 'Le nom du destinataire est requis.' };
  }

  if (!deliveryAddress || deliveryAddress.length < 5) {
    return { valid: false, message: 'L\'adresse de livraison est obligatoire.' };
  }

  if (!destination || destination.length < 2) {
    return { valid: false, message: 'La destination est obligatoire.' };
  }

  if (payload.route !== undefined) {
    const routeCheck = validateRouteObject(payload.route);
    if (!routeCheck.valid) {
      return routeCheck;
    }
  }

  const progress = Number(payload.progress ?? 0);
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
    return { valid: false, message: 'La progression doit être un nombre entre 0 et 100.' };
  }

  const simulationSpeed = Number(payload.speed ?? payload.simulationSpeed ?? 60);
  if (!Number.isFinite(simulationSpeed) || simulationSpeed <= 0 || simulationSpeed > 1000) {
    return { valid: false, message: 'La vitesse de simulation doit être un nombre positif.' };
  }

  return {
    valid: true,
    normalized: {
      ...payload,
      trackingNumber,
      recipientName,
      deliveryAddress,
      destination,
      status: normalizeStatus(payload.status, 'pending'),
      progress,
      speed: simulationSpeed,
    },
  };
}

function extractCoordinates(route) {
  const parsed = parseRoute(route);
  if (!parsed || parsed.type !== 'LineString' || !Array.isArray(parsed.coordinates) || !parsed.coordinates.length) {
    return [];
  }

  return parsed.coordinates;
}

function buildPublicParcel(parcel, events = []) {
  const route = parseRoute(parcel.routeGeoJson);
  const coordinates = extractCoordinates(parcel.routeGeoJson);
  const start = coordinates[0] || [parcel.currentLongitude ?? 0, parcel.currentLatitude ?? 0];
  const end = coordinates[coordinates.length - 1] || start;

  const safeProgress = Number(parcel.progress) || 0;
  const distanceTotal = Number(parcel.distanceTotal) || 0;
  const remainingDistance = Math.max(0, distanceTotal * (1 - safeProgress / 100));
  const etaMinutes = safeProgress > 0 && safeProgress < 100 ? Math.max(1, (remainingDistance / Math.max(1, Number(parcel.simulationSpeed || 60))) * 60) : 0;
  const etaDate = safeProgress >= 100 ? new Date(Date.now()) : new Date(Date.now() + etaMinutes * 60 * 1000);

  const lastEvent = events.length ? events[events.length - 1] : null;
  const statusReason = lastEvent && (lastEvent.reason || lastEvent.note) ? (lastEvent.reason || lastEvent.note) : null;

  return {
    id: parcel.id,
    trackingNumber: parcel.trackingNumber,
    recipientName: parcel.recipientName,
    recipientPhone: parcel.recipientPhone,
    recipientEmail: parcel.recipientEmail,
    deliveryAddress: parcel.deliveryAddress,
    senderName: parcel.senderName,
    company: parcel.company,
    description: parcel.description,
    origin: parcel.origin,
    destination: parcel.destination,
    status: parcel.status,
    statusReason,
    currentCoordinates: {
      latitude: parcel.currentLatitude,
      longitude: parcel.currentLongitude,
    },
    progress: Math.max(0, Math.min(100, safeProgress)),
    route,
    distanceTotal,
    distanceRemaining: remainingDistance,
    etaMinutes,
    eta: etaDate.toISOString(),
    isRunning: Boolean(parcel.isRunning),
    simulationSpeed: Number(parcel.simulationSpeed) || 60,
    start,
    end,
    lastEvent,
    timeline: events.map((event) => ({
      id: event.id,
      type: event.type,
      status: event.status,
      note: event.note,
      reason: event.reason,
      latitude: event.latitude,
      longitude: event.longitude,
      createdAt: event.createdAt,
    })),
  };
}

function createApp({ useMemoryDb = false } = {}) {
  const app = express();
  let db = createDatabase(useMemoryDb);

  app.locals.db = db;
  app.locals.dbReady = (async () => {
    try {
      await initializeDatabase(db);
    } catch (error) {
      if (isPostgresDatabase(db) || shouldRetryWithLocalSqlite(error)) {
        const fallbackReason = error?.message || String(error || 'Unknown database startup error');
        console.warn('Database startup failed; falling back to local SQLite database.', fallbackReason);
        db = createDatabase(useMemoryDb, true);
        app.locals.db = db;
        await initializeDatabase(db);
        return;
      }

      throw error;
    }
  })();

  const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map((origin) => origin.trim()).filter(Boolean);
  const defaultAllowedOrigins = [
    'http://localhost:3000',
    'http://localhost:8080',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:8080',
    'https://*.vercel.app',
  ];
  const effectiveAllowedOrigins = [...new Set([...allowedOrigins, ...defaultAllowedOrigins])];

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      const isAllowed = effectiveAllowedOrigins.some((pattern) => {
        if (pattern === '*') return true;
        if (pattern.includes('*')) {
          const regex = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`);
          return regex.test(origin);
        }
        return pattern === origin;
      });

      if (isAllowed) {
        callback(null, true);
        return;
      }

      callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan('dev'));

  app.use(async (req, res, next) => {
    try {
      if (app.locals.dbReady) {
        await app.locals.dbReady;
      }
      return next();
    } catch (error) {
      return next(error);
    }
  });

  app.use((req, res, next) => {
    if (req.path.startsWith('/api/admin/')) {
      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Token d\'authentification requis.' });
      }
    }

    return next();
  });

  const staticRoot = path.join(__dirname, '..');
  app.use(express.static(staticRoot));

  app.get('/', (req, res) => {
    res.sendFile(path.join(staticRoot, 'index.html'));
  });

  app.get('/admin', (req, res) => {
    res.sendFile(path.join(staticRoot, 'admin.html'));
  });

  app.get('/client', (req, res) => {
    res.sendFile(path.join(staticRoot, 'client.html'));
  });

  app.get('/login', (req, res) => {
    res.sendFile(path.join(staticRoot, 'login.html'));
  });

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'tracking-app' });
  });

  app.post('/api/auth/register', async (req, res) => {
    const { name, email, password, role, company } = req.body || {};
    const safeName = sanitizeText(name);
    const safeEmail = sanitizeText(email).toLowerCase();
    const safePassword = typeof password === 'string' ? password : '';

    if (!safeName || !isValidEmail(safeEmail) || !isStrongPassword(safePassword)) {
      return res.status(400).json({ message: 'Nom, email et mot de passe valides sont requis.' });
    }

    const existingUser = await findUserByEmail(db, safeEmail);
    if (existingUser) {
      return res.status(409).json({ message: 'Un utilisateur avec cet email existe déjà.' });
    }

    const nextRole = role === 'user' ? 'user' : 'admin';
    const user = await createUser(db, {
      name: safeName,
      email: safeEmail,
      passwordHash: hashPassword(safePassword),
      role: nextRole,
      company: sanitizeText(company) || 'TrackPro',
    });

    const token = signToken(user);
    return res.status(201).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        company: user.company || 'TrackPro',
      },
    });
  });

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    const safeEmail = sanitizeText(email).toLowerCase();
    const safePassword = typeof password === 'string' ? password : '';

    if (!isValidEmail(safeEmail) || !safePassword) {
      return res.status(400).json({ message: 'Email et mot de passe sont requis.' });
    }

    const user = await findUserByEmail(db, safeEmail);
    if (!user || !comparePassword(safePassword, user.passwordHash)) {
      return res.status(401).json({ message: 'Identifiants invalides.' });
    }

    const token = signToken(user);

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        company: user.company || 'TrackPro',
      },
    });
  });

  app.get('/api/admin/stats', requireAuth, requireRole('admin'), async (req, res) => {
    const stats = await getParcelStats(db);
    res.json({ stats });
  });

  app.get('/api/admin/parcels', requireAuth, requireRole('admin'), async (req, res) => {
    const parcels = await listParcels(db, { archived: false });
    return res.json({ parcels });
  });

  app.post('/api/admin/parcels', requireAuth, requireRole('admin'), async (req, res) => {
    const payload = validateParcelPayload(req.body || {});
    if (!payload.valid) {
      return res.status(400).json({ message: payload.message });
    }

    const {
      trackingNumber,
      recipientName,
      recipientPhone,
      recipientEmail,
      deliveryAddress,
      senderName,
      company,
      description,
      origin,
      destination,
      route,
      status,
      speed,
      progress,
    } = payload.normalized;

    const coordinates = extractCoordinates(route);
    let currentLatitude = null;
    let currentLongitude = null;
    let distanceTotal = 0;

    if (coordinates.length >= 2) {
      const [lngStart, latStart] = coordinates[0];
      const [lngEnd, latEnd] = coordinates[coordinates.length - 1];
      currentLatitude = latStart;
      currentLongitude = lngStart;

      for (let index = 0; index < coordinates.length - 1; index += 1) {
        const [lng1, lat1] = coordinates[index];
        const [lng2, lat2] = coordinates[index + 1];
        const earthRadiusKm = 6371;
        const dLat = ((lat2 - lat1) * Math.PI) / 180;
        const dLng = ((lng2 - lng1) * Math.PI) / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        distanceTotal += earthRadiusKm * c;
      }

      if (status === 'delivered' || progress >= 100) {
        currentLatitude = latEnd;
        currentLongitude = lngEnd;
      }
    }

    const createdParcel = await createParcel(db, {
      trackingNumber,
      recipientName,
      recipientPhone: sanitizeText(recipientPhone),
      recipientEmail: sanitizeText(recipientEmail) || null,
      deliveryAddress,
      senderName: sanitizeText(senderName) || null,
      company: sanitizeText(company) || 'TrackPro',
      description: sanitizeText(description) || null,
      origin: sanitizeText(origin) || null,
      destination,
      status,
      currentLatitude,
      currentLongitude,
      progress,
      simulationSpeed: Number(speed) || 60,
      route,
      distanceTotal,
    }, req.user.sub);

    return res.status(201).json({ parcel: createdParcel });
  });

  app.get('/api/admin/parcels/:id', requireAuth, requireRole('admin'), async (req, res) => {
    const parcel = await getParcelById(db, req.params.id);
    if (!parcel) {
      return res.status(404).json({ message: 'Colis introuvable.' });
    }

    const events = await listParcelEvents(db, parcel.id);
    return res.json({ parcel, events });
  });

  app.patch('/api/admin/parcels/:id', requireAuth, requireRole('admin'), async (req, res) => {
    const parcel = await getParcelById(db, req.params.id);
    if (!parcel) {
      return res.status(404).json({ message: 'Colis introuvable.' });
    }

    const updates = { ...req.body };

    if (updates.route !== undefined) {
      const routeValidation = validateRouteObject(updates.route);
      if (!routeValidation.valid) {
        return res.status(400).json({ message: routeValidation.message });
      }
      updates.routeGeoJson = JSON.stringify(routeValidation.route);
      delete updates.route;
    }

    if (updates.status) {
      updates.status = normalizeStatus(updates.status, parcel.status);
    }

    if (updates.progress !== undefined) {
      const progress = Number(updates.progress);
      if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
        return res.status(400).json({ message: 'La progression doit être un nombre entre 0 et 100.' });
      }
      updates.progress = progress;
    }

    if (updates.simulationSpeed !== undefined) {
      const speed = Number(updates.simulationSpeed);
      if (!Number.isFinite(speed) || speed <= 0 || speed > 1000) {
        return res.status(400).json({ message: 'La vitesse de simulation doit être un nombre positif.' });
      }
      updates.simulationSpeed = speed;
    }

    const nextParcel = await updateParcel(db, parcel.id, updates);
    return res.json({ parcel: nextParcel });
  });

  app.delete('/api/admin/parcels/:id', requireAuth, requireRole('admin'), async (req, res) => {
    const parcel = await getParcelById(db, req.params.id);
    if (!parcel) {
      return res.status(404).json({ message: 'Colis introuvable.' });
    }

    const archivedParcel = await archiveParcel(db, parcel.id);
    return res.json({ parcel: archivedParcel, archived: true });
  });

  app.post('/api/admin/parcels/:id/control', requireAuth, requireRole('admin'), async (req, res) => {
    const parcel = await getParcelById(db, req.params.id);
    if (!parcel) {
      return res.status(404).json({ message: 'Colis introuvable.' });
    }

    const { action, reason, note, latitude, longitude, status, speed } = req.body || {};
    const normalizedAction = (action || '').toLowerCase();
    const allowedActions = new Set(['start', 'pause', 'stop', 'reset', 'inject']);

    if (!normalizedAction || !allowedActions.has(normalizedAction)) {
      return res.status(400).json({ message: 'Action invalide. Actions autorisées : start, pause, stop, reset, inject.' });
    }

    if (['pause', 'stop', 'reset'].includes(normalizedAction) && !reason) {
      return res.status(400).json({ message: 'Un motif est obligatoire pour cette action.' });
    }

    let nextStatus = parcel.status;
    let nextProgress = Number(parcel.progress) || 0;
    let nextLatitude = parcel.currentLatitude;
    let nextLongitude = parcel.currentLongitude;
    let runningState = Boolean(parcel.isRunning);
    const routeCoordinates = extractCoordinates(parcel.routeGeoJson);

    if (normalizedAction === 'start') {
      nextStatus = 'in_transit';
      runningState = true;
      if (routeCoordinates.length >= 2 && nextProgress === 0) {
        const [lng, lat] = routeCoordinates[0];
        nextLatitude = lat;
        nextLongitude = lng;
      }
    }

    if (normalizedAction === 'pause') {
      nextStatus = 'paused';
      runningState = false;
    }

    if (normalizedAction === 'stop') {
      nextStatus = 'stopped';
      runningState = false;
    }

    if (normalizedAction === 'reset') {
      nextStatus = 'pending';
      runningState = false;
      nextProgress = 0;
      if (routeCoordinates.length >= 2) {
        const [lng, lat] = routeCoordinates[0];
        nextLatitude = lat;
        nextLongitude = lng;
      }
    }

    if (normalizedAction === 'inject') {
      if (latitude !== undefined && longitude !== undefined) {
        nextLatitude = Number(latitude);
        nextLongitude = Number(longitude);
      }
      if (status) {
        nextStatus = normalizeStatus(status, nextStatus);
      }
      if (typeof nextProgress === 'number' && Number.isFinite(nextProgress)) {
        nextProgress = Math.max(0, Math.min(100, Number(nextProgress)));
      }
      runningState = false;
    }

    if (speed !== undefined) {
      const parsedSpeed = Number(speed);
      if (!Number.isFinite(parsedSpeed) || parsedSpeed <= 0 || parsedSpeed > 1000) {
        return res.status(400).json({ message: 'La vitesse de simulation doit être un nombre positif.' });
      }
      await updateParcel(db, parcel.id, { simulationSpeed: Number(speed) || 60 });
    }

    const updatedParcel = await updateParcel(db, parcel.id, {
      status: nextStatus,
      currentLatitude: nextLatitude,
      currentLongitude: nextLongitude,
      progress: nextProgress,
      isRunning: runningState ? 1 : 0,
      simulationSpeed: Number(speed) || Number(parcel.simulationSpeed) || 60,
    });

    await appendParcelEvent(db, parcel.id, {
      type: normalizedAction,
      status: nextStatus,
      latitude: nextLatitude,
      longitude: nextLongitude,
      reason: reason || null,
      note: note || `${normalizedAction} exécuté par l'administration`,
      createdBy: req.user.sub,
    });

    return res.json({ parcel: updatedParcel, control: normalizedAction, reason: reason || null });
  });

  app.get('/api/public/track', async (req, res) => {
    const trackingNumber = (req.query.trackingNumber || '').toString().trim();
    if (!trackingNumber) {
      return res.status(400).json({ message: 'Numéro de suivi requis.' });
    }

    const parcel = await getParcelByTrackingNumber(db, trackingNumber);
    if (!parcel) {
      return res.status(404).json({ message: 'Colis introuvable.' });
    }

    const events = await listParcelEvents(db, parcel.id);
    return res.json({ parcel: buildPublicParcel(parcel, events) });
  });

  app.get('/api/public/track/:trackingNumber', async (req, res) => {
    const parcel = await getParcelByTrackingNumber(db, req.params.trackingNumber);
    if (!parcel) {
      return res.status(404).json({ message: 'Colis introuvable.' });
    }

    const events = await listParcelEvents(db, parcel.id);
    return res.json({ parcel: buildPublicParcel(parcel, events) });
  });

  return app;
}

let defaultApp = null;
function getDefaultApp() {
  if (!defaultApp) {
    defaultApp = createApp();
  }
  return defaultApp;
}

function handler(req, res) {
  return getDefaultApp()(req, res);
}

handler.createApp = createApp;
handler.default = handler;

module.exports = handler;
module.exports.createApp = createApp;
