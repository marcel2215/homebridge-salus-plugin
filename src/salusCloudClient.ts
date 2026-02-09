/* eslint-disable @typescript-eslint/no-use-before-define */

import type { Logging } from 'homebridge';
import process from 'node:process';

import { baseNameForProperty, normalizeModelName, parseBooleanLike, parseNumberLike } from './propertyUtils.js';
import type {
  SalusApiVersionPreference,
  SalusDevice,
  SalusPlatformConfig,
  SalusProperty,
  SalusPropertyMap,
  SalusRegion,
} from './types.js';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RequestOptions {
  method: HttpMethod;
  body?: unknown;
  auth?: boolean;
  allow401Refresh?: boolean;
  expectedStatuses?: number[];
}

interface CognitoSession {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAtEpochMs: number;
}

interface ShadowRequestVariant {
  method: HttpMethod;
  path: string;
  body?: unknown;
  description: string;
}

interface WriteAttempt {
  method: HttpMethod;
  path: string;
  body: unknown;
  description: string;
}

class HttpStatusError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody: string,
  ) {
    super(message);
  }
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 750;
const DEFAULT_COGNITO_REGION = 'eu-central-1';
const DEFAULT_COGNITO_CLIENT_ID = '4pk5efh3v84g5dav43imsv4fbj';
const DEFAULT_EU_SERVICE_API_HOST = 'https://service-api.eu.premium.salusconnect.io';
const DEFAULT_US_SERVICE_API_HOST = 'https://service-api.us.premium.salusconnect.io';
const FALLBACK_US_SERVICE_API_HOST = 'https://service-api.us.salusconnect.io';
const FALLBACK_EU_SERVICE_API_HOST = 'https://service-api.eu.salusconnect.io';

const COGNITO_INITIATE_AUTH_TARGET = 'AWSCognitoIdentityProviderService.InitiateAuth';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9,en;q=0.8';
const SESSION_REFRESH_SAFETY_MS = 60_000;

const STATUS_ALLOW_PATH_FALLBACK = new Set([404, 405, 426]);
const STATUS_ALLOW_WRITE_SHAPE_FALLBACK = new Set([400, 404, 405, 409, 415, 422]);
const DEFAULT_EXPECTED_STATUSES = [200, 201, 202, 204];

const METADATA_FIELD_NAMES = new Set([
  'id',
  'key',
  'dsn',
  'name',
  'model',
  'product_name',
  'oem_model',
  'type',
  'status',
  'online',
  'created_at',
  'updated_at',
  'timestamp',
  'state',
  'shadow',
  'reported',
  'desired',
  'version',
  'gateway',
  'gateway_id',
  'user_id',
  'occupant_id',
]);

export class SalusCloudClient {
  private session: CognitoSession | null = null;
  private authRequestInFlight: Promise<void> | null = null;

  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly verboseLogging: boolean;
  private readonly allowInsecureTls: boolean;

  private readonly serviceApiBaseCandidates: string[];
  private readonly cognitoEndpoint: string;
  private readonly cognitoClientId: string;
  private readonly companyCode: string | null;

  private activeServiceApiBaseUrl: string | null = null;

  private readonly propertyCacheByDsn: Map<string, SalusPropertyMap> = new Map();
  private readonly deviceIdToDsn: Map<string, string> = new Map();
  private readonly deviceKeyToDsn: Map<string, string> = new Map();

  constructor(
    private readonly log: Logging,
    private readonly config: SalusPlatformConfig,
  ) {
    this.requestTimeoutMs = Math.max(5_000, Math.round((config.requestTimeoutSeconds ?? 30) * 1_000));
    this.maxRetries = Math.max(0, Math.floor(config.maxRetries ?? DEFAULT_MAX_RETRIES));
    this.retryBaseDelayMs = Math.max(250, Math.floor(config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS));
    this.verboseLogging = config.verboseLogging ?? false;
    this.allowInsecureTls = config.allowInsecureTls ?? false;

    this.serviceApiBaseCandidates = buildServiceApiBaseCandidates(
      config.region,
      config.apiHost,
      config.apiVersionPreference,
    );

    const cognitoRegion = normalizeNonEmptyString(config.cognitoRegion) ?? DEFAULT_COGNITO_REGION;
    this.cognitoClientId = normalizeNonEmptyString(config.cognitoClientId) ?? DEFAULT_COGNITO_CLIENT_ID;
    this.cognitoEndpoint = `https://cognito-idp.${cognitoRegion}.amazonaws.com/`;
    this.companyCode = normalizeNonEmptyString(config.companyCode) ?? null;

    if (this.allowInsecureTls) {
      this.log.warn('TLS certificate validation is disabled for Salus cloud requests (allowInsecureTls=true).');
    }
    if (this.verboseLogging) {
      this.log.debug(`Salus service-api candidates: ${this.serviceApiBaseCandidates.join(', ')}`);
      this.log.debug(`Salus Cognito endpoint: ${this.cognitoEndpoint}`);
    }
  }

