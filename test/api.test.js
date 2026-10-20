const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app');

async function requestJson(app, method, path, body, token) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    return { status: response.status, data };
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

test('registers an admin user and returns JWT', async () => {
  const app = createApp({ useMemoryDb: true });

  const result = await requestJson(app, 'POST', '/api/auth/register', {
    name: 'Admin Test',
    email: 'admin@test.com',
    password: 'Password123!',
    role: 'admin',
  });

  assert.equal(result.status, 201);
  assert.ok(result.data.token);
  assert.equal(result.data.user.role, 'admin');
});

test('creates a parcel and exposes it to the public tracking API', async () => {
  const app = createApp({ useMemoryDb: true });

  const adminAuth = await requestJson(app, 'POST', '/api/auth/register', {
    name: 'Admin Test',
    email: 'admin2@test.com',
    password: 'Password123!',
    role: 'admin',
  });

  const parcelCreate = await requestJson(
    app,
    'POST',
    '/api/admin/parcels',
    {
      trackingNumber: 'PKG-1001',
      recipientName: 'Jean Dupont',
      recipientPhone: '+33600000000',
      recipientEmail: 'jean@example.com',
      deliveryAddress: '12 rue de la Paix, Paris',
      senderName: 'Acme Logistics',
      company: 'Acme Logistics',
      description: 'Électronique',
      origin: 'Paris',
      destination: 'Lyon',
      route: {
        type: 'LineString',
        coordinates: [
          [2.3499, 48.8566],
          [4.8357, 45.7640],
        ],
      },
    },
    adminAuth.data.token,
  );

  assert.equal(parcelCreate.status, 201);
  assert.equal(parcelCreate.data.parcel.trackingNumber, 'PKG-1001');

  const publicResult = await requestJson(app, 'GET', '/api/public/track/PKG-1001');
  assert.equal(publicResult.status, 200);
  assert.equal(publicResult.data.parcel.trackingNumber, 'PKG-1001');
  assert.ok(publicResult.data.parcel.timeline);
});

test('starts a parcel from 0% and updates its live status through the admin control route', async () => {
  const app = createApp({ useMemoryDb: true });

  const auth = await requestJson(app, 'POST', '/api/auth/register', {
    name: 'Route Admin',
    email: 'route-admin@test.com',
    password: 'Password123!',
    role: 'admin',
  });

  const parcelCreate = await requestJson(
    app,
    'POST',
    '/api/admin/parcels',
    {
      trackingNumber: 'PKG-START-01',
      recipientName: 'Alain Martin',
      recipientPhone: '+33600000000',
      recipientEmail: 'alain@example.com',
      deliveryAddress: '5 avenue de Paris, Lyon',
      senderName: 'TrackPro',
      company: 'TrackPro',
      origin: 'Paris',
      destination: 'Lyon',
      status: 'pending',
      progress: 0,
      speed: 60,
      route: {
        type: 'LineString',
        coordinates: [
          [2.3499, 48.8566],
          [4.8357, 45.7640],
        ],
      },
    },
    auth.data.token,
  );

  assert.equal(parcelCreate.status, 201);
  assert.equal(parcelCreate.data.parcel.progress, 0);

  const startResult = await requestJson(
    app,
    'POST',
    `/api/admin/parcels/${parcelCreate.data.parcel.id}/control`,
    { action: 'start', speed: 60 },
    auth.data.token,
  );

  assert.equal(startResult.status, 200);
  assert.equal(startResult.data.parcel.status, 'in_transit');
  assert.ok(Number(startResult.data.parcel.progress) >= 0);

  const publicResult = await requestJson(app, 'GET', '/api/public/track/PKG-START-01');
  assert.equal(publicResult.status, 200);
  assert.equal(publicResult.data.parcel.status, 'in_transit');
  assert.equal(publicResult.data.parcel.progress, startResult.data.parcel.progress);
});

test('rejects weak credentials and malformed payloads', async () => {
  const app = createApp({ useMemoryDb: true });

  const weakPassword = await requestJson(app, 'POST', '/api/auth/register', {
    name: 'Weak User',
    email: 'weak@example.com',
    password: '123',
    role: 'admin',
  });

  assert.equal(weakPassword.status, 400);

  const malformedParcel = await requestJson(
    app,
    'POST',
    '/api/admin/parcels',
    {
      trackingNumber: 'PKG-ERR',
      recipientName: 'Jean',
      deliveryAddress: 'A',
      destination: 'Lyon',
      route: { type: 'LineString', coordinates: [[1, 2]] },
    },
    'invalid-token',
  );

  assert.equal(malformedParcel.status, 401);
});

test('blocks access to admin routes for invalid bearer tokens', async () => {
  const app = createApp({ useMemoryDb: true });

  const response = await requestJson(app, 'GET', '/api/admin/stats', undefined, 'not-a-real-token');
  assert.equal(response.status, 401);
});

test('does not hardcode Supabase credentials when env is missing', () => {
  const { resolveSupabaseConfig } = require('../app');

  const config = resolveSupabaseConfig({
    SUPABASE_URL: '',
    NEXT_PUBLIC_SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '',
  });

  assert.deepEqual(config, { url: '', key: '' });
});
