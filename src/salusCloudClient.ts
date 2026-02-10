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
  companyCode?: string;
}

interface LegacySession {
  accessToken: string;
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

type CompanyCodeCandidate = string | null;
type ApiTransportMode = 'modern' | 'legacy';

class HttpStatusError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody: string,
  ) {
    super(message);
  }
}

class LegacyFallbackRequiredError extends Error {
  constructor(message: string) {
    super(message);
  }
}

class OccupantsDiscoveryEmptyError extends Error {
  constructor(message: string) {
    super(message);
  }
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 750;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_PREFERRED_WRITE_CACHE_SIZE = 2_000;
const DEFAULT_COGNITO_REGION = 'eu-central-1';
const DEFAULT_COGNITO_CLIENT_ID = '4pk5efh3v84g5dav43imsv4fbj';
const DEFAULT_EU_SERVICE_API_HOST = 'https://service-api.eu.premium.salusconnect.io';
const DEFAULT_US_SERVICE_API_HOST = 'https://service-api.us.premium.salusconnect.io';
const FALLBACK_US_SERVICE_API_HOST = 'https://service-api.us.salusconnect.io';
const FALLBACK_EU_SERVICE_API_HOST = 'https://service-api.eu.salusconnect.io';
const DEFAULT_EU_LEGACY_API_HOST = 'https://eu.premium.salusconnect.io';
const DEFAULT_US_LEGACY_API_HOST = 'https://us.premium.salusconnect.io';
const FALLBACK_US_LEGACY_API_HOST = 'https://us.salusconnect.io';
const FALLBACK_EU_LEGACY_API_HOST = 'https://eu.salusconnect.io';

const COGNITO_INITIATE_AUTH_TARGET = 'AWSCognitoIdentityProviderService.InitiateAuth';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9,en;q=0.8';
const SESSION_REFRESH_SAFETY_MS = 60_000;
const LEGACY_SESSION_REFRESH_SAFETY_MS = 60_000;
const LEGACY_DEFAULT_SESSION_TTL_MS = 45 * 60_000;
const MAX_UNAUTHORIZED_RECOVERY_STEPS = 48;

const STATUS_ALLOW_PATH_FALLBACK = new Set([404, 405, 426]);
const STATUS_ALLOW_WRITE_SHAPE_FALLBACK = new Set([400, 404, 405, 409, 415, 422]);
const DEFAULT_EXPECTED_STATUSES = [200, 201, 202, 204];
const RETRIABLE_ERROR_CODES = new Set([
  'ABORT_ERR',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const DEFAULT_COMPANY_CODE_FALLBACKS = [
  'salus-eu',
  'salus-us',
  'salus',
  'salus_eu',
  'salus_us',
  'heatlink_us',
  'mrpex_us',
  'neotherm_eu',
  'omnie_eu',
  'purmo',
  'clp_sg',
  'clp',
  'SALUS_EU',
  'SALUS_US',
  'SALUS',
  'HEATLINK_US',
  'MRPEX_US',
  'NEOTHERM_EU',
  'OMNIE_EU',
  'PURMO',
  'CLP_SG',
  'CLP',
  'HEATLINK',
  'MRPEX',
  'NEOTHERM',
  'OMNIE',
];
const LEGACY_LOGIN_PATH_CANDIDATES = [
  '/users/sign_in.json',
  '/users/sign_in',
  '/api/v1/users/sign_in.json',
  '/api/v1/users/sign_in',
  '/apiv1/users/sign_in.json',
  '/apiv1/users/sign_in',
];
const NO_COMPANY_CODE_SENTINEL = '__none__';

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
  'value',
  'gateway',
  'gateway_id',
  'user_id',
  'occupant_id',
]);

export class SalusCloudClient {
  private session: CognitoSession | null = null;
  private authRequestInFlight: Promise<void> | null = null;
  private legacySession: LegacySession | null = null;
  private legacyAuthRequestInFlight: Promise<void> | null = null;

  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly verboseLogging: boolean;
  private readonly allowInsecureTls: boolean;

  private readonly serviceApiBaseCandidates: string[];
  private readonly legacyApiBaseCandidates: string[];
  private readonly cognitoEndpoint: string;
  private readonly cognitoClientId: string;
  private readonly configuredCompanyCode: string | null;
  private companyCodeCandidates: CompanyCodeCandidate[] = [];
  private activeCompanyCode: CompanyCodeCandidate = null;
  private hasWarnedAboutAuthCompanyCode = false;

  private activeServiceApiBaseUrl: string | null = null;
  private activeLegacyApiBaseUrl: string | null = null;
  private apiTransportMode: ApiTransportMode = 'modern';
  private hasWarnedAboutLegacyFallback = false;

  private readonly propertyCacheByDsn: Map<string, SalusPropertyMap> = new Map();
  private readonly deviceIdToDsn: Map<string, string> = new Map();
  private readonly deviceKeyToDsn: Map<string, string> = new Map();
  private preferredShadowVariantDescription: string | null = null;
  private readonly preferredWriteAttemptByKey: Map<string, string> = new Map();
  private insecureTlsInFlight = 0;
  private insecureTlsPreviousValue: string | undefined;
  private insecureTlsHadPreviousValue = false;

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
    this.legacyApiBaseCandidates = buildLegacyApiBaseCandidates(
      config.region,
      config.apiHost,
    );

    const cognitoRegion = normalizeNonEmptyString(config.cognitoRegion) ?? DEFAULT_COGNITO_REGION;
    this.cognitoClientId = normalizeNonEmptyString(config.cognitoClientId) ?? DEFAULT_COGNITO_CLIENT_ID;
    this.cognitoEndpoint = `https://cognito-idp.${cognitoRegion}.amazonaws.com/`;
    this.configuredCompanyCode = normalizeNonEmptyString(config.companyCode) ?? null;
    this.refreshCompanyCodeCandidates();

    if (this.allowInsecureTls) {
      this.log.warn('TLS certificate validation is disabled for Salus cloud requests (allowInsecureTls=true).');
    }
    if (this.verboseLogging) {
      this.log.debug(`Salus service-api candidates: ${this.serviceApiBaseCandidates.join(', ')}`);
      this.log.debug(`Salus legacy-api candidates: ${this.legacyApiBaseCandidates.join(', ')}`);
      this.log.debug(`Salus Cognito endpoint: ${this.cognitoEndpoint}`);
      this.log.debug(`Salus company-code candidates: ${this.companyCodeCandidates.map((candidate) => candidate ?? '<none>').join(', ')}`);
    }
  }

  public getCloudBaseUrl(): string {
    if (this.apiTransportMode === 'legacy') {
      return this.activeLegacyApiBaseUrl ?? this.legacyApiBaseCandidates[0]!;
    }
    return this.activeServiceApiBaseUrl ?? this.serviceApiBaseCandidates[0]!;
  }

  public async listDevices(): Promise<SalusDevice[]> {
    if (this.apiTransportMode === 'legacy') {
      return await this.listDevicesLegacy();
    }

    try {
      return await this.listDevicesModern();
    } catch (error) {
      if (!shouldSwitchToLegacyApi(error)) {
        throw error;
      }

      this.switchToLegacyTransport(`Modern Salus API authorization failed: ${asErrorMessage(error)}`);
      return await this.listDevicesLegacy();
    }
  }