  public getCloudBaseUrl(): string {
    return this.activeServiceApiBaseUrl ?? this.serviceApiBaseCandidates[0]!;
  }

  public async listDevices(): Promise<SalusDevice[]> {
    const payload = await this.requestServiceJsonWithPathFallback<unknown>(
      ['/devices/', '/devices'],
      {
        method: 'GET',
        auth: true,
      },
    );

    const devices = parseDevices(payload);
    this.rebuildDeviceIndex(devices);

    const inlineShadows = parseDeviceShadows(payload, this.deviceIdToDsn, this.deviceKeyToDsn);
    if (inlineShadows.size > 0) {
      this.replacePropertyCache(inlineShadows);
      if (this.verboseLogging) {
        this.log.debug(`Hydrated property cache from /devices response for ${inlineShadows.size} device(s)`);
      }
    }

    const shadowPayload = await this.fetchDeviceShadows(devices);
    if (shadowPayload.size > 0) {
      this.mergeIntoPropertyCache(shadowPayload);
      if (this.verboseLogging) {
        this.log.debug(`Hydrated property cache from devices/device_shadows for ${shadowPayload.size} device(s)`);
      }
    } else if (devices.length > 0 && inlineShadows.size === 0) {
      this.log.warn('No property payload was returned by devices/device_shadows. Accessory states may stay stale until Salus API responds.');
    }

    if (this.verboseLogging) {
      this.log.debug(`Salus cloud returned ${devices.length} device(s)`);
    }

    return devices;
  }

  public async listProperties(dsn: string): Promise<SalusPropertyMap> {
    const cached = this.propertyCacheByDsn.get(dsn);
    if (cached) {
      return cached;
    }

    const shadows = await this.fetchDeviceShadows([], [dsn]);
    const fromFetch = shadows.get(dsn);
    if (fromFetch) {
      this.propertyCacheByDsn.set(dsn, fromFetch);
      return fromFetch;
    }

    if (this.verboseLogging) {
      this.log.debug(`No cloud property shadow found for dsn=${dsn}. Returning empty property map.`);
    }

    return new Map();
  }

  public async setDatapoint(dsn: string, propertyName: string, value: unknown): Promise<void> {
    const attempts = this.buildWriteAttempts(dsn, propertyName, value);
    const failures: string[] = [];

    for (const attempt of attempts) {
      try {
        await this.requestServiceJson(attempt.path, {
          method: attempt.method,
          body: attempt.body,
          auth: true,
          expectedStatuses: DEFAULT_EXPECTED_STATUSES,
        });

        this.updateCachedProperty(dsn, propertyName, value);
        if (this.verboseLogging) {
          this.log.debug(`Write succeeded via ${attempt.description}`);
        }
        return;
      } catch (error) {
        if (error instanceof HttpStatusError && STATUS_ALLOW_WRITE_SHAPE_FALLBACK.has(error.status)) {
          failures.push(`${attempt.description} -> HTTP ${error.status}`);
          continue;
        }
        failures.push(`${attempt.description} -> ${asErrorMessage(error)}`);
      }
    }

    throw new Error(`Failed to write property ${propertyName} on ${dsn}. Attempts: ${failures.join(' | ')}`);
  }

  private rebuildDeviceIndex(devices: SalusDevice[]): void {
    this.deviceIdToDsn.clear();
    this.deviceKeyToDsn.clear();

    for (const device of devices) {
      this.deviceIdToDsn.set(device.id, device.dsn);
      if (device.key) {
        this.deviceKeyToDsn.set(device.key, device.dsn);
      }
    }
  }

  private replacePropertyCache(next: Map<string, SalusPropertyMap>): void {
    this.propertyCacheByDsn.clear();
    for (const [dsn, properties] of next) {
      this.propertyCacheByDsn.set(dsn, properties);
    }
  }

  private mergeIntoPropertyCache(next: Map<string, SalusPropertyMap>): void {
    for (const [dsn, properties] of next) {
      const existing = this.propertyCacheByDsn.get(dsn);
      if (!existing) {
        this.propertyCacheByDsn.set(dsn, properties);
        continue;
      }
      mergePropertyMaps(existing, properties);
    }
  }

