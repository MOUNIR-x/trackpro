const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const DEFAULT_SECRET = 'tracking-app-dev-secret';

function getJwtSecret() {
  return process.env.JWT_SECRET || DEFAULT_SECRET;
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function comparePassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function signToken(user) {
  return jwt.sign(
    {
      sub: Number(user.id),
      email: user.email,
      role: user.role,
    },
    getJwtSecret(),
    { expiresIn: '7d' },
  );
}

function verifyToken(token) {
  return jwt.verify(token, getJwtSecret());
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token || token.trim() === '') {
    return res.status(401).json({ message: 'Token d\'authentification requis.' });
  }

  try {
    const payload = verifyToken(token);
    if (!payload || !payload.sub || !payload.email || !payload.role) {
      return res.status(401).json({ message: 'Token invalide ou expiré.' });
    }

    req.user = payload;
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Token invalide ou expiré.' });
  }
}

function requireRole(roleName) {
  return (req, res, next) => {
    if (!req.user || !req.user.sub || req.user.role !== roleName) {
      return res.status(403).json({ message: `Accès refusé: rôle ${roleName} requis.` });
    }
    return next();
  };
}

module.exports = {
  getJwtSecret,
  hashPassword,
  comparePassword,
  signToken,
  verifyToken,
  requireAuth,
  requireRole,
};
