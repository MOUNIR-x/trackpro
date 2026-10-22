const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');

function isPostgresDatabase(db) {
  return Boolean(db && typeof db.query === 'function' && typeof db.connect === 'function');
}

function getDatabasePath(useMemoryDb) {
  if (useMemoryDb) {
    return ':memory:';
  }

  const databaseDir = path.resolve(__dirname, '../data');
  fs.mkdirSync(databaseDir, { recursive: true });
  return path.join(databaseDir, 'tracking.db');
}

function shouldUsePostgresDatabase(databaseUrl) {
  if (!databaseUrl || typeof databaseUrl !== 'string') {
    return false;
  }

  const trimmed = databaseUrl.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const parsedUrl = new URL(trimmed);
    return ['postgres:', 'postgresql:'].includes(parsedUrl.protocol) && Boolean(parsedUrl.hostname);
  } catch {
    return false;
  }
}

function shouldRetryWithLocalSqlite(error) {
  if (!error) {
    return false;
  }

  const message = String(error.message || error).toLowerCase();
  return /enotfound|econnrefused|econnreset|timeout|connection refused|password authentication failed|could not connect/.test(message);
}

function createDatabase(useMemoryDb = false, forceSqlite = false) {
  const databaseUrl = process.env.DATABASE_URL;
  const canUsePostgres = !forceSqlite && !useMemoryDb && shouldUsePostgresDatabase(databaseUrl);

  if (canUsePostgres) {
    const useSsl = process.env.NODE_ENV === 'production' || databaseUrl.includes('supabase.co');

    return new Pool({
      connectionString: databaseUrl,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }

  const databasePath = getDatabasePath(useMemoryDb);
  return new sqlite3.Database(databasePath);
}

function run(db, sql, params = []) {
  if (isPostgresDatabase(db)) {
    const normalizedSql = sql.trim();
    const querySql = /^\s*INSERT\b/i.test(normalizedSql)
      ? `${normalizedSql}${normalizedSql.endsWith(';') ? '' : ';'} RETURNING id;`
      : normalizedSql;

    return db.query(querySql, params).then((result) => ({
      id: result.rows?.[0]?.id ?? null,
      changes: result.rowCount ?? 0,
    }));
  }

  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  if (isPostgresDatabase(db)) {
    return db.query(sql, params).then((result) => result.rows?.[0] || null);
  }

  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function all(db, sql, params = []) {
  if (isPostgresDatabase(db)) {
    return db.query(sql, params).then((result) => result.rows || []);
  }

  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });
}

async function initializeDatabase(db) {
  if (isPostgresDatabase(db)) {
    await run(
      db,
      `CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        passwordHash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        company TEXT NOT NULL DEFAULT 'TrackPro',
        createdAt TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    );

    await run(db, `ALTER TABLE users ADD COLUMN IF NOT EXISTS company TEXT NOT NULL DEFAULT 'TrackPro'`);

    await run(
      db,
      `CREATE TABLE IF NOT EXISTS parcels (
        id BIGSERIAL PRIMARY KEY,
        trackingNumber TEXT NOT NULL UNIQUE,
        recipientName TEXT NOT NULL,
        recipientPhone TEXT,
        recipientEmail TEXT,
        deliveryAddress TEXT,
        senderName TEXT,
        company TEXT,
        description TEXT,
        origin TEXT,
        destination TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        currentLatitude REAL,
        currentLongitude REAL,
        progress REAL NOT NULL DEFAULT 0,
        simulationSpeed REAL NOT NULL DEFAULT 60,
        isRunning INTEGER NOT NULL DEFAULT 0,
        routeGeoJson TEXT,
        distanceTotal REAL NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        createdBy INTEGER,
        createdAt TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (createdBy) REFERENCES users(id)
      )`,
    );

    await run(
      db,
      `CREATE TABLE IF NOT EXISTS parcel_events (
        id BIGSERIAL PRIMARY KEY,
        parcelId INTEGER NOT NULL,
        type TEXT NOT NULL,
        status TEXT,
        latitude REAL,
        longitude REAL,
        reason TEXT,
        note TEXT,
        createdBy INTEGER,
        createdAt TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (parcelId) REFERENCES parcels(id),
        FOREIGN KEY (createdBy) REFERENCES users(id)
      )`,
    );

    return;
  }

  await run(
    db,
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      company TEXT NOT NULL DEFAULT 'TrackPro',
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );

  const columns = await all(db, `PRAGMA table_info(users)`);
  const hasCompanyColumn = columns.some((column) => column.name === 'company');
  if (!hasCompanyColumn) {
    await run(db, `ALTER TABLE users ADD COLUMN company TEXT NOT NULL DEFAULT 'TrackPro'`);
  }

  await run(
    db,
    `CREATE TABLE IF NOT EXISTS parcels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trackingNumber TEXT NOT NULL UNIQUE,
      recipientName TEXT NOT NULL,
      recipientPhone TEXT,
      recipientEmail TEXT,
      deliveryAddress TEXT,
      senderName TEXT,
      company TEXT,
      description TEXT,
      origin TEXT,
      destination TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      currentLatitude REAL,
      currentLongitude REAL,
      progress REAL NOT NULL DEFAULT 0,
      simulationSpeed REAL NOT NULL DEFAULT 60,
      isRunning INTEGER NOT NULL DEFAULT 0,
      routeGeoJson TEXT,
      distanceTotal REAL NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      createdBy INTEGER,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(createdBy) REFERENCES users(id)
    )`,
  );

  await run(
    db,
    `CREATE TABLE IF NOT EXISTS parcel_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parcelId INTEGER NOT NULL,
      type TEXT NOT NULL,
      status TEXT,
      latitude REAL,
      longitude REAL,
      reason TEXT,
      note TEXT,
      createdBy INTEGER,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(parcelId) REFERENCES parcels(id),
      FOREIGN KEY(createdBy) REFERENCES users(id)
    )`,
  );
}

async function createUser(db, { name, email, passwordHash, role = 'admin', company = 'TrackPro' }) {
  const result = await run(db, `INSERT INTO users (name, email, passwordHash, role, company) VALUES (?, ?, ?, ?, ?)`, [
    name,
    email,
    passwordHash,
    role,
    company || 'TrackPro',
  ]);

  return get(db, `SELECT * FROM users WHERE id = ?`, [result.id]);
}

async function findUserByEmail(db, email) {
  return get(db, `SELECT * FROM users WHERE email = ?`, [email]);
}

async function findUserById(db, id) {
  return get(db, `SELECT * FROM users WHERE id = ?`, [id]);
}

async function createParcel(db, parcel, createdBy = null) {
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
    status = 'pending',
    currentLatitude,
    currentLongitude,
    progress = 0,
    simulationSpeed = 60,
    isRunning = 0,
    route,
    distanceTotal = 0,
  } = parcel;

  const routeGeoJson = route ? JSON.stringify(route) : null;
  const result = await run(
    db,
    `INSERT INTO parcels (
      trackingNumber, recipientName, recipientPhone, recipientEmail, deliveryAddress,
      senderName, company, description, origin, destination, status,
      currentLatitude, currentLongitude, progress, simulationSpeed, isRunning, routeGeoJson,
      distanceTotal, createdBy
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
    [
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
      status,
      currentLatitude ?? null,
      currentLongitude ?? null,
      progress,
      simulationSpeed,
      isRunning ? 1 : 0,
      routeGeoJson,
      distanceTotal,
      createdBy,
    ],
  );

  const created = await get(db, `SELECT * FROM parcels WHERE id = ?`, [result.id]);

  if (created) {
    await appendParcelEvent(db, created.id, {
      type: 'created',
      status,
      latitude: currentLatitude ?? null,
      longitude: currentLongitude ?? null,
      note: `Colis créé avec référence ${trackingNumber}`,
      createdBy,
    });
  }

  return created;
}

async function listParcels(db, { archived = false } = {}) {
  const rows = await all(db, `SELECT * FROM parcels WHERE archived = ? ORDER BY createdAt DESC`, [archived ? 1 : 0]);
  return rows;
}

async function getParcelById(db, id) {
  return get(db, `SELECT * FROM parcels WHERE id = ?`, [id]);
}

async function getParcelByTrackingNumber(db, trackingNumber) {
  return get(db, `SELECT * FROM parcels WHERE trackingNumber = ?`, [trackingNumber]);
}

async function updateParcel(db, id, payload) {
  const allowed = [
    'recipientName',
    'recipientPhone',
    'recipientEmail',
    'deliveryAddress',
    'senderName',
    'company',
    'description',
    'origin',
    'destination',
    'status',
    'currentLatitude',
    'currentLongitude',
    'progress',
    'simulationSpeed',
    'isRunning',
    'routeGeoJson',
    'distanceTotal',
    'archived',
    'updatedAt',
  ];

  const entries = Object.entries(payload).filter(([key]) => allowed.includes(key));
  if (!entries.length) {
    return getParcelById(db, id);
  }

  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  const values = entries.map(([, value]) => value);
  values.push(new Date().toISOString());
  values.push(id);

  await run(db, `UPDATE parcels SET ${assignments}, updatedAt = ? WHERE id = ?`, values);
  return getParcelById(db, id);
}

async function archiveParcel(db, id) {
  await run(db, `UPDATE parcels SET archived = 1, updatedAt = ? WHERE id = ?`, [new Date().toISOString(), id]);
  return getParcelById(db, id);
}

async function appendParcelEvent(db, parcelId, event) {
  const { type, status = null, latitude = null, longitude = null, reason = null, note = null, createdBy = null } = event;
  await run(
    db,
    `INSERT INTO parcel_events (parcelId, type, status, latitude, longitude, reason, note, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [parcelId, type, status, latitude, longitude, reason, note, createdBy],
  );

  return all(db, `SELECT * FROM parcel_events WHERE parcelId = ? ORDER BY createdAt ASC`, [parcelId]);
}

async function listParcelEvents(db, parcelId) {
  return all(db, `SELECT * FROM parcel_events WHERE parcelId = ? ORDER BY createdAt ASC`, [parcelId]);
}

async function getParcelStats(db) {
  const rows = await all(db, `SELECT status, COUNT(*) AS count FROM parcels WHERE archived = 0 GROUP BY status`);
  const summary = {
    total: 0,
    pending: 0,
    in_transit: 0,
    paused: 0,
    stopped: 0,
    delivered: 0,
    archived: 0,
  };

  const archivedRows = await all(db, `SELECT COUNT(*) AS count FROM parcels WHERE archived = 1`);
  summary.archived = archivedRows[0]?.count || 0;

  for (const row of rows) {
    summary.total += Number(row.count || 0);
    const statusKey = row.status || 'pending';
    summary[statusKey] = Number(row.count || 0);
  }

  return summary;
}

module.exports = {
  isPostgresDatabase,
  shouldRetryWithLocalSqlite,
  createDatabase,
  initializeDatabase,
  run,
  get,
  all,
  createUser,
  findUserByEmail,
  findUserById,
  createParcel,
  listParcels,
  getParcelById,
  getParcelByTrackingNumber,
  updateParcel,
  archiveParcel,
  appendParcelEvent,
  listParcelEvents,
  getParcelStats,
};