  private async fetchDeviceShadows(devices: SalusDevice[], preferredDsns?: string[]): Promise<Map<string, SalusPropertyMap>> {
    const dsns = [...new Set((preferredDsns ?? devices.map((device) => device.dsn)).filter((value) => value.trim() !== ''))];
    const ids = [...new Set(devices.map((device) => device.id).filter((value) => value.trim() !== ''))];
    const keys = [...new Set(devices.map((device) => device.key).filter((value): value is string => Boolean(value && value.trim() !== '')))] ;

    const variants: ShadowRequestVariant[] = [
      {
        method: 'GET',
        path: '/devices/device_shadows',
        description: 'GET /devices/device_shadows',
      },
    ];

    if (dsns.length > 0) {
      variants.push({
        method: 'GET',
        path: `/devices/device_shadows?dsns=${encodeURIComponent(dsns.join(','))}`,
        description: 'GET /devices/device_shadows?dsns=',
      });
      variants.push({
        method: 'POST',
        path: '/devices/device_shadows',
        body: { dsns },
        description: 'POST /devices/device_shadows {dsns}',
      });
      variants.push({
        method: 'POST',
        path: '/devices/device_shadows',
        body: {
          devices: dsns.map((dsn) => ({ dsn })),
        },
        description: 'POST /devices/device_shadows {devices:[{dsn}]}',
      });
    }

    if (ids.length > 0) {
      variants.push({
        method: 'GET',
        path: `/devices/device_shadows?device_ids=${encodeURIComponent(ids.join(','))}`,
        description: 'GET /devices/device_shadows?device_ids=',
      });
      variants.push({
        method: 'POST',
        path: '/devices/device_shadows',
        body: { device_ids: ids },
        description: 'POST /devices/device_shadows {device_ids}',
      });
    }

    if (keys.length > 0) {
      variants.push({
        method: 'GET',
        path: `/devices/device_shadows?device_keys=${encodeURIComponent(keys.join(','))}`,
        description: 'GET /devices/device_shadows?device_keys=',
      });
    }

    for (const variant of variants) {
      try {
        const payload = await this.requestServiceJsonWithPathFallback<unknown>(
          [variant.path],
          {
            method: variant.method,
            body: variant.body,
            auth: true,
          },
        );

        const map = parseDeviceShadows(payload, this.deviceIdToDsn, this.deviceKeyToDsn);
        if (map.size > 0) {
          return map;
        }
      } catch (error) {
        if (error instanceof HttpStatusError && STATUS_ALLOW_PATH_FALLBACK.has(error.status)) {
          if (this.verboseLogging) {
            this.log.debug(`Skipping unsupported shadow variant ${variant.description}: HTTP ${error.status}`);
          }
          continue;
        }
        if (error instanceof HttpStatusError && STATUS_ALLOW_WRITE_SHAPE_FALLBACK.has(error.status)) {
          if (this.verboseLogging) {
            this.log.debug(`Skipping incompatible shadow payload variant ${variant.description}: HTTP ${error.status}`);
          }
          continue;
        }
        if (this.verboseLogging) {
          this.log.debug(`Shadow request failed for ${variant.description}: ${asErrorMessage(error)}`);
        }
      }
    }

    return new Map();
  }

  private buildWriteAttempts(dsn: string, propertyName: string, value: unknown): WriteAttempt[] {
    const deviceId = this.findDeviceIdByDsn(dsn);
    const deviceKey = this.findDeviceKeyByDsn(dsn);
    const references: Array<{ description: string; ref: Record<string, string> }> = [
      { description: 'dsn', ref: { dsn } },
      { description: 'device_dsn', ref: { device_dsn: dsn } },
    ];
    if (deviceId) {
      references.push({ description: 'device_id', ref: { device_id: deviceId } });
      references.push({ description: 'id', ref: { id: deviceId } });
    }
    if (deviceKey) {
      references.push({ description: 'device_key', ref: { device_key: deviceKey } });
      references.push({ description: 'key', ref: { key: deviceKey } });
    }

    const attempts: WriteAttempt[] = [];

    for (const reference of references) {
      attempts.push({
        method: 'POST',
        path: '/devices/bulk',
        body: {
          devices: [
            {
              ...reference.ref,
              shadow: {
                [propertyName]: value,
              },
            },
          ],
        },
        description: `POST /devices/bulk with shadow object (${reference.description})`,
      });

      attempts.push({
        method: 'POST',
        path: '/devices/bulk',
        body: {
          devices: [
            {
              ...reference.ref,
              properties: [
                {
                  name: propertyName,
                  value,
                },
              ],
            },
          ],
        },
        description: `POST /devices/bulk with properties[] (${reference.description})`,
      });

      attempts.push({
        method: 'POST',
        path: '/devices/bulk',
        body: {
          devices: [
            {
              ...reference.ref,
              datapoints: [
                {
                  name: propertyName,
                  value,
                },
              ],
            },
          ],
        },
        description: `POST /devices/bulk with datapoints[] (${reference.description})`,
      });

      attempts.push({
        method: 'PATCH',
        path: '/devices/device_shadows',
        body: {
          ...reference.ref,
          shadow: {
            [propertyName]: value,
          },
        },
        description: `PATCH /devices/device_shadows with shadow object (${reference.description})`,
      });
    }

    attempts.push({
      method: 'POST',
      path: '/devices/device_shadows',
      body: {
        device_shadows: [
          {
            dsn,
            shadow: {
              [propertyName]: value,
            },
          },
        ],
      },
      description: 'POST /devices/device_shadows with device_shadows[]',
    });

    attempts.push({
      method: 'POST',
      path: '/devices/bulk',
      body: {
        updates: [
          {
            dsn,
            property_name: propertyName,
            value,
          },
        ],
      },
      description: 'POST /devices/bulk with updates[]',
    });

    attempts.push({
      method: 'POST',
      path: '/devices/bulk',
      body: {
        dsn,
        property_name: propertyName,
        value,
      },
      description: 'POST /devices/bulk with flat payload',
    });

    return attempts;
  }

