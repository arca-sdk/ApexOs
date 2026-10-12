import type { Mock } from '../context.ts';
import { callError, queryFilter, validationError, validationErrors, type MethodContext } from '../rpc.ts';
import type { ApiKeyState, UserState } from '../state.ts';
import { $date, argObj, randomString, type Obj } from '../util.ts';
import { findUserByName, userObj, userRoles } from './accounts.ts';

const MAX_KEYS_PER_USER = 10;

function renderApiKey(mock: Mock, k: ApiKeyState): Obj {
  const user = findUserByName(mock.state, k.username);
  return {
    id: k.id,
    name: k.name,
    username: k.username,
    user_identifier: user ? user.uid : k.username,
    keyhash: `$pbkdf2-sha256$29000$${Buffer.from(k.key).toString('base64').slice(0, 22)}$********`,
    created_at: $date(k.created_at),
    expires_at: k.expires_at ? $date(k.expires_at) : null,
    local: true,
    revoked: k.revoked,
    revoked_reason: k.revoked_reason,
  };
}

function validKey(mock: Mock, key: unknown): ApiKeyState | undefined {
  if (typeof key !== 'string') return undefined;
  const k = mock.state.apiKeys.find((x) => x.key === key);
  if (!k || k.revoked || (k.expires_at && k.expires_at < Date.now())) return undefined;
  const user = findUserByName(mock.state, k.username);
  if (!user || user.locked || !userRoles(mock.state, user).length) return undefined;
  return k;
}

function passwordUser(mock: Mock, username: unknown, password: unknown): UserState | undefined {
  if (typeof username !== 'string' || typeof password !== 'string') return undefined;
  const u = findUserByName(mock.state, username);
  if (!u || u.locked || u.password_disabled || !u.password || u.password !== password) return undefined;
  return u;
}

export function authMe(mock: Mock, u: UserState, mechanism: 'PASSWORD' | 'API_KEY' | 'TOKEN'): Obj {
  const roles = userRoles(mock.state, u);
  return {
    ...userObj(mock.state, u, true),
    attributes: {},
    two_factor_config: { secret_configured: false, interval: 30, otp_digits: 6 },
    privilege: {
      roles: { $set: roles },
      allowlist: roles.includes('FULL_ADMIN') ? [{ method: '*', resource: '*' }] : [],
      web_shell: roles.includes('FULL_ADMIN'),
    },
    account_attributes: ['LOCAL', mechanism === 'API_KEY' ? 'API_KEY' : 'PASSWORD_LOGIN'],
  };
}

function login(mock: Mock, ctx: MethodContext, u: UserState, mechanism: 'PASSWORD' | 'API_KEY' | 'TOKEN', userInfo: boolean): Obj {
  ctx.setAuthenticated(u.username);
  return { response_type: 'SUCCESS', authenticator: 'LEVEL_1', user_info: userInfo ? authMe(mock, u, mechanism) : null };
}

