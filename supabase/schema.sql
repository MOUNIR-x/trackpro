CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  passwordHash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  company TEXT NOT NULL DEFAULT 'TrackPro',
  createdAt TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updatedAt TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS parcels (
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
  currentLatitude DOUBLE PRECISION,
  currentLongitude DOUBLE PRECISION,
  progress REAL NOT NULL DEFAULT 0,
  simulationSpeed REAL NOT NULL DEFAULT 60,
  isRunning INTEGER NOT NULL DEFAULT 0,
  routeGeoJson TEXT,
  distanceTotal REAL NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  createdBy BIGINT,
  createdAt TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updatedAt TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_parcels_created_by FOREIGN KEY (createdBy) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS parcel_events (
  id BIGSERIAL PRIMARY KEY,
  parcelId BIGINT NOT NULL,
  type TEXT NOT NULL,
  status TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  reason TEXT,
  note TEXT,
  createdBy BIGINT,
  createdAt TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_events_parcel FOREIGN KEY (parcelId) REFERENCES parcels(id) ON DELETE CASCADE,
  CONSTRAINT fk_events_created_by FOREIGN KEY (createdBy) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_parcels_tracking_number ON parcels(trackingNumber);
CREATE INDEX IF NOT EXISTS idx_parcels_archived ON parcels(archived);
CREATE INDEX IF NOT EXISTS idx_parcels_status ON parcels(status);
CREATE INDEX IF NOT EXISTS idx_parcel_events_parcel ON parcel_events(parcelId);