  private findDeviceIdByDsn(dsn: string): string | undefined {
    for (const [id, mappedDsn] of this.deviceIdToDsn) {
      if (mappedDsn === dsn) {
        return id;
      }
    }
    return undefined;
  }

  private findDeviceKeyByDsn(dsn: string): string | undefined {
    for (const [key, mappedDsn] of this.deviceKeyToDsn) {
      if (mappedDsn === dsn) {
        return key;
      }
    }
    return undefined;
  }

  private updateCachedProperty(dsn: string, propertyName: string, value: unknown): void {
    let map = this.propertyCacheByDsn.get(dsn);
    if (!map) {
      map = new Map();
      this.propertyCacheByDsn.set(dsn, map);
    }

    map.set(propertyName, {
      name: propertyName,
      baseName: baseNameForProperty(propertyName),
      value,
      updatedAt: new Date().toISOString(),
      raw: {
        name: propertyName,
        value,
      },
    });
  }

  private async ensureLoggedIn(): Promise<void> {
    if (this.session && Date.now() + SESSION_REFRESH_SAFETY_MS < this.session.expiresAtEpochMs) {
      return;
    }

    if (this.session?.refreshToken) {
      try {
        await this.refreshSession();
        return;
      } catch (error) {
        this.log.warn(`Failed to refresh Salus cloud session; performing full login (${asErrorMessage(error)})`);
      }
    }

    await this.login();
  }

  private async login(): Promise<void> {
    if (this.authRequestInFlight) {
      return this.authRequestInFlight;
    }

    this.authRequestInFlight = (async () => {
      const email = this.config.email?.trim();
      const password = this.config.password;
      if (!email || !password) {
        throw new Error('Salus credentials are missing. Set email and password in plugin config.');
      }

      const payload = await this.cognitoInitiateAuth({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: this.cognitoClientId,
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
        },
      });

      const tokens = parseCognitoTokens(payload);
      if (!tokens) {
        throw new Error('Cognito login succeeded but token payload was missing AccessToken/RefreshToken.');
      }

      this.session = tokens;
      this.log.info('Authenticated with Salus cloud');
    })();