export function registerAuth(mock: Mock): void {
  const { server } = mock;
  const sessionMechanism = new Map<string, 'PASSWORD' | 'API_KEY' | 'TOKEN'>();

  server.method('auth.login_with_api_key', (p, ctx) => {
    const k = validKey(mock, p[0]);
    if (!k) return false;
    ctx.setAuthenticated(k.username);
    sessionMechanism.set(k.username, 'API_KEY');
    return true;
  });

  server.method('auth.login', (p, ctx) => {
    const u = passwordUser(mock, p[0], p[1]);
    if (!u) return false;
    ctx.setAuthenticated(u.username);
    return true;
  });

  server.method('auth.login_with_token', (p, ctx) => {
    const t = mock.tokens.get(String(p[0]));
    if (!t || t.expires < Date.now()) return false;
    if (t.singleUse) mock.tokens.delete(String(p[0]));
    ctx.setAuthenticated(t.username);
    return true;
  });

  server.method('auth.mechanism_choices', () => ['API_KEY_PLAIN', 'PASSWORD_PLAIN', 'TOKEN_PLAIN', 'OTP_TOKEN']);

  server.method('auth.login_ex', (p, ctx) => {
    const data = argObj(p[0], 'auth_login_ex.login_data');
    const userInfo = (argObj(data.login_options, 'auth_login_ex.login_data.login_options').user_info ?? true) !== false;
    switch (data.mechanism) {
      case 'PASSWORD_PLAIN': {
        const u = passwordUser(mock, data.username, data.password);
        return u ? login(mock, ctx, u, 'PASSWORD', userInfo) : { response_type: 'AUTH_ERR' };
      }
      case 'API_KEY_PLAIN': {
        const k = validKey(mock, data.api_key);
        if (!k || k.username !== data.username) return { response_type: 'AUTH_ERR' };
        const u = findUserByName(mock.state, k.username)!;
        sessionMechanism.set(u.username, 'API_KEY');
        return login(mock, ctx, u, 'API_KEY', userInfo);
      }
      case 'TOKEN_PLAIN': {
        const t = mock.tokens.get(String(data.token));
        const u = t && t.expires >= Date.now() ? findUserByName(mock.state, t.username) : undefined;
        if (!u) return { response_type: 'AUTH_ERR' };
        if (t?.singleUse) mock.tokens.delete(String(data.token));
        return login(mock, ctx, u, 'TOKEN', userInfo);
      }
      case 'OTP_TOKEN':
        return { response_type: 'AUTH_ERR' };
      default:
        throw validationError(
          'auth_login_ex.login_data.mechanism',
          "Input tag does not match any of the expected tags: 'API_KEY_PLAIN', 'PASSWORD_PLAIN', 'TOKEN_PLAIN', 'OTP_TOKEN'",
        );
    }
  });

  server.method('auth.logout', (_p, ctx) => {
    ctx.logout();
    return true;
  });

  server.method('auth.me', (_p, ctx) => {
    const u = ctx.username ? findUserByName(mock.state, ctx.username) : undefined;
    if (!u) throw callError('EPERM', 'Unexpected credential type');
    return authMe(mock, u, sessionMechanism.get(u.username) ?? 'PASSWORD');
  });

  server.method('auth.generate_token', (p, ctx) => {
    const ttl = typeof p[0] === 'number' ? p[0] : 600;
    const token = randomString(64);
    mock.tokens.set(token, { username: ctx.username ?? mock.config.adminUsername, expires: Date.now() + ttl * 1000, singleUse: p[3] === true });
    return token;
  });

  server.method('auth.sessions', (p, ctx) =>
    queryFilter(
      [
        {
          id: 'current',
          current: true,
          internal: false,
          origin: '127.0.0.1:52344',
          credentials: 'LOGIN_PASSWORD',
          credentials_data: { username: ctx.username },
          created_at: $date(Date.now() - 60_000),
          secure_transport: true,
        },
      ],
      p[0],
      p[1],
    ),
  );

  // API keys
  const keys = () => mock.state.apiKeys.map((k) => renderApiKey(mock, k));
  server.method('api_key.query', (p) => queryFilter(keys(), p[0], p[1]));
  server.method('api_key.get_instance', (p) => queryFilter(keys(), [['id', '=', p[0]]], { get: true }));
  server.method('api_key.my_keys', (_p, ctx) => keys().filter((k) => k.username === ctx.username));

  server.method('api_key.create', (p) => {
    const { state } = mock;
    const data = argObj(p[0], 'api_key_create');
    const errors: Array<[string, string]> = [];
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    const username = typeof data.username === 'string' ? data.username : '';
    if (!name) errors.push(['api_key_create.name', 'Field required']);
    else if (state.apiKeys.some((k) => k.name === name)) errors.push(['api_key_create.name', 'name must be unique']);
    const user = username ? findUserByName(state, username) : undefined;
    if (!username) errors.push(['api_key_create.username', 'Field required']);
    else if (!user) errors.push(['api_key_create.username', `${username}: user does not exist.`]);
    else if (!userRoles(state, user).length) {
      errors.push(['api_key_create.username', `${username}: user does not have any roles assigned and therefore cannot create API keys.`]);
    } else if (state.apiKeys.filter((k) => k.username === username).length >= MAX_KEYS_PER_USER) {
      errors.push(['api_key_create.username', `${username}: user has reached the maximum number of API keys (${MAX_KEYS_PER_USER}).`]);
    }
    const expires = data.expires_at as { $date?: number } | null | undefined;
    if (errors.length) throw validationErrors(errors);
    const id = state.nextIds.apiKey++;
    const key: ApiKeyState = {
      id,
      name,
      username,
      key: `${id}-${randomString(64)}`,
      created_at: Date.now(),
      expires_at: expires && typeof expires.$date === 'number' ? expires.$date : null,
      revoked: false,
      revoked_reason: null,
    };
    state.apiKeys.push(key);
    const entry = renderApiKey(mock, key);
    mock.emit('api_key.query', 'added', id, entry);
    return { ...entry, key: key.key };
  });

  server.method('api_key.update', (p) => {
    const k = mock.state.apiKeys.find((x) => x.id === p[0]);
    if (!k) throw callError('ENOENT', `API key ${String(p[0])} does not exist`);
    const data = argObj(p[1], 'api_key_update');
    if (typeof data.name === 'string' && data.name) k.name = data.name;
    if ('expires_at' in data) {
      const e = data.expires_at as { $date?: number } | null;
      k.expires_at = e && typeof e.$date === 'number' ? e.$date : null;
    }
    const entry: Obj = renderApiKey(mock, k);
    if (data.reset === true) {
      k.key = `${k.id}-${randomString(64)}`;
      k.revoked = false;
      k.revoked_reason = null;
      entry.key = k.key;
      entry.revoked = false;
    }
    mock.emit('api_key.query', 'changed', k.id, renderApiKey(mock, k));
    return entry;
  });

  server.method('api_key.delete', (p) => {
    const before = mock.state.apiKeys.length;
    mock.state.apiKeys = mock.state.apiKeys.filter((k) => k.id !== p[0]);
    if (mock.state.apiKeys.length === before) throw callError('ENOENT', `API key ${String(p[0])} does not exist`);
    mock.emit('api_key.query', 'removed', p[0]);
    return true;
  });
}
