import crypto from 'node:crypto';

export interface OAuthConfig {
  googleClientId: string;
  googleClientSecret: string;
  githubClientId: string;
  githubClientSecret: string;
  allowedGoogleEmails: string[];
  allowedGithubLogins: string[];
}

export function loadOAuthConfig(): OAuthConfig {
  const splitCsv = (val?: string) =>
    (val || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

  return {
    googleClientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
    googleClientSecret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
    githubClientId: (process.env.GITHUB_CLIENT_ID || '').trim(),
    githubClientSecret: (process.env.GITHUB_CLIENT_SECRET || '').trim(),
    allowedGoogleEmails: splitCsv(process.env.RIPPLE_ALLOWED_GOOGLE_EMAILS),
    allowedGithubLogins: splitCsv(process.env.RIPPLE_ALLOWED_GITHUB_LOGINS),
  };
}

export function isGoogleOAuthConfigured(cfg: OAuthConfig): boolean {
  return Boolean(cfg.googleClientId && cfg.googleClientSecret);
}

export function isGithubOAuthConfigured(cfg: OAuthConfig): boolean {
  return Boolean(cfg.githubClientId && cfg.githubClientSecret);
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildGoogleAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export async function exchangeGoogleCode(params: {
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ sub: string; email: string; emailVerified: boolean; name: string; picture?: string }> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: params.codeVerifier,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Google token exchange failed (${tokenRes.status})`);
  }
  const tokenData = (await tokenRes.json()) as { access_token?: string };
  if (!tokenData.access_token) {
    throw new Error('Google token response missing access_token');
  }

  const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!userRes.ok) {
    throw new Error(`Google userinfo fetch failed (${userRes.status})`);
  }
  const u = (await userRes.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
  if (!u.sub || !u.email) {
    throw new Error('Google userinfo missing sub or email');
  }
  return {
    sub: String(u.sub),
    email: String(u.email).toLowerCase(),
    emailVerified: Boolean(u.email_verified),
    name: String(u.name || u.email.split('@')[0]),
    picture: u.picture,
  };
}

export function buildGithubAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', params.state);
  return url.toString();
}

export async function exchangeGithubCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ id: string; login: string; name?: string }> {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`GitHub token exchange failed (${tokenRes.status})`);
  }
  const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenData.access_token) {
    throw new Error(`GitHub token response missing access_token (${tokenData.error || 'unknown'})`);
  }

  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Ripple-Workspace',
    },
  });
  if (!userRes.ok) {
    throw new Error(`GitHub user fetch failed (${userRes.status})`);
  }
  const u = (await userRes.json()) as { id?: number | string; login?: string; name?: string };
  if (!u.id || !u.login) {
    throw new Error('GitHub user response missing id or login');
  }
  return {
    id: String(u.id),
    login: String(u.login),
    name: u.name,
  };
}