    try {
      await this.authRequestInFlight;
    } finally {
      this.authRequestInFlight = null;
    }
  }

  private async refreshSession(): Promise<void> {
    if (this.authRequestInFlight) {
      return this.authRequestInFlight;
    }

    this.authRequestInFlight = (async () => {
      const refreshToken = this.session?.refreshToken;
      if (!refreshToken) {
        this.session = null;
        await this.login();
        return;
      }

      const payload = await this.cognitoInitiateAuth({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: this.cognitoClientId,
        AuthParameters: {
          REFRESH_TOKEN: refreshToken,
        },
      });

      const refreshed = parseCognitoTokens(payload, refreshToken);
      if (!refreshed) {
        this.session = null;
        throw new Error('Cognito refresh response did not include AccessToken.');
      }

      this.session = refreshed;
      if (this.verboseLogging) {
        this.log.debug('Refreshed Salus cloud session token');
      }
    })();

    try {
      await this.authRequestInFlight;
    } finally {
      this.authRequestInFlight = null;
    }
  }

  private async cognitoInitiateAuth(body: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchWithTimeout(this.cognitoEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/x-amz-json-1.1',
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': COGNITO_INITIATE_AUTH_TARGET,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const responseBody = await safeReadText(response);
      const cognitoMessage = parseCognitoErrorMessage(responseBody);
      throw new Error(`Cognito auth failed (HTTP ${response.status}): ${cognitoMessage}`);
    }

    return await response.json() as unknown;
  }

  private async requestServiceJsonWithPathFallback<T>(paths: string[], options: RequestOptions): Promise<T> {
    let lastPathError: unknown;

    for (const path of paths) {
      try {
        return await this.requestServiceJson<T>(path, options);
      } catch (error) {
        if (error instanceof HttpStatusError && STATUS_ALLOW_PATH_FALLBACK.has(error.status)) {
          lastPathError = error;
          continue;
        }
        throw error;
      }
    }

    if (lastPathError) {
      throw lastPathError;
    }

    throw new Error(`No valid path candidates for request: ${paths.join(', ')}`);
  }

  private async requestServiceJson<T>(path: string, options: RequestOptions): Promise<T> {
    const authRequired = options.auth ?? true;
    if (authRequired) {
      await this.ensureLoggedIn();
    }

    const expectedStatuses = options.expectedStatuses ?? DEFAULT_EXPECTED_STATUSES;
    const totalAttempts = this.maxRetries + 1;

    let hasRefreshedSessionAfter401 = false;
    let lastError: unknown;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const orderedBaseUrls = this.getOrderedServiceApiBaseUrls();

      for (const baseUrl of orderedBaseUrls) {
        try {
          const headers = this.buildServiceHeaders(authRequired);
          const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
          if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
          }

          const url = buildServiceUrl(baseUrl, path, options.method === 'GET');
          const response = await this.fetchWithTimeout(url, {
            method: options.method,
            headers,
            body,
          });

          if (response.status === 401 && authRequired && (options.allow401Refresh ?? true) && !hasRefreshedSessionAfter401) {
            hasRefreshedSessionAfter401 = true;
            this.log.warn(`Salus cloud returned 401 for ${options.method} ${path}. Refreshing session token and retrying.`);
            await this.refreshSession();
            lastError = new HttpStatusError('Unauthorized', 401, '');
            continue;
          }

          if (!expectedStatuses.includes(response.status)) {
            const responseText = await safeReadText(response);
            const message = `HTTP ${response.status} ${response.statusText} on ${options.method} ${path}`;
            const statusError = new HttpStatusError(
              responseText ? `${message} :: ${responseText}` : message,
              response.status,
              responseText,
            );

            if (STATUS_ALLOW_PATH_FALLBACK.has(response.status)) {
              lastError = statusError;
              continue;
            }

            if (isRetriableStatus(response.status) && attempt < totalAttempts) {
              lastError = statusError;
              break;
            }

            throw statusError;
          }

          this.activeServiceApiBaseUrl = baseUrl;

          if (response.status === 204) {
            return undefined as T;
          }

          return await parseResponseBody<T>(response);
        } catch (error) {
          if (!this.allowInsecureTls && isTlsCertificateError(error)) {
            const message = `${asErrorMessage(error)}. If Salus cloud certificate is invalid, set "allowInsecureTls": true in plugin config.`;
            throw new Error(message);
          }

          if (error instanceof HttpStatusError) {
            lastError = error;
            continue;
          }

          if (isRetriableError(error) && attempt < totalAttempts) {
            lastError = error;
            break;
          }

          throw error;
        }
      }

      if (attempt < totalAttempts && isRetriableFailure(lastError)) {
        await this.retryDelay(attempt, asErrorMessage(lastError));
        continue;
      }

      if (lastError) {
        throw lastError;
      }
    }

    throw new Error(`Unexpected request state for ${options.method} ${path}`);
  }

  private buildServiceHeaders(authRequired: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Accept-Language': ACCEPT_LANGUAGE,
      'User-Agent': 'homebridge-salus-cloud/2026',
    };

    if (!authRequired) {
      return headers;
    }

    if (!this.session) {
      throw new Error('Missing Salus cloud session while building authenticated request.');
    }

    headers.Authorization = `Bearer ${this.session.accessToken}`;
    headers['x-access-token'] = this.session.accessToken;
    headers['x-auth-token'] = this.session.idToken || this.session.accessToken;
    if (this.companyCode) {
      headers['x-company-code'] = this.companyCode;
    }

    return headers;
  }

  private getOrderedServiceApiBaseUrls(): string[] {
    const dedupe = new Set<string>();
    const ordered: string[] = [];

    if (this.activeServiceApiBaseUrl) {
      dedupe.add(this.activeServiceApiBaseUrl);
      ordered.push(this.activeServiceApiBaseUrl);
    }

    for (const candidate of this.serviceApiBaseCandidates) {
      if (dedupe.has(candidate)) {
        continue;
      }
      dedupe.add(candidate);
      ordered.push(candidate);
    }

    return ordered;
  }

  private async retryDelay(attempt: number, reason: string): Promise<void> {
    const delayMs = this.retryBaseDelayMs * (2 ** (attempt - 1));
    this.log.warn(`Retrying Salus cloud request in ${delayMs}ms (attempt ${attempt + 1}/${this.maxRetries + 1}): ${reason}`);
    await sleep(delayMs);
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.requestTimeoutMs);
    const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    if (this.allowInsecureTls) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      if (this.allowInsecureTls) {
        if (previousTlsSetting === undefined) {
          delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        } else {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting;
        }
      }
    }
  }
}

function buildServiceApiBaseCandidates(
  region: SalusRegion | undefined,
  overrideHost: string | undefined,
  versionPreference: SalusApiVersionPreference | undefined,
): string[] {
  const normalizedOverride = normalizeNonEmptyString(overrideHost);
  if (normalizedOverride) {
    const normalizedUrl = normalizeUrl(normalizedOverride);
    if (/\/api\/v[12]$/i.test(normalizedUrl)) {
      return [normalizedUrl];
    }
    return buildApiVersionCandidates(normalizedUrl, versionPreference);
  }

  const hosts = region === 'us'
    ? [DEFAULT_US_SERVICE_API_HOST, FALLBACK_US_SERVICE_API_HOST]
    : [DEFAULT_EU_SERVICE_API_HOST, FALLBACK_EU_SERVICE_API_HOST];

  return hosts.flatMap((host) => buildApiVersionCandidates(host, versionPreference));
}

