/**
 * Authentication — server-side sessions in an httpOnly cookie.
 *
 * The cookie holds an opaque random token. Only its SHA-256 hash is stored, so
 * a database dump does not yield usable sessions. Passwords are bcrypt-hashed.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';
import { prisma } from './db';
import { authLogger } from './logger';
import type { UserRole } from '@prisma/client';

const COOKIE_NAME = 'arihant_session';
const SESSION_DAYS = 7;
const BCRYPT_ROUNDS = 12;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface LoginContext {
  userAgent?: string;
  ipAddress?: string;
}

export type LoginResult =
  | { ok: true; user: SessionUser }
  | { ok: false; error: string };

export async function login(
  email: string,
  password: string,
  context: LoginContext = {},
): Promise<LoginResult> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });

  // Always run a bcrypt comparison so a missing account and a wrong password
  // take the same time and cannot be told apart by timing.
  const hash = user?.passwordHash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const passwordOk = await verifyPassword(password, hash);

  if (!user || !passwordOk || !user.isActive) {
    authLogger.warn({ email, reason: !user ? 'no-account' : !passwordOk ? 'bad-password' : 'inactive' }, 'login failed');
    await prisma.auditLog.create({
      data: { action: 'LOGIN_FAILED', entity: 'User', metadata: { email }, ipAddress: context.ipAddress },
    });
    return { ok: false, error: 'Email or password is incorrect.' };
  }

  const token = randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);

  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
    },
  });

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await prisma.auditLog.create({
    data: { userId: user.id, action: 'LOGIN', entity: 'User', entityId: user.id, ipAddress: context.ipAddress },
  });

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: (process.env.APP_URL ?? '').startsWith('https://'),
    path: '/',
    expires: expiresAt,
  });

  authLogger.info({ userId: user.id }, 'login');
  return { ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
}

export async function logout(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
  store.delete(COOKIE_NAME);
}

/** The current user, or null. Expired sessions are cleaned up as they are hit. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!session) return null;

  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  if (!session.user.isActive) return null;

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
  };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== 'ADMIN') throw new ForbiddenError();
  return user;
}

/** Analysts and admins may import; viewers may not. */
export async function requireImporter(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role === 'VIEWER') throw new ForbiddenError();
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Authentication required.');
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  constructor() {
    super('You do not have permission to do that.');
    this.name = 'ForbiddenError';
  }
}

/** Remove expired sessions. Called opportunistically from the admin page. */
export async function pruneSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return count;
}

/** Constant-time string comparison for non-hash secrets. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