  private async listDevicesModern(): Promise<SalusDevice[]> {
    let lastError: unknown;

    try {
      return await this.listDevicesViaOccupantsEndpoints();
    } catch (error) {
      lastError = error;
      if (!shouldTryAlternateDiscovery(error)) {
        throw error;
      }
      this.log.warn(`AWS occupants discovery failed. Falling back to /devices endpoint (${asErrorMessage(error)})`);
    }

    try {
      return await this.listDevicesViaDevicesEndpoint();
    } catch (error) {
      if (this.verboseLogging) {
        this.log.debug(`Fallback /devices discovery failed: ${asErrorMessage(error)}`);
      }
      throw error ?? lastError;
    }
  }

  private async listDevicesViaDevicesEndpoint(): Promise<SalusDevice[]> {
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
      this.log.debug(`Salus cloud returned ${devices.length} device(s) from /devices endpoint`);
    }

    return devices;
  }

  private async listDevicesViaOccupantsEndpoints(): Promise<SalusDevice[]> {
    const gatewayListPayload = await this.requestServiceJsonWithPathFallback<unknown>(
      ['/occupants/slider_list', '/api/v1/occupants/slider_list'],
      {
        method: 'GET',
        auth: true,
      },
    );

    const gatewayIds = parseGatewayIdsFromOccupantsPayload(gatewayListPayload);
    const mergedShadows: Map<string, SalusPropertyMap> = new Map();
    const discoveredDevices: SalusDevice[] = [];

    if (gatewayIds.length > 0) {
      for (const gatewayId of gatewayIds) {
        const detailsPayload = await this.requestServiceJsonWithPathFallback<unknown>(
          [
            `/occupants/slider_details?id=${encodeURIComponent(gatewayId)}&type=gateway`,
            `/api/v1/occupants/slider_details?id=${encodeURIComponent(gatewayId)}&type=gateway`,
          ],
          {
            method: 'GET',
            auth: true,
          },
        );

        discoveredDevices.push(...parseDevices(detailsPayload));
        const detailShadows = parseDeviceShadows(detailsPayload, this.deviceIdToDsn, this.deviceKeyToDsn);
        for (const [dsn, properties] of detailShadows) {
          const existing = mergedShadows.get(dsn);
          if (existing) {
            mergePropertyMaps(existing, properties);
          } else {
            mergedShadows.set(dsn, properties);
          }
        }
      }
    } else {
      discoveredDevices.push(...parseDevices(gatewayListPayload));
      const listShadows = parseDeviceShadows(gatewayListPayload, this.deviceIdToDsn, this.deviceKeyToDsn);
      for (const [dsn, properties] of listShadows) {
        mergedShadows.set(dsn, properties);
      }
    }

    const devices = dedupeDevicesByDsn(discoveredDevices);
    if (devices.length === 0) {
      throw new OccupantsDiscoveryEmptyError('Occupants discovery returned no devices.');
    }
    this.rebuildDeviceIndex(devices);

    if (mergedShadows.size > 0) {
      this.mergeIntoPropertyCache(mergedShadows);
      if (this.verboseLogging) {
        this.log.debug(`Hydrated property cache from occupants payload for ${mergedShadows.size} device(s)`);
      }
    }

    try {
      const shadowPayload = await this.fetchDeviceShadows(devices);
      if (shadowPayload.size > 0) {
        this.mergeIntoPropertyCache(shadowPayload);
        if (this.verboseLogging) {
          this.log.debug(`Hydrated property cache from devices/device_shadows for ${shadowPayload.size} device(s)`);
        }
      } else if (devices.length > 0 && mergedShadows.size === 0) {
        this.log.warn('No property payload was returned by devices/device_shadows. Accessory states may stay stale until Salus API responds.');
      }
    } catch (error) {
      if (shouldTryAlternateDiscovery(error)) {
        this.log.warn(`Device shadow query failed after occupants discovery (${asErrorMessage(error)}). Continuing with available data.`);
      } else {
        throw error;
      }
    }

    if (this.verboseLogging) {
      this.log.debug(`Salus cloud returned ${devices.length} device(s) from occupants endpoints`);
    }

    return devices;
  }

  private async listDevicesLegacy(): Promise<SalusDevice[]> {
    const payload = await this.requestLegacyJsonWithPathFallback<unknown>(
      ['/apiv1/devices.json', '/apiv1/devices', '/apiv1/registered_nodes.json'],
      {
        method: 'GET',
        auth: true,
      },
    );

    const devices = parseDevices(payload);
    this.rebuildDeviceIndex(devices);

    const inlineShadows = parseDeviceShadows(payload, this.deviceIdToDsn, this.deviceKeyToDsn);
    if (inlineShadows.size > 0) {
      this.mergeIntoPropertyCache(inlineShadows);
      if (this.verboseLogging) {
        this.log.debug(`Hydrated property cache from legacy /apiv1/devices response for ${inlineShadows.size} device(s)`);
      }
    }

    if (this.verboseLogging) {
      this.log.debug(`Salus legacy cloud returned ${devices.length} device(s)`);
    }

    return devices;
  }

  public async listProperties(dsn: string): Promise<SalusPropertyMap> {
    const cached = this.propertyCacheByDsn.get(dsn);
    if (cached) {
      return cached;
    }

    if (this.apiTransportMode === 'legacy') {
      return await this.listPropertiesLegacy(dsn);
    }

    try {
      return await this.listPropertiesModern(dsn);
    } catch (error) {
      if (!shouldSwitchToLegacyApi(error)) {
        throw error;
      }

      this.switchToLegacyTransport(`Modern Salus property sync failed for ${dsn}: ${asErrorMessage(error)}`);
      return await this.listPropertiesLegacy(dsn);
    }
  }

  private async listPropertiesModern(dsn: string): Promise<SalusPropertyMap> {
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

  private async listPropertiesLegacy(dsn: string): Promise<SalusPropertyMap> {
    const encodedDsn = encodeURIComponent(dsn);
    const payload = await this.requestLegacyJsonWithPathFallback<unknown>(
      [
        `/apiv1/dsns/${encodedDsn}/properties.json`,
        `/apiv1/dsns/${encodedDsn}/properties`,
      ],
      {
        method: 'GET',
        auth: true,
      },
    );

    const parsed = parseProperties(payload);
    if (parsed.size > 0) {
      this.propertyCacheByDsn.set(dsn, parsed);
      return parsed;
    }

    if (this.verboseLogging) {
      this.log.debug(`No legacy cloud property payload found for dsn=${dsn}. Returning empty property map.`);
    }

    return new Map();
  }

  public async setDatapoint(dsn: string, propertyName: string, value: unknown): Promise<void> {
    if (this.apiTransportMode === 'legacy') {
      await this.setDatapointLegacy(dsn, propertyName, value);
      return;
    }

    try {
      await this.setDatapointModern(dsn, propertyName, value);
      return;
    } catch (error) {
      if (!shouldSwitchToLegacyApi(error)) {
        throw error;
      }

      this.switchToLegacyTransport(`Modern Salus datapoint write failed for ${dsn}/${propertyName}: ${asErrorMessage(error)}`);
      await this.setDatapointLegacy(dsn, propertyName, value);
    }
  }

  private async setDatapointModern(dsn: string, propertyName: string, value: unknown): Promise<void> {
    const writeCacheKey = `${dsn}:${propertyName}`;
    const preferredAttempt = this.preferredWriteAttemptByKey.get(writeCacheKey) ?? null;
    const attempts = prioritizeByDescription(this.buildWriteAttempts(dsn, propertyName, value), preferredAttempt);
    const failures: string[] = [];
    let fatalError: unknown;

    for (const attempt of attempts) {
      try {
        await this.requestServiceJson(attempt.path, {
          method: attempt.method,
          body: attempt.body,
          auth: true,
          expectedStatuses: DEFAULT_EXPECTED_STATUSES,
        });

        this.updateCachedProperty(dsn, propertyName, value);
        this.rememberPreferredWriteAttempt(writeCacheKey, attempt.description);
        if (this.verboseLogging) {
          this.log.debug(`Write succeeded via ${attempt.description}`);
        }
        return;
      } catch (error) {
        const failureMessage = error instanceof HttpStatusError
          ? `${attempt.description} -> HTTP ${error.status}`
          : `${attempt.description} -> ${asErrorMessage(error)}`;
        failures.push(failureMessage);

        if (error instanceof HttpStatusError && STATUS_ALLOW_WRITE_SHAPE_FALLBACK.has(error.status)) {
          continue;
        }
        if (error instanceof HttpStatusError && STATUS_ALLOW_PATH_FALLBACK.has(error.status)) {
          continue;
        }
        if (isRetriableFailure(error)) {
          fatalError = error;
          break;
        }
        fatalError = error;
        break;
      }
    }

    if (fatalError) {
      throw new Error(
        `Failed to write property ${propertyName} on ${dsn}. Fatal error: ${asErrorMessage(fatalError)}. Attempts: ${failures.join(' | ')}`,
      );
    }
    throw new Error(`Failed to write property ${propertyName} on ${dsn}. Attempts: ${failures.join(' | ')}`);
  }

  private async setDatapointLegacy(dsn: string, propertyName: string, value: unknown): Promise<void> {
    const encodedDsn = encodeURIComponent(dsn);
    const encodedPropertyName = encodeURIComponent(propertyName);

    const attempts: WriteAttempt[] = [
      {
        method: 'POST',
        path: `/apiv1/dsns/${encodedDsn}/properties/${encodedPropertyName}/datapoints.json`,
        body: {
          datapoint: {
            value,
          },
        },
        description: 'POST /apiv1/dsns/{dsn}/properties/{property}/datapoints.json {datapoint:{value}}',
      },
      {
        method: 'POST',
        path: `/apiv1/dsns/${encodedDsn}/properties/${encodedPropertyName}/datapoints`,
        body: {
          datapoint: {
            value,
          },
        },
        description: 'POST /apiv1/dsns/{dsn}/properties/{property}/datapoints {datapoint:{value}}',
      },
      {
        method: 'PUT',
        path: `/apiv1/dsns/${encodedDsn}/properties/${encodedPropertyName}/datapoints.json`,
        body: {
          datapoint: {
            value,
          },
        },
        description: 'PUT /apiv1/dsns/{dsn}/properties/{property}/datapoints.json {datapoint:{value}}',
      },
      {
        method: 'POST',
        path: `/apiv1/dsns/${encodedDsn}/properties/${encodedPropertyName}/datapoints.json`,
        body: {
          value,
        },
        description: 'POST /apiv1/dsns/{dsn}/properties/{property}/datapoints.json {value}',
      },
    ];

    const failures: string[] = [];
    let fatalError: unknown;

    for (const attempt of attempts) {
      try {
        await this.requestLegacyJson(attempt.path, {
          method: attempt.method,
          body: attempt.body,
          auth: true,
          expectedStatuses: DEFAULT_EXPECTED_STATUSES,
        });

        this.updateCachedProperty(dsn, propertyName, value);
        if (this.verboseLogging) {
          this.log.debug(`Legacy write succeeded via ${attempt.description}`);
        }
        return;
      } catch (error) {
        const failureMessage = error instanceof HttpStatusError
          ? `${attempt.description} -> HTTP ${error.status}`
          : `${attempt.description} -> ${asErrorMessage(error)}`;
        failures.push(failureMessage);

        if (error instanceof HttpStatusError && STATUS_ALLOW_WRITE_SHAPE_FALLBACK.has(error.status)) {
          continue;
        }
        if (error instanceof HttpStatusError && STATUS_ALLOW_PATH_FALLBACK.has(error.status)) {
          continue;
        }

        fatalError = error;
        break;
      }
    }

    if (fatalError) {
      throw new Error(
        `Failed to write property ${propertyName} on ${dsn} via legacy API. Fatal error: ${asErrorMessage(fatalError)}. Attempts: ${failures.join(' | ')}`,
      );
    }
    throw new Error(`Failed to write property ${propertyName} on ${dsn} via legacy API. Attempts: ${failures.join(' | ')}`);
  }

  private switchToLegacyTransport(reason: string): void {
    if (this.apiTransportMode === 'legacy') {
      return;
    }

    this.apiTransportMode = 'legacy';
    this.activeServiceApiBaseUrl = null;
    this.session = null;
    this.authRequestInFlight = null;
    this.hasWarnedAboutAuthCompanyCode = false;

    if (!this.hasWarnedAboutLegacyFallback) {
      this.hasWarnedAboutLegacyFallback = true;
      this.log.warn(`Switching to legacy Salus cloud compatibility mode (${reason})`);
      this.log.warn('Legacy mode probes multiple legacy sign-in paths and /apiv1 endpoints for tenant compatibility.');
    }
  }

  private rememberPreferredWriteAttempt(cacheKey: string, description: string): void {
    this.preferredWriteAttemptByKey.delete(cacheKey);
    this.preferredWriteAttemptByKey.set(cacheKey, description);

    while (this.preferredWriteAttemptByKey.size > MAX_PREFERRED_WRITE_CACHE_SIZE) {
      const oldestKey = this.preferredWriteAttemptByKey.keys().next().value;
      if (!oldestKey) {
        return;
      }
      this.preferredWriteAttemptByKey.delete(oldestKey);
    }
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
    const keys = [...new Set(devices.map((device) => device.key).filter((value): value is string => Boolean(value && value.trim() !== '')))];

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

    const orderedVariants = prioritizeByDescription(variants, this.preferredShadowVariantDescription);
    let lastRecoverableError: unknown;

    for (const variant of orderedVariants) {
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
          this.preferredShadowVariantDescription = variant.description;
          return map;
        }

        if (this.verboseLogging) {
          this.log.debug(`Shadow variant ${variant.description} returned no device properties.`);
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
        if (isRetriableFailure(error)) {
          lastRecoverableError = error;
          if (this.verboseLogging) {
            this.log.debug(`Retryable shadow request failure for ${variant.description}: ${asErrorMessage(error)}`);
          }
          continue;
        }
        if (this.verboseLogging) {
          this.log.debug(`Fatal shadow request failure for ${variant.description}: ${asErrorMessage(error)}`);
        }
        throw error;
      }
    }

    if (lastRecoverableError) {
      throw new Error(`Unable to fetch Salus device shadows: ${asErrorMessage(lastRecoverableError)}`);
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

  private refreshCompanyCodeCandidates(): void {
    const candidates = buildCompanyCodeCandidates(
      this.configuredCompanyCode,
      this.session?.companyCode,
      this.config.region,
    );
    this.companyCodeCandidates = candidates;

    if (this.activeCompanyCode && candidates.includes(this.activeCompanyCode)) {
      return;
    }

    this.activeCompanyCode = candidates[0] ?? null;
  }

  private rotateCompanyCodeCandidate(
    attemptedCompanyCodes: Set<string>,
    preferredCode: string | undefined,
  ): CompanyCodeCandidate {
    if (preferredCode) {
      const normalizedPreferred = normalizeNonEmptyString(preferredCode);
      if (normalizedPreferred) {
        const preferredKey = companyCodeCandidateKey(normalizedPreferred);
        if (!attemptedCompanyCodes.has(preferredKey)) {
          attemptedCompanyCodes.add(preferredKey);
          this.activeCompanyCode = normalizedPreferred;
          return normalizedPreferred;
        }
      }
    }

    for (const candidate of this.companyCodeCandidates) {
      const key = companyCodeCandidateKey(candidate);
      if (attemptedCompanyCodes.has(key)) {
        continue;
      }

      attemptedCompanyCodes.add(key);
      this.activeCompanyCode = candidate;
      return candidate;
    }

    // No candidate remains; explicitly clear active code so callers can detect
    // that no further company-code rotation is possible.
    this.activeCompanyCode = null;
    return null;
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
      this.session = null;
      this.session = await this.authenticateWithPassword();
      this.refreshCompanyCodeCandidates();
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
        this.session = await this.authenticateWithPassword();
        this.refreshCompanyCodeCandidates();
        this.log.info('Authenticated with Salus cloud');
        return;
      }

      try {
        this.session = await this.authenticateWithRefreshToken(refreshToken);
        this.refreshCompanyCodeCandidates();
      } catch (error) {
        this.session = null;
        throw error;
      }
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

  private async ensureLegacyLoggedIn(): Promise<void> {
    if (this.legacySession && Date.now() + LEGACY_SESSION_REFRESH_SAFETY_MS < this.legacySession.expiresAtEpochMs) {
      return;
    }

    await this.loginLegacy();
  }

  private async loginLegacy(): Promise<void> {
    if (this.legacyAuthRequestInFlight) {
      return this.legacyAuthRequestInFlight;
    }

    this.legacyAuthRequestInFlight = (async () => {
      this.legacySession = await this.authenticateLegacyWithPassword();
      this.log.info('Authenticated with Salus cloud (legacy API compatibility mode)');
    })();

    try {
      await this.legacyAuthRequestInFlight;
    } finally {
      this.legacyAuthRequestInFlight = null;
    }
  }

  private async authenticateLegacyWithPassword(): Promise<LegacySession> {
    const email = this.config.email?.trim();
    const password = this.config.password;
    if (!email || !password) {
      throw new Error('Salus credentials are missing. Set email and password in plugin config.');
    }

    const loginVariants: Array<{
      description: string;
      headers: Record<string, string>;
      body: string;
    }> = [
      {
        description: 'JSON payload with nested user object',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Accept-Language': ACCEPT_LANGUAGE,
          'User-Agent': 'homebridge-salus-cloud/2026',
        },
        body: JSON.stringify({
          user: {
            email,
            password,
          },
        }),
      },
      {
        description: 'JSON payload with flat credentials',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Accept-Language': ACCEPT_LANGUAGE,
          'User-Agent': 'homebridge-salus-cloud/2026',
        },
        body: JSON.stringify({
          email,
          password,
        }),
      },
      {
        description: 'Form-encoded payload with nested user fields',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept-Language': ACCEPT_LANGUAGE,
          'User-Agent': 'homebridge-salus-cloud/2026',
        },
        body: new URLSearchParams({
          'user[email]': email,
          'user[password]': password,
        }).toString(),
      },
    ];

    const totalAttempts = this.maxRetries + 1;
    let lastError: unknown = new Error('Legacy Salus login did not return a session');

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const orderedBaseUrls = this.getOrderedLegacyApiBaseUrls();
      let sawRetriableFailure = false;
      let sawDefinitiveFailure = false;
      let definitiveError: unknown;

      for (const baseUrl of orderedBaseUrls) {
        for (const path of LEGACY_LOGIN_PATH_CANDIDATES) {
          for (const variant of loginVariants) {
            try {
              const response = await this.fetchWithTimeout(
                buildLegacyUrl(baseUrl, path, true),
                {
                  method: 'POST',
                  headers: variant.headers,
                  body: variant.body,
                },
              );

              if (!response.ok) {
                const responseText = await safeReadText(response);
                const statusError = new HttpStatusError(
                  responseText
                    ? `Legacy Salus login failed at ${baseUrl}${path} via ${variant.description} (HTTP ${response.status}) :: ${responseText}`
                    : `Legacy Salus login failed at ${baseUrl}${path} via ${variant.description} (HTTP ${response.status})`,
                  response.status,
                  responseText,
                );

                lastError = statusError;

                if (STATUS_ALLOW_PATH_FALLBACK.has(response.status)) {
                  continue;
                }
                if (response.status === 400 || response.status === 415 || response.status === 422) {
                  continue;
                }
                if (isRetriableStatus(response.status)) {
                  sawRetriableFailure = true;
                  continue;
                }

                sawDefinitiveFailure = true;
                if (!definitiveError) {
                  definitiveError = statusError;
                }
                continue;
              }

              const payload = await parseResponseBody<unknown>(response);
              const session = parseLegacyTokens(payload);
              if (!session) {
                const parseError = new Error(
                  `Legacy Salus login succeeded at ${baseUrl}${path}, but access token was missing in response.`,
                );
                lastError = parseError;
                continue;
              }

              this.activeLegacyApiBaseUrl = baseUrl;
              return session;
            } catch (error) {
              if (!this.allowInsecureTls && isTlsCertificateError(error)) {
                const message = `${asErrorMessage(error)}. If Salus cloud certificate is invalid, set "allowInsecureTls": true in plugin config.`;
                throw new Error(message);
              }

              if (isRetriableFailure(error)) {
                sawRetriableFailure = true;
                lastError = error;
                continue;
              }

              sawDefinitiveFailure = true;
              if (!definitiveError) {
                definitiveError = error;
              }
              lastError = error;
            }
          }
        }
      }

      if (sawDefinitiveFailure) {
        throw definitiveError ?? lastError;
      }

      if (attempt < totalAttempts && sawRetriableFailure) {
        await this.retryDelay(attempt, asErrorMessage(lastError));
        continue;
      }

      break;
    }

    throw new Error(`Legacy Salus login failed after retries: ${asErrorMessage(lastError)}`);
  }

  private async authenticateWithPassword(): Promise<CognitoSession> {
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

    return tokens;
  }

  private async authenticateWithRefreshToken(refreshToken: string): Promise<CognitoSession> {
    const payload = await this.cognitoInitiateAuth({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: this.cognitoClientId,
      AuthParameters: {
        REFRESH_TOKEN: refreshToken,
      },
    });

    const refreshed = parseCognitoTokens(payload, refreshToken);
    if (!refreshed) {
      throw new Error('Cognito refresh response did not include AccessToken.');
    }

    return refreshed;
  }

  private async cognitoInitiateAuth(body: Record<string, unknown>): Promise<unknown> {
    const totalAttempts = this.maxRetries + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      try {
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
          const cognitoError = new HttpStatusError(
            `Cognito auth failed (HTTP ${response.status}): ${cognitoMessage}`,
            response.status,
            responseBody,
          );

          if (isRetriableStatus(response.status) && attempt < totalAttempts) {
            lastError = cognitoError;
            await this.retryDelay(attempt, cognitoError.message);
            continue;
          }

          throw cognitoError;
        }

        return await response.json() as unknown;
      } catch (error) {
        if (!this.allowInsecureTls && isTlsCertificateError(error)) {
          const message = `${asErrorMessage(error)}. If Salus cloud certificate is invalid, set "allowInsecureTls": true in plugin config.`;
          throw new Error(message);
        }

        if (isRetriableFailure(error) && attempt < totalAttempts) {
          lastError = error;
          await this.retryDelay(attempt, asErrorMessage(error));
          continue;
        }

        throw error;
      }
    }

    throw new Error(`Cognito auth failed after retries: ${asErrorMessage(lastError)}`);
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

  private async requestLegacyJsonWithPathFallback<T>(paths: string[], options: RequestOptions): Promise<T> {
    let lastPathError: unknown;

    for (const path of paths) {
      try {
        return await this.requestLegacyJson<T>(path, options);
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

    throw new Error(`No valid legacy path candidates for request: ${paths.join(', ')}`);
  }

  private async requestServiceJson<T>(path: string, options: RequestOptions): Promise<T> {
    const authRequired = options.auth ?? true;
    if (authRequired) {
      await this.ensureLoggedIn();
    }

    const expectedStatuses = options.expectedStatuses ?? DEFAULT_EXPECTED_STATUSES;
    const totalAttempts = this.maxRetries + 1;

    let hasRefreshedSessionAfter401 = false;
    const attemptedCompanyCodes = new Set<string>([companyCodeCandidateKey(this.activeCompanyCode)]);
    let unauthorizedRecoverySteps = 0;
    let lastError: unknown = new Error(`No Salus cloud response received for ${options.method} ${path}`);

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const orderedBaseUrls = this.getOrderedServiceApiBaseUrls();
      let sawRetriableFailure = false;
      let sawDefinitiveFailure = false;
      let definitiveError: unknown;
      let lastRetriableError: unknown;

      for (let baseIndex = 0; baseIndex < orderedBaseUrls.length; baseIndex++) {
        const baseUrl = orderedBaseUrls[baseIndex]!;
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

          if (response.status === 401 && authRequired) {
            const responseText = await safeReadText(response);
            const responseCode = extractServiceResponseCode(responseText);
            const hintedCompanyCode = extractCompanyCodeFromServiceAuthError(responseText);
            const isCompanyCodeMismatch = responseCode === '900008';

            if (isCompanyCodeMismatch && !this.hasWarnedAboutAuthCompanyCode) {
              this.hasWarnedAboutAuthCompanyCode = true;
              this.log.warn(
                'Salus cloud returned response_code=900008 (Not authorized). This often indicates tenant/company authorization context mismatch.',
              );
            }

            if ((options.allow401Refresh ?? true) && !hasRefreshedSessionAfter401) {
              unauthorizedRecoverySteps += 1;
              if (unauthorizedRecoverySteps > MAX_UNAUTHORIZED_RECOVERY_STEPS) {
                throw new Error(`Exceeded maximum unauthorized recovery steps while requesting ${options.method} ${path}`);
              }
              hasRefreshedSessionAfter401 = true;
              this.log.warn(`Salus cloud returned 401 for ${options.method} ${path} at ${baseUrl}. Refreshing session token and retrying.`);
              await this.refreshSession();
              lastError = new HttpStatusError('Unauthorized', 401, responseText);
              sawRetriableFailure = true;
              lastRetriableError = lastError;
              baseIndex -= 1;
              continue;
            }

            if (isCompanyCodeMismatch) {
              const previousCompanyCode = this.activeCompanyCode;
              const rotatedCompanyCode = this.rotateCompanyCodeCandidate(attemptedCompanyCodes, hintedCompanyCode);
              if (companyCodeCandidateKey(rotatedCompanyCode) !== companyCodeCandidateKey(previousCompanyCode)) {
                unauthorizedRecoverySteps += 1;
                if (unauthorizedRecoverySteps > MAX_UNAUTHORIZED_RECOVERY_STEPS) {
                  throw new Error(`Exceeded maximum unauthorized recovery steps while requesting ${options.method} ${path}`);
                }
                this.log.warn(
                  rotatedCompanyCode
                    ? `Salus cloud returned 401 for ${options.method} ${path} at ${baseUrl}.`
                      + ` Retrying with alternate company code header: ${rotatedCompanyCode}.`
                    : `Salus cloud returned 401 for ${options.method} ${path} at ${baseUrl}. Retrying without company code header.`,
                );
                lastError = new HttpStatusError('Unauthorized', 401, responseText);
                sawRetriableFailure = true;
                lastRetriableError = lastError;
                baseIndex -= 1;
                continue;
              }
            }

            if (!isCompanyCodeMismatch) {
              const previousCompanyCode = this.activeCompanyCode;
              const rotatedCompanyCode = this.rotateCompanyCodeCandidate(attemptedCompanyCodes, hintedCompanyCode);
              if (companyCodeCandidateKey(rotatedCompanyCode) !== companyCodeCandidateKey(previousCompanyCode)) {
                unauthorizedRecoverySteps += 1;
                if (unauthorizedRecoverySteps > MAX_UNAUTHORIZED_RECOVERY_STEPS) {
                  throw new Error(`Exceeded maximum unauthorized recovery steps while requesting ${options.method} ${path}`);
                }
                this.log.warn(
                  rotatedCompanyCode
                    ? `Salus cloud returned 401 for ${options.method} ${path} at ${baseUrl}.`
                      + ` Retrying with alternate company code header: ${rotatedCompanyCode}.`
                    : `Salus cloud returned 401 for ${options.method} ${path} at ${baseUrl}. Retrying without company code header.`,
                );
                lastError = new HttpStatusError('Unauthorized', 401, responseText);
                sawRetriableFailure = true;
                lastRetriableError = lastError;
                baseIndex -= 1;
                continue;
              }
            }

            if (isCompanyCodeMismatch) {
              throw new LegacyFallbackRequiredError(
                `Modern Salus API returned response_code=900008 on ${options.method} ${path} at ${baseUrl}.`,
              );
            }

            const unauthorizedError = new HttpStatusError(
              responseText
                ? `HTTP 401 Unauthorized on ${options.method} ${path} via ${baseUrl} :: ${responseText}`
                : `HTTP 401 Unauthorized on ${options.method} ${path} via ${baseUrl}`,
              401,
              responseText,
            );
            lastError = unauthorizedError;
            sawRetriableFailure = true;
            lastRetriableError = unauthorizedError;
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

            if (isRetriableStatus(response.status)) {
              lastError = statusError;
              sawRetriableFailure = true;
              lastRetriableError = statusError;
              continue;
            }

            lastError = statusError;
            sawDefinitiveFailure = true;
            if (!definitiveError) {
              definitiveError = statusError;
            }
            continue;
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
            if (isRetriableStatus(error.status)) {
              sawRetriableFailure = true;
              lastRetriableError = error;
            } else if (!STATUS_ALLOW_PATH_FALLBACK.has(error.status)) {
              sawDefinitiveFailure = true;
              if (!definitiveError) {
                definitiveError = error;
              }
            }
            continue;
          }

          if (isRetriableError(error)) {
            lastError = error;
            sawRetriableFailure = true;
            lastRetriableError = error;
            if (this.verboseLogging) {
              this.log.debug(`Retriable network error for ${options.method} ${path} via ${baseUrl}: ${asErrorMessage(error)}`);
            }
            continue;
          }

          throw error;
        }
      }

      if (sawDefinitiveFailure) {
        throw definitiveError ?? lastError;
      }

      if (attempt < totalAttempts && sawRetriableFailure) {
        await this.retryDelay(attempt, asErrorMessage(lastRetriableError ?? lastError));
        continue;
      }

      if (lastError) {
        throw lastError;
      }
    }

    throw new Error(`Unexpected request state for ${options.method} ${path}`);
  }

  private async requestLegacyJson<T>(path: string, options: RequestOptions): Promise<T> {
    const authRequired = options.auth ?? true;
    if (authRequired) {
      await this.ensureLegacyLoggedIn();
    }

    const expectedStatuses = options.expectedStatuses ?? DEFAULT_EXPECTED_STATUSES;
    const totalAttempts = this.maxRetries + 1;
    let hasRefreshedSessionAfter401 = false;
    let lastError: unknown = new Error(`No legacy Salus cloud response received for ${options.method} ${path}`);

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const orderedBaseUrls = this.getOrderedLegacyApiBaseUrls();
      let sawRetriableFailure = false;
      let sawDefinitiveFailure = false;
      let definitiveError: unknown;
      let lastRetriableError: unknown;

      for (const baseUrl of orderedBaseUrls) {
        try {
          const headers = this.buildLegacyHeaders(authRequired);
          const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
          if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
          }

          const response = await this.fetchWithTimeout(
            buildLegacyUrl(baseUrl, path, options.method === 'GET'),
            {
              method: options.method,
              headers,
              body,
            },
          );

          if (response.status === 401 && authRequired) {
            const responseText = await safeReadText(response);
            if ((options.allow401Refresh ?? true) && !hasRefreshedSessionAfter401) {
              hasRefreshedSessionAfter401 = true;
              this.log.warn(`Legacy Salus cloud returned 401 for ${options.method} ${path} at ${baseUrl}. Re-authenticating and retrying.`);
              this.legacySession = null;
              await this.loginLegacy();
              lastError = new HttpStatusError('Unauthorized', 401, responseText);
              sawRetriableFailure = true;
              lastRetriableError = lastError;
              continue;
            }

            const unauthorizedError = new HttpStatusError(
              responseText
                ? `HTTP 401 Unauthorized on legacy ${options.method} ${path} via ${baseUrl} :: ${responseText}`
                : `HTTP 401 Unauthorized on legacy ${options.method} ${path} via ${baseUrl}`,
              401,
              responseText,
            );
            lastError = unauthorizedError;
            sawRetriableFailure = true;
            lastRetriableError = unauthorizedError;
            continue;
          }

          if (!expectedStatuses.includes(response.status)) {
            const responseText = await safeReadText(response);
            const statusError = new HttpStatusError(
              responseText
                ? `Legacy API HTTP ${response.status} ${response.statusText} on ${options.method} ${path} :: ${responseText}`
                : `Legacy API HTTP ${response.status} ${response.statusText} on ${options.method} ${path}`,
              response.status,
              responseText,
            );

            if (STATUS_ALLOW_PATH_FALLBACK.has(response.status)) {
              lastError = statusError;
              continue;
            }

            if (isRetriableStatus(response.status)) {
              lastError = statusError;
              sawRetriableFailure = true;
              lastRetriableError = statusError;
              continue;
            }

            lastError = statusError;
            sawDefinitiveFailure = true;
            if (!definitiveError) {
              definitiveError = statusError;
            }
            continue;
          }

          this.activeLegacyApiBaseUrl = baseUrl;

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
            if (isRetriableStatus(error.status)) {
              sawRetriableFailure = true;
              lastRetriableError = error;
            } else if (!STATUS_ALLOW_PATH_FALLBACK.has(error.status)) {
              sawDefinitiveFailure = true;
              if (!definitiveError) {
                definitiveError = error;
              }
            }
            continue;
          }

          if (isRetriableError(error)) {
            lastError = error;
            sawRetriableFailure = true;
            lastRetriableError = error;
            if (this.verboseLogging) {
              this.log.debug(`Retriable legacy network error for ${options.method} ${path} via ${baseUrl}: ${asErrorMessage(error)}`);
            }
            continue;
          }

          throw error;
        }
      }

      if (sawDefinitiveFailure) {
        throw definitiveError ?? lastError;
      }

      if (attempt < totalAttempts && sawRetriableFailure) {
        await this.retryDelay(attempt, asErrorMessage(lastRetriableError ?? lastError));
        continue;
      }

      if (lastError) {
        throw lastError;
      }
    }

    throw new Error(`Unexpected legacy request state for ${options.method} ${path}`);
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

    // The Salus AWS service-api expects this exact token pair:
    // x-access-token = access token, x-auth-token = id token.
    headers['x-access-token'] = this.session.accessToken;
    headers['x-auth-token'] = this.session.idToken;
    const companyCode = this.activeCompanyCode;
    if (companyCode) {
      headers['x-company-code'] = companyCode;
    }

    return headers;
  }

  private buildLegacyHeaders(authRequired: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Accept-Language': ACCEPT_LANGUAGE,
      'User-Agent': 'homebridge-salus-cloud/2026',
    };

    if (!authRequired) {
      return headers;
    }

    if (!this.legacySession) {
      throw new Error('Missing Salus legacy session while building authenticated request.');
    }

    const tokenType = normalizeNonEmptyString(this.legacySession.tokenType) ?? 'Bearer';
    headers.Authorization = `${tokenType} ${this.legacySession.accessToken}`;
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

  private getOrderedLegacyApiBaseUrls(): string[] {
    const dedupe = new Set<string>();
    const ordered: string[] = [];

    if (this.activeLegacyApiBaseUrl) {
      dedupe.add(this.activeLegacyApiBaseUrl);
      ordered.push(this.activeLegacyApiBaseUrl);
    }

    for (const candidate of this.legacyApiBaseCandidates) {
      if (dedupe.has(candidate)) {
        continue;
      }
      dedupe.add(candidate);
      ordered.push(candidate);
    }

    return ordered;
  }

  private async retryDelay(attempt: number, reason: string): Promise<void> {
    const baseDelay = Math.min(MAX_RETRY_DELAY_MS, this.retryBaseDelayMs * (2 ** (attempt - 1)));
    const jitter = 0.85 + (Math.random() * 0.3);
    const delayMs = Math.max(250, Math.round(baseDelay * jitter));
    this.log.warn(`Retrying Salus cloud request in ${delayMs}ms (attempt ${attempt + 1}/${this.maxRetries + 1}): ${reason}`);
    await sleep(delayMs);
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.requestTimeoutMs);

    if (this.allowInsecureTls && this.insecureTlsInFlight === 0) {
      this.insecureTlsHadPreviousValue = Object.prototype.hasOwnProperty.call(process.env, 'NODE_TLS_REJECT_UNAUTHORIZED');
      this.insecureTlsPreviousValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
    if (this.allowInsecureTls) {
      this.insecureTlsInFlight += 1;
    }

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      if (this.allowInsecureTls) {
        this.insecureTlsInFlight = Math.max(0, this.insecureTlsInFlight - 1);
        if (this.insecureTlsInFlight === 0) {
          if (this.insecureTlsHadPreviousValue) {
            if (this.insecureTlsPreviousValue === undefined) {
              delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
            } else {
              process.env.NODE_TLS_REJECT_UNAUTHORIZED = this.insecureTlsPreviousValue;
            }
          } else {
            delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
          }
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
    ? [
      DEFAULT_US_SERVICE_API_HOST,
      FALLBACK_US_SERVICE_API_HOST,
      DEFAULT_EU_SERVICE_API_HOST,
      FALLBACK_EU_SERVICE_API_HOST,
    ]
    : [
      DEFAULT_EU_SERVICE_API_HOST,
      FALLBACK_EU_SERVICE_API_HOST,
      DEFAULT_US_SERVICE_API_HOST,
      FALLBACK_US_SERVICE_API_HOST,
    ];

  return dedupeStringArray(hosts.flatMap((host) => buildApiVersionCandidates(host, versionPreference)));
}

function buildLegacyApiBaseCandidates(
  region: SalusRegion | undefined,
  overrideHost: string | undefined,
): string[] {
  const normalizedOverride = normalizeNonEmptyString(overrideHost);
  if (normalizedOverride) {
    const overrideCandidates = deriveLegacyHostCandidatesFromOverride(normalizedOverride);
    if (overrideCandidates.length > 0) {
      const withFallback = [
        ...overrideCandidates,
        ...(region === 'us'
          ? [DEFAULT_US_LEGACY_API_HOST, FALLBACK_US_LEGACY_API_HOST, DEFAULT_EU_LEGACY_API_HOST, FALLBACK_EU_LEGACY_API_HOST]
          : [DEFAULT_EU_LEGACY_API_HOST, FALLBACK_EU_LEGACY_API_HOST, DEFAULT_US_LEGACY_API_HOST, FALLBACK_US_LEGACY_API_HOST]),
      ];
      return dedupeStringArray(withFallback.map((value) => normalizeUrl(value)));
    }
  }

  const hosts = region === 'us'
    ? [
      DEFAULT_US_LEGACY_API_HOST,
      FALLBACK_US_LEGACY_API_HOST,
      DEFAULT_EU_LEGACY_API_HOST,
      FALLBACK_EU_LEGACY_API_HOST,
    ]
    : [
      DEFAULT_EU_LEGACY_API_HOST,
      FALLBACK_EU_LEGACY_API_HOST,
      DEFAULT_US_LEGACY_API_HOST,
      FALLBACK_US_LEGACY_API_HOST,
    ];

  return dedupeStringArray(hosts.map((value) => normalizeUrl(value)));
}

function deriveLegacyHostCandidatesFromOverride(overrideHost: string): string[] {
  const normalizedOverride = normalizeUrl(overrideHost);
  const candidates = new Set<string>();

  try {
    const parsed = new URL(normalizedOverride);
    const hostname = parsed.hostname.toLowerCase();
    const protocol = parsed.protocol;

    candidates.add(`${protocol}//${hostname}`);
    if (hostname.startsWith('service-api.')) {
      candidates.add(`${protocol}//${hostname.replace(/^service-api\./, '')}`);
    }
  } catch {
    // Keep best-effort fallback.
    candidates.add(normalizedOverride.replace(/\/api\/v[12](?:\/.*)?$/i, '').replace(/\/+$/, ''));
    candidates.add(
      normalizedOverride
        .replace(/\/api\/v[12](?:\/.*)?$/i, '')
        .replace(/\/+$/, '')
        .replace(/:\/\/service-api\./i, '://'),
    );
  }

  return [...candidates].filter((value) => value.trim() !== '');
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

function dedupeStringArray(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

function buildServiceUrl(baseUrl: string, path: string, addTimestamp: boolean): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const joined = `${baseUrl}${normalizedPath}`;
  return addTimestamp ? withTimestampQuery(joined) : joined;
}

function buildLegacyUrl(baseUrl: string, path: string, addTimestamp: boolean): string {
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

function buildCompanyCodeCandidates(
  configuredCompanyCode: string | null,
  sessionCompanyCode: string | undefined,
  region: SalusRegion | undefined,
): CompanyCodeCandidate[] {
  const normalizedConfigured = normalizeNonEmptyString(configuredCompanyCode ?? undefined) ?? null;
  const normalizedSession = normalizeNonEmptyString(sessionCompanyCode);
  const fallbackCandidates = dedupeStringArray([
    ...buildRegionalCompanyCodeCandidates(region),
    ...DEFAULT_COMPANY_CODE_FALLBACKS,
  ])
    .map((value) => normalizeNonEmptyString(value))
    .filter((value): value is string => Boolean(value));

  const initialCandidates = [
    normalizedConfigured,
    normalizedSession,
  ]
    .map((value) => normalizeNonEmptyString(value ?? undefined))
    .filter((value): value is string => Boolean(value));

  const seen = new Set<string>();
  const deduped: CompanyCodeCandidate[] = [];
  for (const candidate of [...initialCandidates, ...fallbackCandidates, null]) {
    const key = companyCodeCandidateKey(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

function buildRegionalCompanyCodeCandidates(region: SalusRegion | undefined): string[] {
  if (region === 'us') {
    return [
      'salus-us',
      'salus_us',
      'salus',
      'SALUS_US',
      'SALUS',
    ];
  }

  return [
    'salus-eu',
    'salus_eu',
    'salus',
    'SALUS_EU',
    'SALUS',
  ];
}

function companyCodeCandidateKey(candidate: CompanyCodeCandidate): string {
  return candidate ?? NO_COMPANY_CODE_SENTINEL;
}

function extractServiceResponseCode(responseText: string): string | undefined {
  if (!responseText) {
    return undefined;
  }

  const parsed = parseJsonRecord(responseText);
  if (!parsed) {
    return undefined;
  }

  return asString(parsed.response_code)
    ?? asString(parsed.code)
    ?? asString(parsed.error_code);
}

function extractCompanyCodeFromServiceAuthError(responseText: string): string | undefined {
  if (!responseText) {
    return undefined;
  }

  const parsed = parseJsonRecord(responseText);
  if (!parsed) {
    return undefined;
  }

  const direct = asRecord(parsed.data) ?? parsed;
  return extractCompanyCodeFromTokenClaims(direct);
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
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
  const decodedIdTokenClaims = decodeJwtPayload(idToken);
  const decodedAccessTokenClaims = decodeJwtPayload(accessToken);

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
    companyCode: extractCompanyCodeFromTokenClaims(decodedIdTokenClaims, decodedAccessTokenClaims),
  };
}

function parseLegacyTokens(payload: unknown): LegacySession | undefined {
  const root = asRecord(payload);
  if (!root) {
    return undefined;
  }

  const valueRecord = asRecord(root.value);
  const candidateRecords = [
    root,
    valueRecord,
    asRecord(root.user),
    valueRecord ? asRecord(valueRecord.user) : undefined,
  ].filter((value): value is Record<string, unknown> => Boolean(value));

  for (const candidate of candidateRecords) {
    const accessToken = normalizeNonEmptyString(
      asString(candidate.access_token)
      ?? asString(candidate.accessToken)
      ?? asString(candidate.token)
      ?? asString(candidate.auth_token)
      ?? asString(candidate.bearer_token),
    );
    if (!accessToken) {
      continue;
    }

    const tokenType = normalizeNonEmptyString(asString(candidate.token_type) ?? asString(candidate.tokenType)) ?? 'Bearer';
    const expiresInRaw = parseNumberLike(candidate.expires_in ?? candidate.expiresIn ?? candidate.expired_in);
    const expiresInMs = Number.isFinite(expiresInRaw)
      ? Math.max(60_000, Math.floor(Number(expiresInRaw) * 1_000))
      : LEGACY_DEFAULT_SESSION_TTL_MS;

    return {
      accessToken,
      tokenType,
      expiresAtEpochMs: Date.now() + expiresInMs,
    };
  }

  return undefined;
}

function extractCompanyCodeFromTokenClaims(...claimSets: Array<Record<string, unknown> | undefined>): string | undefined {
  for (const claims of claimSets) {
    if (!claims) {
      continue;
    }

    const candidates = [
      claims.companyCode,
      claims.company_code,
      claims.company,
      claims['custom:companyCode'],
      claims['custom:company_code'],
      claims['custom:company'],
      claims['x-company-code'],
      claims.tenantCode,
      claims.tenant_code,
      claims.tenantId,
      claims.tenant_id,
    ];

    for (const candidate of candidates) {
      const normalized = normalizeNonEmptyString(asString(candidate));
      if (normalized) {
        return normalized;
      }
    }
  }
  return undefined;
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) {
    return undefined;
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    return undefined;
  }

  const payloadPart = parts[1];
  if (!payloadPart) {
    return undefined;
  }

  try {
    const normalized = payloadPart.replaceAll('-', '+').replaceAll('_', '/');
    const paddingLength = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + '='.repeat(paddingLength);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return asRecord(JSON.parse(json));
  } catch {
    return undefined;
  }
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

function parseGatewayIdsFromOccupantsPayload(payload: unknown): string[] {
  const root = asRecord(payload);
  if (!root) {
    return [];
  }

  const data = asArray(root.data) ?? asArray(root.results) ?? asArray(root.list);
  if (!data) {
    return [];
  }

  const ids: string[] = [];
  for (const entry of data) {
    const record = asRecord(entry);
    const id = asString(record?.id)
      ?? asString(record?.gateway_id)
      ?? asString(record?.gatewayId);
    if (!id) {
      continue;
    }
    ids.push(id);
  }

  return dedupeStringArray(ids);
}

function parseDevices(payload: unknown): SalusDevice[] {
  const root = asRecord(payload);
  const candidates: unknown[][] = [];

  if (Array.isArray(payload)) {
    candidates.push(payload);
  }

  if (root) {
    const arrayKeys = ['devices', 'registered_nodes', 'nodes', 'results', 'data', 'list', 'device_list', 'value'];
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

  const result: SalusDevice[] = [];
  const visitedEntries = new Set<unknown>();

  for (const candidate of candidates) {
    for (const item of candidate) {
      if (visitedEntries.has(item)) {
        continue;
      }
      visitedEntries.add(item);

      const rawItem = asRecord(item);
      const deviceWrapper = rawItem?.device;
      const normalized = asRecord(deviceWrapper) ?? rawItem;
      if (!normalized) {
        continue;
      }

      const dsn = asString(normalized.dsn)
        ?? asString(normalized.device_dsn)
        ?? asString(normalized.device_code)
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
        ?? asString(normalized.model_name)
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
    ?? asString(record.device_code)
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
  const candidateSingles: unknown[] = [];

  if (Array.isArray(payload)) {
    candidateArrays.push(payload);
  }

  if (root) {
    const keys = ['properties', 'property', 'data', 'results', 'datapoints', 'list', 'value'];
    for (const key of keys) {
      const maybeArray = asArray(root[key]);
      if (maybeArray) {
        candidateArrays.push(maybeArray);
      }
    }

    const valueRecord = asRecord(root.value);
    if (valueRecord) {
      candidateSingles.push(valueRecord);

      const nestedArrayKeys = ['properties', 'property', 'data', 'results', 'datapoints', 'list'];
      for (const key of nestedArrayKeys) {
        const nestedArray = asArray(valueRecord[key]);
        if (nestedArray) {
          candidateArrays.push(nestedArray);
        }
      }
    }

    candidateSingles.push(root);
  }

  for (const entries of candidateArrays) {
    for (const entry of entries) {
      const property = parsePropertyEntry(entry);
      if (property) {
        result.set(property.name, property);
      }
    }
  }

  for (const candidate of candidateSingles) {
    const property = parsePropertyEntry(candidate);
    if (property) {
      result.set(property.name, property);
    }
  }

  for (const candidate of candidateSingles) {
    const record = asRecord(candidate);
    if (!record) {
      continue;
    }
    parsePropertyObjectMap(record, result);
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
  if (/^\d+$/.test(name)) {
    return false;
  }

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

function prioritizeByDescription<T extends { description: string }>(items: T[], preferredDescription: string | null): T[] {
  if (!preferredDescription) {
    return items;
  }

  const preferred = items.find((item) => item.description === preferredDescription);
  if (!preferred) {
    return items;
  }

  return [preferred, ...items.filter((item) => item !== preferred)];
}

function isRetriableFailure(error: unknown): boolean {
  if (error instanceof HttpStatusError) {
    return isRetriableStatus(error.status);
  }
  return isRetriableError(error);
}

function shouldSwitchToLegacyApi(error: unknown): boolean {
  if (error instanceof LegacyFallbackRequiredError) {
    return true;
  }

  if (!(error instanceof HttpStatusError)) {
    return false;
  }

  if (error.status === 401 || error.status === 403) {
    const responseCode = extractServiceResponseCode(error.responseBody);
    return responseCode === '900008';
  }

  return false;
}

function shouldTryAlternateDiscovery(error: unknown): boolean {
  if (error instanceof OccupantsDiscoveryEmptyError) {
    return true;
  }
  if (error instanceof HttpStatusError) {
    return true;
  }
  return isRetriableFailure(error);
}

function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetriableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = getErrorCauseCode(error)?.toUpperCase();
  if (code && RETRIABLE_ERROR_CODES.has(code)) {
    return true;
  }

  const message = error.message.toLowerCase();
  return message.includes('timed out')
    || message.includes('network')
    || message.includes('fetch failed')
    || message.includes('aborted')
    || message.includes('econnreset')
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
  const directCode = (error as Error & { code?: unknown }).code;
  if (typeof directCode === 'string') {
    return directCode;
  }

  if (error.cause instanceof Error) {
    const nestedCode = (error.cause as Error & { code?: unknown }).code;
    if (typeof nestedCode === 'string') {
      return nestedCode;
    }
  }

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
