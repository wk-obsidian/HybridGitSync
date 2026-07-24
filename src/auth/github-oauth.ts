import { requestUrl } from 'obsidian';

const CLIENT_ID = 'Ov23li2X90e8LQf3d9ou';
const SCOPE = 'repo';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_BASE = 'https://api.github.com';

// Debug logging (set to true to enable OAuth debug logs)
const DEBUG = false;

function log(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[OAuth]', ...args);
  }
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface RepoInfo {
  full_name: string;
  name: string;
  description: string;
  private: boolean;
  default_branch: string;
}

export interface OAuthResult {
  success: boolean;
  token?: string;
  username?: string;
  error?: string;
}

export interface Repo {
  fullName: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
}

/**
 * Step 1: Request device code from GitHub
 */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await requestUrl({
    url: DEVICE_CODE_URL,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: SCOPE,
    }),
    throw: false,
  });

  if (response.status !== 200) {
    throw new Error(`Failed to request device code: ${response.text}`);
  }

  return response.json as DeviceCodeResponse;
}

/**
 * Step 2: Poll for access token
 */
export async function pollForAccessToken(
  deviceCode: string,
  interval: number = 5,
  maxAttempts: number = 60
): Promise<OAuthResult> {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(interval * 1000);
    log(`Polling attempt ${i + 1}/${maxAttempts}...`);

    const response = await requestUrl({
      url: ACCESS_TOKEN_URL,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
      throw: false,
    });

    log('Response status:', response.status);
    log('Response body:', response.text);

    if (response.status !== 200) {
      log('Non-200 status, continuing...');
      continue;
    }

    const data = response.json as TokenResponse;
    log('Parsed response:', data);

    if (data.access_token) {
      log('Got access token!');
      const username = await getUsername(data.access_token);
      return { success: true, token: data.access_token, username };
    }

    if (data.error === 'authorization_pending') {
      log('Still pending...');
      continue;
    }

    if (data.error === 'slow_down') {
      log('Slowing down...');
      interval += 5;
      continue;
    }

    log('Error:', data.error, data.error_description);
    return { success: false, error: data.error_description || data.error };
  }

  return { success: false, error: 'Authorization timed out' };
}

/**
 * Get username from token
 */
export async function getUsername(token: string): Promise<string | undefined> {
  try {
    const response = await requestUrl({
      url: `${API_BASE}/user`,
      headers: { 'Authorization': `token ${token}` },
      throw: false,
    });
    if (response.status === 200) {
      return (response.json as { login: string }).login;
    }
  } catch { /* ignore */ }
  return undefined;
}

/**
 * Verify token is valid
 */
export async function verifyToken(token: string): Promise<boolean> {
  const username = await getUsername(token);
  return username !== undefined;
}

/**
 * Get user's repositories
 */
export async function listRepos(token: string): Promise<Repo[]> {
  const repos: Repo[] = [];
  let page = 1;

  while (true) {
    const response = await requestUrl({
      url: `${API_BASE}/user/repos?per_page=100&page=${page}&sort=updated`,
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/json',
      },
      throw: false,
    });

    if (response.status !== 200) break;

    const data = response.json as RepoInfo[];
    if (data.length === 0) break;

    for (const repo of data) {
      repos.push({
        fullName: repo.full_name,
        name: repo.name,
        description: repo.description || '',
        private: repo.private,
        defaultBranch: repo.default_branch,
      });
    }

    if (data.length < 100) break;
    page++;
  }

  return repos;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}
