import express from 'express';
import { body, validationResult } from 'express-validator';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createUser, findUser, getUserById } from '../auth/userStore.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../auth/tokens.js';
import { saveRefreshToken, consumeRefreshToken, revokeFamily, revokeUserTokens } from '../auth/refreshTokenStore.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

function issueRefreshToken(payload, familyId) {
  const { token, jti, familyId: family, expiresAt } = signRefreshToken(payload, { familyId });
  saveRefreshToken({ jti, familyId: family, userId: payload.sub, expiresAt });
  return token;
}

const validateBody = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
};

const userRules = [
  body('username').trim().isLength({ min: 3, max: 32 }).withMessage('Username must be 3-32 chars'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 chars'),
];

// POST /api/auth/register
router.post('/register', userRules, validateBody, async (req, res) => {
  try {
    const { username, password } = req.body;
    const passwordHash = await hashPassword(password);
    const user = createUser(username, passwordHash);
    res.status(201).json({ user });
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});

// POST /api/auth/login
router.post('/login', userRules, validateBody, async (req, res) => {
  const { username, password } = req.body;
  const user = findUser(username);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const payload = { sub: user.id, username: user.username };
  res.json({
    accessToken: signAccessToken(payload),
    refreshToken: issueRefreshToken(payload),
  });
});

// POST /api/auth/refresh
router.post('/refresh', (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  let claims;
  try {
    claims = verifyRefreshToken(refreshToken);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
  const { sub, username, jti, familyId } = claims;
  const result = consumeRefreshToken(jti, familyId);
  if (!result.ok) {
    const error = result.reason === 'replay'
      ? 'Refresh token reuse detected; session revoked'
      : 'Invalid or expired refresh token';
    return res.status(401).json({ error });
  }
  const payload = { sub, username };
  res.json({
    accessToken: signAccessToken(payload),
    refreshToken: issueRefreshToken(payload, familyId),
  });
});

// POST /api/auth/logout — revokes the supplied refresh token family, or all user tokens if none given
router.post('/logout', requireAuth, (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (refreshToken) {
    try {
      const { familyId, sub } = verifyRefreshToken(refreshToken);
      if (sub === req.user.sub) revokeFamily(familyId);
    } catch { /* ignore invalid token */ }
  } else {
    revokeUserTokens(req.user.sub);
  }
  res.json({ message: 'Logged out successfully' });
});

// GET /api/auth/profile
router.get('/profile', requireAuth, (req, res) => {
  const user = getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, username: user.username, createdAt: user.createdAt });
});

export default router;