function buildApiVersionCandidates(baseHost: string, preference: SalusApiVersionPreference | undefined): string[] {
  const normalized = normalizeUrl(baseHost).replace(/\/+$/, '');

  const versions = preference === 'v1'
    ? ['v1', 'v2']
    : preference === 'v2'
      ? ['v2', 'v1']
      : ['v1', 'v2'];

  return versions.map((version) => `${normalized}/api/${version}`);
}

function buildServiceUrl(baseUrl: string, path: string, addTimestamp: boolean): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const joined = `${baseUrl}${normalizedPath}`;
  return addTimestamp ? withTimestampQuery(joined) : joined;
}

function withTimestampQuery(url: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}timestamp=${Date.now()}`;
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function normalizeNonEmptyString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}

function parseCognitoTokens(payload: unknown, refreshTokenFallback?: string): CognitoSession | undefined {
  const record = asRecord(payload);
  if (!record) {
    return undefined;
  }

  const challengeName = asString(record.ChallengeName);
  if (challengeName) {
    throw new Error(`Cognito challenge flow is not supported by this plugin: ${challengeName}`);
  }

  const authResult = asRecord(record.AuthenticationResult);
  if (!authResult) {
    return undefined;
  }

  const accessToken = asString(authResult.AccessToken);
  const idToken = asString(authResult.IdToken) ?? accessToken;
  const refreshToken = asString(authResult.RefreshToken) ?? refreshTokenFallback;
  const tokenType = asString(authResult.TokenType) ?? 'Bearer';

  const expiresInRaw = parseNumberLike(authResult.ExpiresIn);
  const expiresInSeconds = expiresInRaw && Number.isFinite(expiresInRaw) ? Math.max(60, Math.floor(expiresInRaw)) : 3600;

  if (!accessToken || !idToken || !refreshToken) {
    return undefined;
  }

  return {
    accessToken,
    idToken,
    refreshToken,
    tokenType,
    expiresAtEpochMs: Date.now() + (expiresInSeconds * 1_000),
  };
}

function parseCognitoErrorMessage(responseBody: string): string {
  const trimmed = responseBody.trim();
  if (!trimmed) {
    return 'Unknown Cognito error';
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const directMessage = asString(parsed.message) ?? asString(parsed.Message);
    if (directMessage) {
      return directMessage;
    }

    const type = asString(parsed.__type) ?? asString(parsed.code);
    if (type) {
      return type;
    }

    return trimmed;
  } catch {
    return trimmed;
  }
}

function parseDevices(payload: unknown): SalusDevice[] {
  const root = asRecord(payload);
  const candidates: unknown[][] = [];

  if (Array.isArray(payload)) {
    candidates.push(payload);
  }

  if (root) {
    const arrayKeys = ['devices', 'registered_nodes', 'nodes', 'results', 'data', 'list', 'device_list'];
    for (const key of arrayKeys) {
      const arr = asArray(root[key]);
      if (arr) {
        candidates.push(arr);
      }
    }

    // Some payloads return an object map keyed by device identifiers.
    const mappedDevices = asRecord(root.devices);
    if (mappedDevices) {
      const values = Object.values(mappedDevices);
      if (values.length > 0) {
        candidates.push(values);
      }
    }
  }

  const selected = candidates.find((candidate) => candidate.length > 0) ?? [];
  const result: SalusDevice[] = [];

  for (const item of selected) {
    const rawItem = asRecord(item);
    const deviceWrapper = rawItem?.device;
    const normalized = asRecord(deviceWrapper) ?? rawItem;
    if (!normalized) {
      continue;
    }

    const dsn = asString(normalized.dsn)
      ?? asString(normalized.device_dsn)
      ?? asString(normalized.DSN);
    if (!dsn) {
      continue;
    }

    const key = asString(normalized.key) ?? asString(normalized.device_key);
    const id = asString(normalized.id)
      ?? asString(normalized.device_id)
      ?? key
      ?? dsn;

    const modelRaw = asString(normalized.oem_model)
      ?? asString(normalized.model)
      ?? asString(normalized.product_class)
      ?? asString(normalized.device_model)
      ?? '';

    const model = normalizeModelName(modelRaw);
    const displayName = deriveDeviceDisplayName(normalized, dsn, model);
    const online = deriveOnlineState(normalized);

    result.push({
      id,
      dsn,
      key,
      model,
      name: displayName,
      productName: asString(normalized.product_name),
      online,
      raw: normalized,
    });
  }

  return dedupeDevicesByDsn(result);
}

function parseDeviceShadows(
  payload: unknown,
  deviceIdToDsn: Map<string, string>,
  deviceKeyToDsn: Map<string, string>,
): Map<string, SalusPropertyMap> {
  const output: Map<string, SalusPropertyMap> = new Map();
  const queue: unknown[] = [payload];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') {
      continue;
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (Array.isArray(current)) {
      for (const entry of current) {
        queue.push(entry);
      }
      continue;
    }

    const record = current as Record<string, unknown>;
    const dsn = inferShadowDsn(record, deviceIdToDsn, deviceKeyToDsn);

    if (dsn) {
      const propertyCandidates = [
        record.shadow,
        record.device_shadow,
        record.properties,
        record.property_values,
        record.datapoints,
        record.reported,
        record.desired,
        record.state,
        record.attrs,
      ];

      const merged = new Map<string, SalusProperty>();
      for (const candidate of propertyCandidates) {
        const parsed = parseProperties(candidate);
        mergePropertyMaps(merged, parsed);
      }

      if (merged.size === 0) {
        // Some payloads provide a flat object map directly on device record.
        const parsedFromRecord = parseProperties(record);
        mergePropertyMaps(merged, parsedFromRecord);
      }

      if (merged.size > 0) {
        const existing = output.get(dsn);
        if (existing) {
          mergePropertyMaps(existing, merged);
        } else {
          output.set(dsn, merged);
        }
      }
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return output;
}

function inferShadowDsn(
  record: Record<string, unknown>,
  deviceIdToDsn: Map<string, string>,
  deviceKeyToDsn: Map<string, string>,
): string | undefined {
  const direct = asString(record.dsn)
    ?? asString(record.device_dsn)
    ?? asString(record.DSN);
  if (direct) {
    return direct;
  }

  const byId = asString(record.id)
    ?? asString(record.device_id)
    ?? asString(record.node_id);
  if (byId) {
    const found = deviceIdToDsn.get(byId);
    if (found) {
      return found;
    }
  }

  const byKey = asString(record.key)
    ?? asString(record.device_key)
    ?? asString(record.unique_hardware_id);
  if (byKey) {
    const found = deviceKeyToDsn.get(byKey);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function parseProperties(payload: unknown): SalusPropertyMap {
  const result: SalusPropertyMap = new Map();

  const root = asRecord(payload);
  const candidateArrays: unknown[][] = [];

  if (Array.isArray(payload)) {
    candidateArrays.push(payload);
  }

  if (root) {
    const keys = ['properties', 'property', 'data', 'results', 'datapoints', 'list'];
    for (const key of keys) {
      const maybeArray = asArray(root[key]);
      if (maybeArray) {
        candidateArrays.push(maybeArray);
      }
    }
  }

  for (const entries of candidateArrays) {
    for (const entry of entries) {
      const property = parsePropertyEntry(entry);
      if (property) {
        result.set(property.name, property);
      }
    }
  }

  if (root) {
    parsePropertyObjectMap(root, result);
  }

  return result;
}

function parsePropertyObjectMap(record: Record<string, unknown>, output: SalusPropertyMap): void {
  for (const [name, rawValue] of Object.entries(record)) {
    if (METADATA_FIELD_NAMES.has(name)) {
      continue;
    }

    const extracted = extractPropertyValue(rawValue);
    if (extracted === undefined) {
      continue;
    }

    if (!looksLikePropertyName(name, rawValue)) {
      continue;
    }

    output.set(name, {
      name,
      baseName: baseNameForProperty(name),
      value: extracted,
      updatedAt: extractPropertyTimestamp(rawValue),
      raw: asRecord(rawValue) ?? { value: rawValue },
    });
  }
}

function parsePropertyEntry(entry: unknown): SalusProperty | undefined {
  const asRoot = asRecord(entry);
  if (!asRoot) {
    return undefined;
  }

  const node = asRecord(asRoot.property) ?? asRoot;
  const name = asString(node.name)
    ?? asString(node.property_name)
    ?? asString(node.key);
  if (!name) {
    return undefined;
  }

  const datapoint = asRecord(node.datapoint);
  const lastDatapoint = asRecord(node.last_datapoint);

  const value = node.value
    ?? datapoint?.value
    ?? lastDatapoint?.value
    ?? node.current_value
    ?? extractPropertyValue(node);

  if (value === undefined) {
    return undefined;
  }

  const updatedAt = asString(node.updated_at)
    ?? asString(node.updatedAt)
    ?? asString(datapoint?.created_at)
    ?? asString(lastDatapoint?.created_at)
    ?? extractPropertyTimestamp(node);

  return {
    name,
    baseName: baseNameForProperty(name),
    value,
    updatedAt,
    raw: node,
  };
}

function extractPropertyValue(rawValue: unknown): unknown | undefined {
  if (rawValue === null) {
    return null;
  }

  if (typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean') {
    return rawValue;
  }

  const record = asRecord(rawValue);
  if (!record) {
    return undefined;
  }

  if ('value' in record) {
    return record.value;
  }

  if ('current_value' in record) {
    return record.current_value;
  }

  if ('reported' in record) {
    const reported = record.reported;
    if (typeof reported === 'string' || typeof reported === 'number' || typeof reported === 'boolean' || reported === null) {
      return reported;
    }
    const nestedReported = asRecord(reported);
    if (nestedReported && 'value' in nestedReported) {
      return nestedReported.value;
    }
  }

  if ('desired' in record) {
    const desired = record.desired;
    if (typeof desired === 'string' || typeof desired === 'number' || typeof desired === 'boolean' || desired === null) {
      return desired;
    }
    const nestedDesired = asRecord(desired);
    if (nestedDesired && 'value' in nestedDesired) {
      return nestedDesired.value;
    }
  }

  if ('datapoint' in record) {
    const datapoint = asRecord(record.datapoint);
    if (datapoint && 'value' in datapoint) {
      return datapoint.value;
    }
  }

  if ('last_datapoint' in record) {
    const datapoint = asRecord(record.last_datapoint);
    if (datapoint && 'value' in datapoint) {
      return datapoint.value;
    }
  }

  return undefined;
}

function extractPropertyTimestamp(rawValue: unknown): string | undefined {
  const record = asRecord(rawValue);
  if (!record) {
    return undefined;
  }

  return asString(record.updated_at)
    ?? asString(record.updatedAt)
    ?? asString(record.created_at)
    ?? asString(record.timestamp);
}

function looksLikePropertyName(name: string, rawValue: unknown): boolean {
  if (name.includes(':')) {
    return true;
  }

  if (/^[A-Za-z][A-Za-z0-9_]+$/.test(name) && /[A-Z_]/.test(name)) {
    return true;
  }

  const extracted = extractPropertyValue(rawValue);
  if (typeof extracted === 'number' || typeof extracted === 'boolean') {
    return true;
  }

  if (typeof extracted === 'string') {
    if (parseBooleanLike(extracted) !== undefined) {
      return true;
    }
    if (parseNumberLike(extracted) !== undefined) {
      return true;
    }
  }

  return false;
}

function deriveDeviceDisplayName(record: Record<string, unknown>, dsn: string, model: string): string {
  const candidates = [
    asString(record.product_name),
    asString(record.device_name),
    asString(record.name),
    asString(record.unique_hardware_id),
    asString(record.oem_model),
  ];

  for (const candidate of candidates) {
    if (!candidate || candidate.trim() === '') {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const parsedName = asString(parsed.deviceName);
        if (parsedName) {
          return parsedName.trim().replaceAll('/', ' ');
        }
      } catch {
        // Preserve raw candidate.
      }
    }

    return trimmed.replaceAll('/', ' ');
  }

  return model || dsn;
}

function deriveOnlineState(record: Record<string, unknown>): boolean | undefined {
  const boolFields = ['online', 'is_online', 'connected', 'reachable'];
  for (const field of boolFields) {
    const parsed = parseBooleanLike(record[field]);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  const status = asString(record.connection_status) ?? asString(record.status);
  if (!status) {
    return undefined;
  }

  const normalized = status.trim().toLowerCase();
  if (normalized.includes('online') || normalized.includes('connected')) {
    return true;
  }
  if (normalized.includes('offline') || normalized.includes('disconnected')) {
    return false;
  }

  return undefined;
}

function dedupeDevicesByDsn(devices: SalusDevice[]): SalusDevice[] {
  const byDsn = new Map<string, SalusDevice>();
  for (const device of devices) {
    byDsn.set(device.dsn, device);
  }
  return [...byDsn.values()];
}

function mergePropertyMaps(target: SalusPropertyMap, source: SalusPropertyMap): void {
  for (const [name, property] of source) {
    target.set(name, property);
  }
}

function isRetriableFailure(error: unknown): boolean {
  if (error instanceof HttpStatusError) {
    return isRetriableStatus(error.status);
  }
  return isRetriableError(error);
}

function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetriableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes('timed out')
    || message.includes('network')
    || message.includes('fetch failed')
    || message.includes('aborted')
    || message.includes('ecconnreset')
    || message.includes('eai_again')
    || message.includes('enotfound')
    || message.includes('socket hang up');
}

function isTlsCertificateError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = getErrorCauseCode(error);
  return code === 'CERT_HAS_EXPIRED'
    || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    || code === 'SELF_SIGNED_CERT_IN_CHAIN'
    || code === 'ERR_TLS_CERT_ALTNAME_INVALID';
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getErrorCauseCode(error: Error): string | undefined {
  const cause = error.cause as Record<string, unknown> | undefined;
  const code = cause?.code;
  if (typeof code === 'string') {
    return code;
  }
  return undefined;
}

async function parseResponseBody<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json') || contentType.includes('application/x-amz-json-1.1')) {
    return await response.json() as T;
  }

  const text = await response.text();
  if (!text) {
    return undefined as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
