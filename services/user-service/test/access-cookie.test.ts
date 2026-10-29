import { afterEach, expect, it, vi } from 'vitest';
import { setAccessCookie } from '../src/auth/auth.controller.js';
afterEach(() => vi.unstubAllEnvs());
it('issues and clears HttpOnly secure cookies without exposing tokens to JavaScript', () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('AUTH_COOKIE_DOMAIN', '.example.test');
  const response = { setHeader: vi.fn() };
  setAccessCookie(response, 'jwt.token', 900);
  expect(response.setHeader).toHaveBeenCalledWith(
    'Set-Cookie',
    'wgo_access_token=jwt.token; Path=/; HttpOnly; Max-Age=900; SameSite=None; Secure; Domain=.example.test',
  );
  setAccessCookie(response, '', 0);
  expect(response.setHeader.mock.calls.at(-1)![1]).toContain('Max-Age=0');
});
