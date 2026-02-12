/* eslint-disable @typescript-eslint/no-use-before-define */

import type { Logging } from 'homebridge';
import process from 'node:process';
import crypto from 'node:crypto';
import * as mqtt from 'mqtt';

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
  allowCompanyCodeRotation?: boolean;
  activeServiceBaseOnly?: boolean;
  maxAttempts?: number;
  expectedStatuses?: number[];
}

interface CognitoSession {
  accessToken: string;
  idToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAtEpochMs: number;
  companyCode?: string;
  cognitoRegion?: string;
  userPoolId?: string;
}

interface LegacySession {
  accessToken: string;
  tokenType: string;
  expiresAtEpochMs: number;
}

interface AwsIotCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAtEpochMs: number;
}

interface AwsRegionalDefaults {
  cognitoRegion: string;
  cognitoClientId: string;
  cognitoUserPoolId: string;
  awsIdentityPoolId: string;
  awsIotRegion: string;
  awsIotEndpointHost: string;
}

interface ShadowRequestVariant {
  method: HttpMethod;
  path: string;
  body?: unknown;
  description: string;
}

interface AwsShadowWriteContext {
  branchKeys: string[];
  includeRootProperties: boolean;
}

interface OccupantsSliderTarget {
  id: string;
  typeHints: string[];
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
const DEFAULT_COGNITO_REGION = 'eu-central-1';
const DEFAULT_COGNITO_CLIENT_ID = '4pk5efh3v84g5dav43imsv4fbj';
const DEFAULT_COGNITO_USER_POOL_ID = 'eu-central-1_XGRz3CgoY';
const DEFAULT_US_COGNITO_REGION = 'us-west-2';
const DEFAULT_US_COGNITO_CLIENT_ID = '1fgea5eabr72n1ueg16314jcqh';
const DEFAULT_US_COGNITO_USER_POOL_ID = 'us-west-2_lb5ZECtRi';
const DEFAULT_EU_SERVICE_API_HOST = 'https://service-api.eu.premium.salusconnect.io';
const DEFAULT_US_SERVICE_API_HOST = 'https://service-api.us.premium.salusconnect.io';
const FALLBACK_US_SERVICE_API_HOST = 'https://service-api.us.salusconnect.io';
const FALLBACK_EU_SERVICE_API_HOST = 'https://service-api.eu.salusconnect.io';
const DEFAULT_EU_LEGACY_API_HOST = 'https://eu.premium.salusconnect.io';
const DEFAULT_US_LEGACY_API_HOST = 'https://us.premium.salusconnect.io';
const FALLBACK_US_LEGACY_API_HOST = 'https://us.salusconnect.io';
const FALLBACK_EU_LEGACY_API_HOST = 'https://eu.salusconnect.io';
const DEFAULT_EU_AWS_IDENTITY_POOL_ID = 'eu-central-1:60912c00-287d-413b-a2c9-ece3ccef9230';
const DEFAULT_US_AWS_IDENTITY_POOL_ID = 'us-west-2:975c9020-1457-496c-a1df-d25bfae18016';
const DEFAULT_EU_AWS_IOT_ENDPOINT_HOST = 'a24u3z7zzwrtdl-ats.iot.eu-central-1.amazonaws.com';
const DEFAULT_US_AWS_IOT_ENDPOINT_HOST = 'a13wqb1xlbpvq5-ats.iot.us-west-2.amazonaws.com';
const DEFAULT_AWS_IOT_SERVICE = 'iotdevicegateway';
const COGNITO_IDENTITY_GET_ID_TARGET = 'AWSCognitoIdentityService.GetId';
const COGNITO_IDENTITY_GET_CREDENTIALS_TARGET = 'AWSCognitoIdentityService.GetCredentialsForIdentity';

const COGNITO_INITIATE_AUTH_TARGET = 'AWSCognitoIdentityProviderService.InitiateAuth';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9,en;q=0.8';
const SESSION_REFRESH_SAFETY_MS = 60_000;
const LEGACY_SESSION_REFRESH_SAFETY_MS = 60_000;
const LEGACY_DEFAULT_SESSION_TTL_MS = 45 * 60_000;
const AWS_IOT_CREDENTIAL_REFRESH_SAFETY_MS = 60_000;
const MQTT_MIN_CONNECT_TIMEOUT_MS = 10_000;
const MAX_UNAUTHORIZED_RECOVERY_STEPS = 48;
const SLIDER_DETAILS_BLOCK_TTL_MS = 15 * 60_000;
const DEVICE_SHADOW_BLOCK_TTL_MS = 15 * 60_000;
const MAX_OCCUPANTS_DETAIL_TARGETS_PER_SYNC = 40;
const MAX_OCCUPANTS_DETAIL_DISCOVERY_DURATION_MS = 45_000;
const MAX_OCCUPANTS_DETAIL_TYPES_PER_TARGET = 4;

const STATUS_ALLOW_PATH_FALLBACK = new Set([404, 405, 426]);
const STATUS_ALLOW_WRITE_SHAPE_FALLBACK = new Set([400, 404, 405, 409, 415, 422]);
const STATUS_ALLOW_OCCUPANTS_VARIANT_FALLBACK = new Set([400, 404, 405, 422]);
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
const OCCUPANTS_SLIDER_LIST_PATH_GROUPS = [
  ['/occupants/slider_list', '/api/v1/occupants/slider_list'],
  ['/occupants/slider_list?type=gateway', '/api/v1/occupants/slider_list?type=gateway'],
  ['/occupants/slider_list?type=occupant', '/api/v1/occupants/slider_list?type=occupant'],
  ['/occupants/slider_list?type=home', '/api/v1/occupants/slider_list?type=home'],
  ['/occupants/slider_list?type=site', '/api/v1/occupants/slider_list?type=site'],
];
const OCCUPANTS_SLIDER_DETAIL_TYPE_FALLBACKS = ['gateway', 'occupant', 'home', 'site'];

const METADATA_FIELD_NAMES = new Set([
  'id',
  'key',
  'dsn',
  'name',
  'device_name',
  'model',
  'model_name',
  'device_model',
  'product_class',
  'layout',
  'product_name',
  'oem_model',
  'type',
  'status',
  'online',
  'offline',
  'enabled',
  'disabled',
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
  'gateway_name',
  'home_id',
  'home_name',
  'house_id',
  'house_name',
  'site_id',
  'site_name',
  'room_id',
  'room_name',
  'location_id',
  'location_name',
  'category_id',
  'category_name',
  'serial_number',
  'serialNumber',
  'mac_address',
  'mac',
  'ieee_address',
  'firmware_version',
  'hardware_version',
  'user_id',
  'occupant_id',
]);
const METADATA_FIELD_NAMES_LOWER = new Set([...METADATA_FIELD_NAMES].map((value) => value.toLowerCase()));

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
  private readonly configuredCognitoRegion: string;
  private readonly configuredCognitoUserPoolId: string;
  private readonly awsIdentityPoolId: string;
  private readonly awsIotEndpointBaseUrl: string;
  private readonly awsIotEndpointHost: string;
  private readonly awsIotRegion: string;
  private readonly awsIotServiceName: string;
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
  private readonly shadowBaseKeyByDsn: Map<string, string> = new Map();
  private awsIdentityId: string | null = null;
  private awsIotCredentials: AwsIotCredentials | null = null;
  private readonly blockedSliderDetailsTargets = new Map<string, number>();
  private blockedAllSliderDetailsUntilEpochMs = 0;
  private blockedModernDeviceShadowUntilEpochMs = 0;
  private hasWarnedAboutSliderDetailsAuthFailure = false;
  private hasWarnedAboutSliderDetailsTransientFailure = false;
  private hasWarnedAboutDeviceShadowAuthFailure = false;
  private hasWarnedAboutLegacyProbeFailure = false;
  private hasWarnedAboutPartialDiscoveryFallback = false;
  private hasEstablishedModernAuthContext = false;
  private lastKnownDevices: SalusDevice[] = [];
  private preferredShadowVariantDescription: string | null = null;
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

    const defaults = getRegionalAwsDefaults(config.region);
    this.configuredCognitoRegion = normalizeNonEmptyString(config.cognitoRegion) ?? defaults.cognitoRegion;
    this.cognitoClientId = normalizeNonEmptyString(config.cognitoClientId) ?? defaults.cognitoClientId;
    this.configuredCognitoUserPoolId = normalizeNonEmptyString(config.cognitoUserPoolId) ?? defaults.cognitoUserPoolId;
    this.cognitoEndpoint = `https://cognito-idp.${this.configuredCognitoRegion}.amazonaws.com/`;
    this.awsIdentityPoolId = normalizeNonEmptyString(config.awsIdentityPoolId) ?? defaults.awsIdentityPoolId;
    this.awsIotRegion = normalizeNonEmptyString(config.awsIotRegion) ?? defaults.awsIotRegion;
    this.awsIotServiceName = normalizeNonEmptyString(config.awsIotServiceName) ?? DEFAULT_AWS_IOT_SERVICE;
    this.awsIotEndpointHost = normalizeAwsIotEndpointHost(config.awsIotEndpointHost ?? defaults.awsIotEndpointHost);
    this.awsIotEndpointBaseUrl = `https://${this.awsIotEndpointHost}`;
    this.configuredCompanyCode = normalizeNonEmptyString(config.companyCode) ?? null;
    this.refreshCompanyCodeCandidates();

    if (this.allowInsecureTls) {
      this.log.warn('TLS certificate validation is disabled for Salus cloud requests (allowInsecureTls=true).');
    }
    if (this.verboseLogging) {
      this.log.debug(`Salus service-api candidates: ${this.serviceApiBaseCandidates.join(', ')}`);
      this.log.debug(`Salus legacy-api candidates: ${this.legacyApiBaseCandidates.join(', ')}`);
      this.log.debug(`Salus Cognito endpoint: ${this.cognitoEndpoint}`);
      this.log.debug(`Salus Cognito user-pool id: ${this.configuredCognitoUserPoolId}`);
      this.log.debug(`Salus AWS identity-pool id: ${this.awsIdentityPoolId}`);
      this.log.debug(`Salus AWS IoT endpoint: ${this.awsIotEndpointBaseUrl} (${this.awsIotServiceName})`);
      this.log.debug(`Salus company-code candidates: ${this.companyCodeCandidates.map((candidate) => candidate ?? '<none>').join(', ')}`);
    }
  }

  public getCloudBaseUrl(): string {
    if (this.apiTransportMode === 'legacy') {
      return this.activeLegacyApiBaseUrl ?? this.legacyApiBaseCandidates[0]!;
    }
    return this.activeServiceApiBaseUrl ?? this.serviceApiBaseCandidates[0]!;
  }

  public getCachedProperties(dsn: string): SalusPropertyMap | undefined {
    return this.propertyCacheByDsn.get(canonicalizeDsn(dsn));
  }

  public getKnownDevicesSnapshot(): SalusDevice[] {
    return this.getLastKnownDevicesSnapshot();
  }

  public async refreshKnownDeviceShadows(): Promise<void> {
    const knownDevices = this.getLastKnownDevicesSnapshot();
    if (knownDevices.length === 0) {
      return;
    }
    if (this.apiTransportMode === 'legacy') {
      return;
    }
    if (this.isModernDeviceShadowBlocked()) {
      return;
    }

    try {
      const shadows = await this.fetchDeviceShadows(knownDevices);
      this.unblockModernDeviceShadows();
      if (shadows.size > 0) {
        this.mergeIntoPropertyCache(shadows);
      }
    } catch (error) {
      if (this.shouldDisableModernDeviceShadowQueries(error)) {
        this.blockModernDeviceShadows(
          `Salus cloud denied devices/device_shadows during fast refresh (${asErrorMessage(error)}).`,
        );
        return;
      }
      if (shouldTryAlternateDiscovery(error) || error instanceof LegacyFallbackRequiredError) {
        if (this.verboseLogging) {
          this.log.debug(`Fast shadow refresh degraded (${asErrorMessage(error)}).`);
        }
        return;
      }
      throw error;
    }
  }

  public async listDevices(): Promise<SalusDevice[]> {
    if (this.apiTransportMode === 'legacy') {
      try {
        const devices = await this.listDevicesLegacy();
        this.rememberLastKnownDevices(devices);
        return devices;
      } catch (error) {
        const cachedFallback = this.getLastKnownDevicesSnapshot();
        if (cachedFallback.length > 0) {
          this.log.warn(
            `Legacy discovery failed (${asErrorMessage(error)}). Continuing with ${cachedFallback.length} cached device(s).`,
          );
          return cachedFallback;
        }
        throw error;
      }
    }

    try {
      const devices = await this.listDevicesModern();
      const stabilized = this.applyPartialDiscoveryProtection(devices);
      this.rememberLastKnownDevices(stabilized);
      return stabilized;
    } catch (error) {
      if (!shouldSwitchToLegacyApi(error)) {
        const cachedFallback = this.getLastKnownDevicesSnapshot();
        if (cachedFallback.length > 0 && (error instanceof HttpStatusError || isRetriableFailure(error))) {
          this.log.warn(
            `Modern discovery failed (${asErrorMessage(error)}). Continuing with ${cachedFallback.length} cached device(s).`,
          );
          return cachedFallback;
        }
        throw error;
      }

      try {
        const devices = await this.listDevicesLegacy();
        this.switchToLegacyTransport(`Modern Salus API authorization failed: ${asErrorMessage(error)}`);
        this.hasWarnedAboutLegacyProbeFailure = false;
        this.rememberLastKnownDevices(devices);
        return devices;
      } catch (legacyError) {
        if (!this.hasWarnedAboutLegacyProbeFailure) {
          this.hasWarnedAboutLegacyProbeFailure = true;
          this.log.warn(
            `Modern discovery hit an authorization restriction (${asErrorMessage(error)}),`
            + ` but legacy compatibility probe failed (${asErrorMessage(legacyError)}). Staying on modern transport.`,
          );
        } else if (this.verboseLogging) {
          this.log.debug(`Legacy compatibility probe failed again: ${asErrorMessage(legacyError)}`);
        }

        const cachedFallback = this.getLastKnownDevicesSnapshot();
        if (cachedFallback.length > 0) {
          this.log.warn(`Continuing with ${cachedFallback.length} cached device(s) until discovery recovers.`);
          return cachedFallback;
        }

        throw new Error(
          `Modern discovery hit an authorization restriction (${asErrorMessage(error)}),`
          + ` and legacy compatibility probe failed (${asErrorMessage(legacyError)}).`,
        );
      }
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
      this.log.info(`AWS occupants discovery failed. Falling back to /devices endpoint (${asErrorMessage(error)})`);
    }

    try {
      return await this.listDevicesViaDevicesEndpoint();
    } catch (error) {
      if (lastError instanceof OccupantsDiscoveryEmptyError && error instanceof LegacyFallbackRequiredError) {
        // Tenants discovered via occupants APIs can reject /devices with 900008.
        // Keep using modern mode and report the occupants-discovery failure instead
        // of forcing an unrelated legacy fallback.
        throw lastError;
      }
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
    const inlinePropertiesFromRecords = this.hydratePropertyCacheFromDeviceRecords(devices, '/devices payload');

    if (!this.isModernDeviceShadowBlocked()) {
      try {
        const shadowPayload = await this.fetchDeviceShadows(devices);
        this.unblockModernDeviceShadows();
        if (shadowPayload.size > 0) {
          this.mergeIntoPropertyCache(shadowPayload);
          if (this.verboseLogging) {
            this.log.debug(`Hydrated property cache from devices/device_shadows for ${shadowPayload.size} device(s)`);
          }
        } else if (devices.length > 0 && inlineShadows.size === 0 && inlinePropertiesFromRecords === 0) {
          this.log.warn('No property payload was returned by devices/device_shadows. Accessory states may stay stale until Salus API responds.');
        }
      } catch (error) {
        if (this.shouldDisableModernDeviceShadowQueries(error)) {
          this.blockModernDeviceShadows(
            `Salus cloud denied devices/device_shadows (${asErrorMessage(error)}).`,
          );
        } else if (shouldTryAlternateDiscovery(error) || error instanceof LegacyFallbackRequiredError) {
          this.log.warn(`Device shadow query failed after /devices discovery (${asErrorMessage(error)}). Continuing with available data.`);
        } else {
          throw error;
        }
      }
    }

    if (this.verboseLogging) {
      this.log.debug(`Salus cloud returned ${devices.length} device(s) from /devices endpoint`);
    }

    return devices;
  }

  private async listDevicesViaOccupantsEndpoints(): Promise<SalusDevice[]> {
    const mergedShadows: Map<string, SalusPropertyMap> = new Map();
    const discoveredDevices: SalusDevice[] = [];
    const occupantsPayloads: unknown[] = [];
    const targetQueue: OccupantsSliderTarget[] = [];
    const queuedTargets = new Set<string>();
    const discoveryStartedAt = Date.now();
    this.hasWarnedAboutSliderDetailsTransientFailure = false;

    const mergeShadowsFromPayload = (payload: unknown): void => {
      const parsed = parseDeviceShadows(payload, this.deviceIdToDsn, this.deviceKeyToDsn);
      for (const [dsn, properties] of parsed) {
        const existing = mergedShadows.get(dsn);
        if (existing) {
          mergePropertyMaps(existing, properties);
        } else {
          mergedShadows.set(dsn, properties);
        }
      }
    };

    const addTargets = (targets: OccupantsSliderTarget[]): void => {
      for (const target of targets) {
        const targetId = target.id.trim();
        if (!targetId) {
          continue;
        }
        if (queuedTargets.has(targetId)) {
          continue;
        }
        queuedTargets.add(targetId);
        targetQueue.push({
          ...target,
          id: targetId,
        });
      }
    };

    let sliderListPayload: unknown | undefined;
    let lastSliderListError: unknown;
    for (const pathGroup of OCCUPANTS_SLIDER_LIST_PATH_GROUPS) {
      try {
        sliderListPayload = await this.requestServiceJsonWithPathFallback<unknown>(
          pathGroup,
          {
            method: 'GET',
            auth: true,
          },
        );
        occupantsPayloads.push(sliderListPayload);
        discoveredDevices.push(...parseDevices(sliderListPayload));
        mergeShadowsFromPayload(sliderListPayload);
        addTargets(extractOccupantsSliderTargets(sliderListPayload));
        if (discoveredDevices.length > 0 || targetQueue.length > 0) {
          break;
        }
      } catch (error) {
        lastSliderListError = error;
        if (error instanceof HttpStatusError && STATUS_ALLOW_OCCUPANTS_VARIANT_FALLBACK.has(error.status)) {
          continue;
        }
        throw error;
      }
    }

    if (sliderListPayload === undefined) {
      throw lastSliderListError ?? new OccupantsDiscoveryEmptyError('Occupants slider_list endpoint did not return data.');
    }

    if (this.verboseLogging) {
      this.log.debug(
        `Occupants slider_list produced ${discoveredDevices.length} candidate device(s) and ${targetQueue.length} slider target(s).`,
      );
    }

    const visitedTargetIds = new Set<string>();
    let processedTargetCount = 0;
    let detailTraversalTruncatedReason: string | undefined;
    while (targetQueue.length > 0) {
      if (processedTargetCount >= MAX_OCCUPANTS_DETAIL_TARGETS_PER_SYNC) {
        detailTraversalTruncatedReason = `target limit (${MAX_OCCUPANTS_DETAIL_TARGETS_PER_SYNC}) reached`;
        break;
      }
      if ((Date.now() - discoveryStartedAt) >= MAX_OCCUPANTS_DETAIL_DISCOVERY_DURATION_MS) {
        detailTraversalTruncatedReason = `time budget (${MAX_OCCUPANTS_DETAIL_DISCOVERY_DURATION_MS}ms) exhausted`;
        break;
      }

      const nextTarget = targetQueue.shift();
      if (!nextTarget) {
        continue;
      }

      const targetId = nextTarget.id.trim();
      if (!targetId || visitedTargetIds.has(targetId)) {
        continue;
      }
      visitedTargetIds.add(targetId);
      processedTargetCount += 1;

      let detailPayloads: unknown[];
      try {
        detailPayloads = await this.fetchOccupantsSliderDetailsPayloads(nextTarget);
      } catch (error) {
        if (shouldTryAlternateDiscovery(error)) {
          if (!this.hasWarnedAboutSliderDetailsTransientFailure) {
            this.hasWarnedAboutSliderDetailsTransientFailure = true;
            this.log.info(
              `Salus occupants slider_details is temporarily unavailable (${asErrorMessage(error)}).`
              + ' Continuing discovery with available slider_list/device payload data.',
            );
          } else if (this.verboseLogging) {
            this.log.debug(`Skipping transient slider_details failure for id=${targetId}: ${asErrorMessage(error)}`);
          }
          continue;
        }
        throw error;
      }
      for (const detailPayload of detailPayloads) {
        occupantsPayloads.push(detailPayload);
        discoveredDevices.push(...parseDevices(detailPayload));
        mergeShadowsFromPayload(detailPayload);
        addTargets(extractOccupantsSliderTargets(detailPayload));
      }
    }
    if (detailTraversalTruncatedReason) {
      this.log.info(
        `Occupants slider_details traversal truncated: ${detailTraversalTruncatedReason}.`
        + ` Processed ${processedTargetCount} target(s), ${targetQueue.length} target(s) deferred to next sync.`,
      );
    } else if (this.verboseLogging) {
      this.log.debug(
        `Occupants slider_details traversal completed (${processedTargetCount} targets in ${Date.now() - discoveryStartedAt}ms).`,
      );
    }

    const devices = dedupeDevicesByDsn(discoveredDevices);
    if (devices.length === 0) {
      throw new OccupantsDiscoveryEmptyError('Occupants discovery returned no devices.');
    }
    this.rebuildDeviceIndex(devices);
    const inlinePropertiesFromRecords = this.hydratePropertyCacheFromDeviceRecords(devices, 'occupants payload device records');

    // Re-parse all occupants payloads after rebuilding device id->dsn indexes.
    // Some tenants only return device_id/device_key in slider payloads.
    const indexedPayloadShadows: Map<string, SalusPropertyMap> = new Map();
    for (const payload of occupantsPayloads) {
      const parsed = parseDeviceShadows(payload, this.deviceIdToDsn, this.deviceKeyToDsn);
      for (const [dsn, properties] of parsed) {
        const existing = indexedPayloadShadows.get(dsn);
        if (existing) {
          mergePropertyMaps(existing, properties);
        } else {
          indexedPayloadShadows.set(dsn, properties);
        }
      }
    }
    for (const [dsn, properties] of indexedPayloadShadows) {
      const existing = mergedShadows.get(dsn);
      if (existing) {
        mergePropertyMaps(existing, properties);
      } else {
        mergedShadows.set(dsn, properties);
      }
    }

    if (mergedShadows.size > 0) {
      this.mergeIntoPropertyCache(mergedShadows);
      if (this.verboseLogging) {
        this.log.debug(`Hydrated property cache from occupants payload for ${mergedShadows.size} device(s)`);
      }
    }

    if (!this.isModernDeviceShadowBlocked()) {
      try {
        const shadowPayload = await this.fetchDeviceShadows(devices);
        this.unblockModernDeviceShadows();
        if (shadowPayload.size > 0) {
          this.mergeIntoPropertyCache(shadowPayload);
          if (this.verboseLogging) {
            this.log.debug(`Hydrated property cache from devices/device_shadows for ${shadowPayload.size} device(s)`);
          }
        } else if (devices.length > 0 && mergedShadows.size === 0 && inlinePropertiesFromRecords === 0) {
          this.log.warn('No property payload was returned by devices/device_shadows. Accessory states may stay stale until Salus API responds.');
        }
      } catch (error) {
        if (this.shouldDisableModernDeviceShadowQueries(error)) {
          this.blockModernDeviceShadows(
            `Salus cloud denied devices/device_shadows (${asErrorMessage(error)}).`,
          );
        } else if (shouldTryAlternateDiscovery(error) || error instanceof LegacyFallbackRequiredError) {
          this.log.warn(`Device shadow query failed after occupants discovery (${asErrorMessage(error)}). Continuing with available data.`);
        } else {
          throw error;
        }
      }
    }

    if (this.verboseLogging) {
      this.log.debug(`Salus cloud returned ${devices.length} device(s) from occupants endpoints`);
    }

    return devices;
  }

  private async fetchOccupantsSliderDetailsPayloads(target: OccupantsSliderTarget): Promise<unknown[]> {
    const normalizedTargetId = target.id.trim();
    if (!normalizedTargetId) {
      return [];
    }

    if (this.isAllSliderDetailsBlocked()) {
      return [];
    }

    if (this.isSliderDetailsTargetBlocked(normalizedTargetId)) {
      return [];
    }

    const payloads: unknown[] = [];
    const pathGroups = buildSliderDetailsPathGroups(target.id, target.typeHints);
    let lastError: unknown;
    let sawAuthRestriction = false;

    for (const pathGroup of pathGroups) {
      try {
        const payload = await this.requestServiceJsonWithPathFallback<unknown>(
          pathGroup,
          {
            method: 'GET',
            auth: true,
            allow401Refresh: false,
            allowCompanyCodeRotation: false,
            activeServiceBaseOnly: true,
            maxAttempts: 1,
          },
        );
        payloads.push(payload);

        if (parseDevices(payload).length > 0) {
          this.unblockSliderDetailsTarget(normalizedTargetId);
          this.unblockAllSliderDetails();
          return payloads;
        }
      } catch (error) {
        lastError = error;
        if (error instanceof LegacyFallbackRequiredError
          || (error instanceof HttpStatusError && (error.status === 401 || error.status === 403))) {
          sawAuthRestriction = true;
          if (this.verboseLogging) {
            this.log.debug(
              `Restricted /occupants/slider_details target id=${normalizedTargetId}`
              + ` for path variant ${pathGroup[0] ?? '<unknown>'}: ${asErrorMessage(error)}`,
            );
          }
          break;
        }
        if (error instanceof HttpStatusError && STATUS_ALLOW_OCCUPANTS_VARIANT_FALLBACK.has(error.status)) {
          continue;
        }
        throw error;
      }
    }

    if (payloads.length > 0) {
      this.unblockSliderDetailsTarget(normalizedTargetId);
      this.unblockAllSliderDetails();
      return payloads;
    }

    if (sawAuthRestriction) {
      this.blockSliderDetailsTarget(normalizedTargetId);
      this.blockAllSliderDetails();
      if (!this.hasWarnedAboutSliderDetailsAuthFailure) {
        this.hasWarnedAboutSliderDetailsAuthFailure = true;
        this.log.info(
          `Salus cloud denied /occupants/slider_details for id=${normalizedTargetId}.`
          + ' Continuing with slider_list discovery only and pausing slider_details for'
          + ` ${Math.round(SLIDER_DETAILS_BLOCK_TTL_MS / 60_000)} minutes.`,
        );
      } else if (this.verboseLogging) {
        this.log.debug(`Temporarily skipping restricted /occupants/slider_details target id=${normalizedTargetId}.`);
      }
      return [];
    }

    if (lastError instanceof HttpStatusError && STATUS_ALLOW_OCCUPANTS_VARIANT_FALLBACK.has(lastError.status)) {
      return [];
    }

    if (lastError) {
      throw lastError;
    }

    return [];
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
    const inlinePropertiesFromRecords = this.hydratePropertyCacheFromDeviceRecords(devices, 'legacy /apiv1/devices payload');

    const inlineShadows = parseDeviceShadows(payload, this.deviceIdToDsn, this.deviceKeyToDsn);
    if (inlineShadows.size > 0) {
      this.mergeIntoPropertyCache(inlineShadows);
      if (this.verboseLogging) {
        this.log.debug(`Hydrated property cache from legacy /apiv1/devices response for ${inlineShadows.size} device(s)`);
      }
    } else if (inlinePropertiesFromRecords > 0 && this.verboseLogging) {
      this.log.debug(`Legacy payload contained inline properties for ${inlinePropertiesFromRecords} device(s).`);
    }

    if (this.verboseLogging) {
      this.log.debug(`Salus legacy cloud returned ${devices.length} device(s)`);
    }

    return devices;
  }

  public async listProperties(dsn: string): Promise<SalusPropertyMap> {
    if (this.apiTransportMode === 'legacy') {
      try {
        return await this.listPropertiesLegacy(dsn);
      } catch (error) {
        const cachedFallback = this.propertyCacheByDsn.get(canonicalizeDsn(dsn));
        if (cachedFallback) {
          if (this.verboseLogging) {
            this.log.debug(`Legacy property sync failed for ${dsn}; returning cached values (${asErrorMessage(error)}).`);
          }
          return cachedFallback;
        }
        throw error;
      }
    }

    try {
      return await this.listPropertiesModern(dsn);
    } catch (error) {
      if (!shouldSwitchToLegacyApi(error)) {
        throw error;
      }

      this.blockModernDeviceShadows(
        `Salus cloud denied direct property sync for ${dsn} (${asErrorMessage(error)}).`,
      );
      const cachedAfterFailure = this.propertyCacheByDsn.get(canonicalizeDsn(dsn));
      if (cachedAfterFailure) {
        if (this.verboseLogging) {
          this.log.debug(`Using cached properties for ${dsn} after restricted property sync (${asErrorMessage(error)}).`);
        }
        return cachedAfterFailure;
      }

      return new Map();
    }
  }

  private async listPropertiesModern(dsn: string): Promise<SalusPropertyMap> {
    const dsnKey = canonicalizeDsn(dsn);
    if (this.isModernDeviceShadowBlocked()) {
      return this.propertyCacheByDsn.get(dsnKey) ?? new Map();
    }

    const shadows = await this.fetchDeviceShadows([], [dsn]);
    this.unblockModernDeviceShadows();
    const fromFetch = shadows.get(dsn)
      ?? shadows.get(dsnKey)
      ?? [...shadows.entries()].find(([candidateDsn]) => canonicalizeDsn(candidateDsn) === dsnKey)?.[1];
    if (fromFetch) {
      this.propertyCacheByDsn.set(dsnKey, fromFetch);
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
      this.propertyCacheByDsn.set(canonicalizeDsn(dsn), parsed);
      return parsed;
    }

    if (this.verboseLogging) {
      this.log.debug(`No legacy cloud property payload found for dsn=${dsn}. Returning empty property map.`);
    }

    return new Map();
  }

  public async setDatapoint(dsn: string, propertyName: string, value: unknown): Promise<void> {
    await this.setDatapoints(dsn, { [propertyName]: value });
  }

  public async setDatapoints(dsn: string, properties: Record<string, unknown>): Promise<void> {
    const normalizedEntries = Object.entries(properties).filter(([name]) => normalizeNonEmptyString(name) !== undefined);
    if (normalizedEntries.length === 0) {
      throw new Error(`No datapoints were provided for ${dsn}.`);
    }

    if (this.apiTransportMode === 'legacy') {
      for (const [propertyName, value] of normalizedEntries) {
        await this.setDatapointLegacy(dsn, propertyName, value);
      }
      return;
    }

    try {
      if (normalizedEntries.length === 1) {
        const [propertyName, value] = normalizedEntries[0]!;
        await this.setDatapointModern(dsn, propertyName, value);
      } else {
        await this.setDatapointsModern(dsn, Object.fromEntries(normalizedEntries));
      }
      return;
    } catch (error) {
      if (!shouldSwitchToLegacyApi(error)) {
        throw error;
      }

      const summary = normalizedEntries.map(([name]) => name).join(', ');
      const reason = `Modern Salus datapoint write failed for ${dsn} (${summary}): ${asErrorMessage(error)}`;
      try {
        for (const [propertyName, value] of normalizedEntries) {
          await this.setDatapointLegacy(dsn, propertyName, value);
        }
        this.switchToLegacyTransport(reason);
      } catch (legacyError) {
        throw new Error(`${reason}. Legacy compatibility write probe failed: ${asErrorMessage(legacyError)}`);
      }
    }
  }

  private async setDatapointsModern(dsn: string, properties: Record<string, unknown>): Promise<void> {
    const failures: string[] = [];

    try {
      await this.setDatapointsViaAwsIotMqttShadow(dsn, properties);
      for (const [propertyName, value] of Object.entries(properties)) {
        this.updateCachedProperty(dsn, propertyName, value);
      }
      if (this.verboseLogging) {
        this.log.debug(`Write succeeded via AWS IoT MQTT shadow publish for ${dsn}`);
      }
      return;
    } catch (error) {
      failures.push(`AWS IoT MQTT shadow publish -> ${asErrorMessage(error)}`);
      if (this.verboseLogging) {
        this.log.debug(`MQTT batch write failed for ${dsn}: ${asErrorMessage(error)}. Falling back to HTTP IoT shadow update.`);
      }
    }

    try {
      await this.setDatapointsViaAwsIotShadow(dsn, properties);
      for (const [propertyName, value] of Object.entries(properties)) {
        this.updateCachedProperty(dsn, propertyName, value);
      }
      if (this.verboseLogging) {
        this.log.debug(`Write succeeded via AWS IoT HTTP shadow update for ${dsn}`);
      }
      return;
    } catch (error) {
      failures.push(`AWS IoT HTTP shadow update -> ${asErrorMessage(error)}`);
      if (this.verboseLogging) {
        this.log.debug(`HTTP IoT batch write failed for ${dsn}: ${asErrorMessage(error)}. Falling back to service-api compatibility write.`);
      }
    }

    try {
      await this.setDatapointsViaServiceApiBulk(dsn, properties);
      for (const [propertyName, value] of Object.entries(properties)) {
        this.updateCachedProperty(dsn, propertyName, value);
      }
      if (this.verboseLogging) {
        this.log.debug(`Write succeeded via service-api compatibility bulk write for ${dsn}`);
      }
      return;
    } catch (error) {
      failures.push(`service-api compatibility bulk write -> ${asErrorMessage(error)}`);
      throw new Error(`Failed to write datapoint batch for ${dsn}. Attempts: ${failures.join(' | ')}`);
    }
  }

  private async setDatapointModern(dsn: string, propertyName: string, value: unknown): Promise<void> {
    const failures: string[] = [];

    try {
      const mqttAttemptDescription = 'AWS IoT MQTT shadow publish';
      await this.setDatapointsViaAwsIotMqttShadow(dsn, { [propertyName]: value });
      this.updateCachedProperty(dsn, propertyName, value);
      if (this.verboseLogging) {
        this.log.debug(`Write succeeded via ${mqttAttemptDescription}`);
      }
      return;
    } catch (error) {
      failures.push(`AWS IoT MQTT shadow publish -> ${asErrorMessage(error)}`);
      if (this.verboseLogging) {
        this.log.debug(`MQTT write failed for ${dsn}/${propertyName}: ${asErrorMessage(error)}. Falling back to HTTP IoT shadow update.`);
      }
    }

    const iotAttemptDescription = 'AWS IoT HTTP shadow update';
    try {
      await this.setDatapointViaAwsIotShadow(dsn, propertyName, value);
      this.updateCachedProperty(dsn, propertyName, value);
      if (this.verboseLogging) {
        this.log.debug(`Write succeeded via ${iotAttemptDescription}`);
      }
      return;
    } catch (error) {
      const failureMessage = error instanceof HttpStatusError
        ? `${iotAttemptDescription} -> HTTP ${error.status}`
        : `${iotAttemptDescription} -> ${asErrorMessage(error)}`;
      failures.push(failureMessage);
      if (this.verboseLogging) {
        this.log.debug(`AWS IoT write failed for ${dsn}/${propertyName}: ${asErrorMessage(error)}. Falling back to service-api compatibility write.`);
      }
    }

    try {
      await this.setDatapointsViaServiceApiBulk(dsn, { [propertyName]: value });
      this.updateCachedProperty(dsn, propertyName, value);
      if (this.verboseLogging) {
        this.log.debug('Write succeeded via service-api compatibility bulk write');
      }
      return;
    } catch (error) {
      failures.push(`service-api compatibility bulk write -> ${asErrorMessage(error)}`);
      throw new Error(`Failed to write property ${propertyName} on ${dsn}. Attempts: ${failures.join(' | ')}`);
    }
  }

  private async setDatapointsViaServiceApiBulk(dsn: string, properties: Record<string, unknown>): Promise<void> {
    const payload = {
      devices: [
        {
          dsn,
          properties: Object.entries(properties).map(([name, value]) => ({
            name,
            value,
          })),
        },
      ],
    };
    await this.requestServiceJson('/devices/bulk', {
      method: 'POST',
      body: payload,
      auth: true,
      expectedStatuses: DEFAULT_EXPECTED_STATUSES,
    });
  }

  private async setDatapointViaAwsIotShadow(dsn: string, propertyName: string, value: unknown): Promise<void> {
    await this.setDatapointsViaAwsIotShadow(dsn, { [propertyName]: value });
  }

  private async setDatapointsViaAwsIotShadow(dsn: string, properties: Record<string, unknown>): Promise<void> {
    const firstPropertyName = normalizeNonEmptyString(Object.keys(properties)[0]);
    if (!firstPropertyName) {
      throw new Error(`Cannot send AWS IoT shadow update for ${dsn}: no properties were provided.`);
    }

    const context = await this.resolveShadowWriteContextForDatapoint(dsn, firstPropertyName);
    const propertyUpdates: Record<string, unknown> = {};
    for (const [propertyName, value] of Object.entries(properties)) {
      for (const variant of this.buildShadowPropertyWriteVariants(propertyName)) {
        propertyUpdates[variant] = value;
      }
    }

    const desired: Record<string, unknown> = {};

    if (context.includeRootProperties) {
      desired.properties = propertyUpdates;
    }
    for (const branchKey of context.branchKeys) {
      desired[branchKey] = {
        properties: propertyUpdates,
      };
    }

    if (Object.keys(desired).length === 0) {
      desired['11'] = {
        properties: propertyUpdates,
      };
    }

    if (this.verboseLogging) {
      this.log.debug(
        `AWS IoT write context for ${dsn}: branches=[${context.branchKeys.join(', ')}], `
        + `rootProperties=${context.includeRootProperties}, properties=[${Object.keys(propertyUpdates).join(', ')}]`,
      );
    }

    await this.requestAwsIotShadowUpdate(dsn, { state: { desired } });
  }

  private async setDatapointsViaAwsIotMqttShadow(dsn: string, properties: Record<string, unknown>): Promise<void> {
    const firstPropertyName = normalizeNonEmptyString(Object.keys(properties)[0]);
    if (!firstPropertyName) {
      throw new Error(`Cannot publish AWS IoT MQTT shadow update for ${dsn}: no properties were provided.`);
    }

    const context = await this.resolveShadowWriteContextForDatapoint(dsn, firstPropertyName);
    const propertyUpdates: Record<string, unknown> = {};
    for (const [propertyName, value] of Object.entries(properties)) {
      for (const variant of this.buildShadowPropertyWriteVariants(propertyName)) {
        propertyUpdates[variant] = value;
      }
    }

    const desired: Record<string, unknown> = {};
    if (context.includeRootProperties) {
      desired.properties = propertyUpdates;
    }
    for (const branchKey of context.branchKeys) {
      desired[branchKey] = {
        properties: propertyUpdates,
      };
    }
    if (Object.keys(desired).length === 0) {
      desired['11'] = {
        properties: propertyUpdates,
      };
    }

    const payloadText = JSON.stringify({ state: { desired } });
    const topic = `$aws/things/${dsn}/shadow/update`;
    const totalAttempts = this.maxRetries + 1;
    let lastError: unknown = new Error(`No AWS IoT MQTT response received for ${dsn}`);
    let forceCredentialRefresh = false;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      try {
        const credentials = await this.ensureAwsIotCredentials(forceCredentialRefresh);
        forceCredentialRefresh = false;
        const mqttUrl = this.buildAwsIotMqttWebsocketUrl(credentials);
        await this.publishAwsIotMqttShadowUpdate(topic, payloadText, this.resolveGatewayThingCodeForDsn(dsn), mqttUrl);
        if (this.verboseLogging) {
          this.log.debug(`AWS IoT MQTT shadow publish succeeded for ${dsn}`);
        }
        return;
      } catch (error) {
        lastError = error;
        if (isMqttUnauthorizedError(error)) {
          this.awsIotCredentials = null;
          this.awsIdentityId = null;
          forceCredentialRefresh = true;
        }
        if (attempt < totalAttempts && (forceCredentialRefresh || isMqttRetryableError(error))) {
          await this.retryDelay(attempt, `AWS IoT MQTT shadow publish failed: ${asErrorMessage(error)}`);
          continue;
        }
        throw error;
      }
    }

    throw new Error(`AWS IoT MQTT shadow publish exhausted retries for ${dsn}: ${asErrorMessage(lastError)}`);
  }

  private buildAwsIotMqttWebsocketUrl(credentials: AwsIotCredentials): string {
    const now = new Date();
    const amzDate = formatAwsAmzDate(now);
    const dateStamp = formatAwsDateStamp(now);
    const serviceName = DEFAULT_AWS_IOT_SERVICE;
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${this.awsIotRegion}/${serviceName}/aws4_request`;

    const queryParams: Array<[string, string]> = [
      ['X-Amz-Algorithm', algorithm],
      ['X-Amz-Credential', `${credentials.accessKeyId}/${credentialScope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-SignedHeaders', 'host'],
    ];
    const canonicalQueryString = queryParams
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${awsPercentEncode(key)}=${awsPercentEncode(value)}`)
      .join('&');

    const canonicalRequest = [
      'GET',
      '/mqtt',
      canonicalQueryString,
      `host:${this.awsIotEndpointHost}\n`,
      'host',
      sha256Hex(''),
    ].join('\n');

    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = deriveAwsSigningKey(credentials.secretAccessKey, dateStamp, this.awsIotRegion, serviceName);
    const signature = hmacSha256Hex(signingKey, stringToSign);
    let signedQueryString = `${canonicalQueryString}&X-Amz-Signature=${signature}`;

    // Match the proven salus-it600-cloud behavior: append session token after signing.
    signedQueryString += `&X-Amz-Security-Token=${awsPercentEncode(credentials.sessionToken)}`;
    return `wss://${this.awsIotEndpointHost}/mqtt?${signedQueryString}`;
  }

  private async publishAwsIotMqttShadowUpdate(
    topic: string,
    payloadText: string,
    gatewayThingCode: string | undefined,
    url: string,
  ): Promise<void> {
    const connectTimeoutMs = Math.max(MQTT_MIN_CONNECT_TIMEOUT_MS, this.requestTimeoutMs);
    const clientIdPrefix = sanitizeMqttClientIdSegment(gatewayThingCode ?? 'homebridge-salus-cloud');
    const clientId = `${clientIdPrefix}-${crypto.randomUUID()}`;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeout: NodeJS.Timeout | null = null;
      let client: mqtt.MqttClient | null = null;
      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        if (client) {
          client.removeListener('connect', onConnect);
          client.removeListener('error', onError);
          client.removeListener('close', onClose);
          client.removeListener('offline', onOffline);
          try {
            client.end(true);
          } catch {
            // Ignore close failures in cleanup path.
          }
        }
      };
      const finish = (error?: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();

        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        resolve();
      };

      const onConnect = () => {
        const activeClient = client;
        if (!activeClient) {
          finish(new Error('MQTT client was not initialized before connect callback.'));
          return;
        }
        activeClient.publish(topic, payloadText, { qos: 1 }, (error) => {
          if (error) {
            finish(new Error(`MQTT publish failed on ${topic}: ${asErrorMessage(error)}`));
            return;
          }
          finish();
        });
      };

      const onError = (error: unknown) => {
        finish(new Error(`MQTT connection error: ${asErrorMessage(error)}`));
      };

      const onClose = () => {
        if (settled) {
          return;
        }
        finish(new Error('MQTT connection closed before publish acknowledgement.'));
      };

      const onOffline = () => {
        if (settled) {
          return;
        }
        finish(new Error('MQTT connection went offline before publish acknowledgement.'));
      };

      timeout = setTimeout(() => {
        finish(new Error(`MQTT publish timed out after ${connectTimeoutMs}ms.`));
      }, connectTimeoutMs);

      try {
        client = mqtt.connect(url, {
          clientId,
          protocolVersion: 4,
          clean: true,
          resubscribe: false,
          keepalive: 60,
          reconnectPeriod: 0,
          connectTimeout: connectTimeoutMs,
          rejectUnauthorized: !this.allowInsecureTls,
          wsOptions: {
            headers: {
              'Sec-WebSocket-Protocol': 'mqtt',
            },
          },
        });
      } catch (error) {
        finish(new Error(`MQTT connection initialization failed: ${asErrorMessage(error)}`));
        return;
      }

      client.on('connect', onConnect);
      client.on('error', onError);
      client.on('close', onClose);
      client.on('offline', onOffline);
    });
  }

  private resolveGatewayThingCodeForDsn(dsn: string): string | undefined {
    const fromTarget = extractGatewayThingCodeFromDsn(dsn);
    if (fromTarget) {
      return fromTarget;
    }

    for (const mappedDsn of this.deviceIdToDsn.values()) {
      const candidate = extractGatewayThingCodeFromDsn(mappedDsn);
      if (candidate) {
        return candidate;
      }
    }

    for (const device of this.lastKnownDevices) {
      const candidate = extractGatewayThingCodeFromDsn(device.dsn);
      if (candidate) {
        return candidate;
      }
    }

    return undefined;
  }

  private async resolveShadowWriteContextForDatapoint(dsn: string, propertyName: string): Promise<AwsShadowWriteContext> {
    const dsnKey = canonicalizeDsn(dsn);
    const branchKeys = new Set<string>();
    let includeRootProperties = false;

    const shortId = this.extractShadowShortIdFromDsn(dsn);
    if (shortId) {
      branchKeys.add(shortId);
    }

    const cachedBaseKey = this.shadowBaseKeyByDsn.get(dsnKey);
    if (cachedBaseKey) {
      branchKeys.add(cachedBaseKey);
    }

    try {
      const payload = await this.requestServiceJson('/devices/device_shadows', {
        method: 'POST',
        body: { device_codes: [dsn] },
        auth: true,
        activeServiceBaseOnly: true,
      });

      this.updateShadowBaseKeyCache(payload, propertyName);

      const discovered = this.discoverShadowWriteContextFromPayload(payload, dsn);
      includeRootProperties = discovered.includeRootProperties;
      for (const key of discovered.branchKeys) {
        branchKeys.add(key);
      }
    } catch (error) {
      if (this.verboseLogging) {
        this.log.debug(`Unable to resolve shadow write context via /devices/device_shadows for ${dsn}: ${asErrorMessage(error)}`);
      }
    }

    const resolvedBaseKey = this.shadowBaseKeyByDsn.get(dsnKey);
    if (resolvedBaseKey) {
      branchKeys.add(resolvedBaseKey);
    }

    if (branchKeys.size === 0 && !includeRootProperties) {
      branchKeys.add('11');
    }

    return {
      branchKeys: [...branchKeys],
      includeRootProperties,
    };
  }

  private discoverShadowWriteContextFromPayload(
    payload: unknown,
    dsn: string,
  ): { branchKeys: string[]; includeRootProperties: boolean } {
    const branchKeys = new Set<string>();
    const queue: unknown[] = [payload];
    const visited = new Set<unknown>();
    const matchedDesiredCandidates: Record<string, unknown>[] = [];
    const genericDesiredCandidates: Record<string, unknown>[] = [];
    let includeRootProperties = false;

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || current === null) {
        continue;
      }

      if (typeof current === 'string') {
        const parsed = parseJsonRecord(current);
        if (parsed) {
          queue.push(parsed);
        }
        continue;
      }

      if (typeof current !== 'object') {
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
      const desiredCandidates = this.extractShadowDesiredContainersFromRecord(record);
      if (desiredCandidates.length > 0) {
        const inferredDsn = inferShadowDsn(record, this.deviceIdToDsn, this.deviceKeyToDsn);
        if (inferredDsn && inferredDsn === dsn) {
          matchedDesiredCandidates.push(...desiredCandidates);
        } else {
          genericDesiredCandidates.push(...desiredCandidates);
        }
      }

      for (const value of Object.values(record)) {
        if (typeof value === 'string') {
          const parsed = parseJsonRecord(value);
          if (parsed) {
            queue.push(parsed);
          }
          continue;
        }
        if (value && typeof value === 'object') {
          queue.push(value);
        }
      }
    }

    const desiredCandidates = matchedDesiredCandidates.length > 0
      ? matchedDesiredCandidates
      : genericDesiredCandidates;

    for (const desired of desiredCandidates) {
      if (asRecord(desired.properties)) {
        includeRootProperties = true;
      }

      for (const [key, rawValue] of Object.entries(desired)) {
        const valueRecord = asRecord(rawValue);
        if (!valueRecord) {
          continue;
        }

        const properties = extractShadowPropertiesContainer(valueRecord);
        if (!properties) {
          continue;
        }
        branchKeys.add(key);
      }
    }

    return {
      branchKeys: [...branchKeys],
      includeRootProperties,
    };
  }

  private extractShadowDesiredContainersFromRecord(record: Record<string, unknown>): Record<string, unknown>[] {
    const containers: Record<string, unknown>[] = [];
    const addContainer = (candidate: unknown): void => {
      const container = asRecord(candidate);
      if (container) {
        containers.push(container);
      }
    };

    addContainer(record.desired);

    const stateRecord = asRecord(record.state);
    if (stateRecord) {
      addContainer(stateRecord.desired);
    }

    const shadowRecord = asRecord(record.shadow);
    if (shadowRecord) {
      addContainer(shadowRecord.desired);
      const shadowState = asRecord(shadowRecord.state);
      if (shadowState) {
        addContainer(shadowState.desired);
      }
    } else if (typeof record.shadow === 'string') {
      const parsedShadow = parseJsonRecord(record.shadow);
      if (parsedShadow) {
        addContainer(parsedShadow.desired);
        const parsedState = asRecord(parsedShadow.state);
        if (parsedState) {
          addContainer(parsedState.desired);
        }
      }
    }

    const deviceShadowRecord = asRecord(record.device_shadow);
    if (deviceShadowRecord) {
      addContainer(deviceShadowRecord.desired);
      const deviceShadowState = asRecord(deviceShadowRecord.state);
      if (deviceShadowState) {
        addContainer(deviceShadowState.desired);
      }
    } else if (typeof record.device_shadow === 'string') {
      const parsedShadow = parseJsonRecord(record.device_shadow);
      if (parsedShadow) {
        addContainer(parsedShadow.desired);
        const parsedState = asRecord(parsedShadow.state);
        if (parsedState) {
          addContainer(parsedState.desired);
        }
      }
    }

    return containers;
  }

  private buildShadowPropertyWriteVariants(propertyName: string): string[] {
    const variants = new Set<string>([propertyName]);
    const endpointMatch = propertyName.match(/^ep_?(\d+):(.*)$/);
    if (endpointMatch) {
      const endpoint = endpointMatch[1]!;
      const remainder = endpointMatch[2]!;
      variants.add(`ep${endpoint}:${remainder}`);
      variants.add(`ep_${endpoint}:${remainder}`);
    }
    return [...variants];
  }

  private extractShadowShortIdFromDsn(dsn: string): string | undefined {
    const segments = dsn.split('-');
    const last = normalizeNonEmptyString(segments[segments.length - 1]);
    if (!last) {
      return undefined;
    }
    if (!/^[A-Za-z0-9_]{8,}$/.test(last)) {
      return undefined;
    }
    return last.toLowerCase();
  }

  private updateShadowBaseKeyCache(payload: unknown, propertyNameHint?: string): void {
    const mappings = parseDeviceShadowBaseKeys(payload, this.deviceIdToDsn, this.deviceKeyToDsn, propertyNameHint);
    for (const [dsn, baseKey] of mappings) {
      this.shadowBaseKeyByDsn.set(canonicalizeDsn(dsn), baseKey);
    }
  }

  private async ensureAwsIotCredentials(forceRefresh = false): Promise<AwsIotCredentials> {
    if (!forceRefresh && this.awsIotCredentials && Date.now() + AWS_IOT_CREDENTIAL_REFRESH_SAFETY_MS < this.awsIotCredentials.expiresAtEpochMs) {
      return this.awsIotCredentials;
    }

    await this.ensureLoggedIn();
    if (!this.session) {
      throw new Error('Missing Salus session while requesting AWS IoT credentials.');
    }

    const cognitoRegion = this.session.cognitoRegion ?? this.configuredCognitoRegion;
    const userPoolId = this.session.userPoolId ?? this.configuredCognitoUserPoolId;
    if (!cognitoRegion || !userPoolId) {
      throw new Error('Unable to resolve Cognito provider information required for AWS IoT writes.');
    }
    const identityRegion = parseIdentityPoolRegion(this.awsIdentityPoolId) ?? cognitoRegion;
    const provider = `cognito-idp.${cognitoRegion}.amazonaws.com/${userPoolId}`;
    const idToken = this.session.idToken;

    const resolveIdentityId = async (): Promise<string> => {
      const identityPayload = await this.requestCognitoIdentityJson(identityRegion, COGNITO_IDENTITY_GET_ID_TARGET, {
        IdentityPoolId: this.awsIdentityPoolId,
        Logins: {
          [provider]: idToken,
        },
      });
      const identityRecord = asRecord(identityPayload);
      const identityId = normalizeNonEmptyString(asString(identityRecord?.IdentityId));
      if (!identityId) {
        throw new Error('Cognito Identity GetId did not return IdentityId.');
      }
      return identityId;
    };

    const identityId = forceRefresh || !this.awsIdentityId
      ? await resolveIdentityId()
      : this.awsIdentityId;
    this.awsIdentityId = identityId;

    let credentialsPayload = await this.requestCognitoIdentityJson(identityRegion, COGNITO_IDENTITY_GET_CREDENTIALS_TARGET, {
      IdentityId: identityId,
      Logins: {
        [provider]: idToken,
      },
    });
    let credentials = parseAwsIotCredentials(credentialsPayload);

    if (!credentials && !forceRefresh) {
      this.awsIdentityId = await resolveIdentityId();
      credentialsPayload = await this.requestCognitoIdentityJson(identityRegion, COGNITO_IDENTITY_GET_CREDENTIALS_TARGET, {
        IdentityId: this.awsIdentityId,
        Logins: {
          [provider]: idToken,
        },
      });
      credentials = parseAwsIotCredentials(credentialsPayload);
    }

    if (!credentials) {
      throw new Error('Cognito Identity GetCredentialsForIdentity did not return temporary AWS credentials.');
    }

    this.awsIotCredentials = credentials;
    return credentials;
  }

  private async requestCognitoIdentityJson(
    identityRegion: string,
    target: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const endpoint = `https://cognito-identity.${identityRegion}.amazonaws.com/`;
    const totalAttempts = this.maxRetries + 1;
    let lastError: unknown = new Error(`No Cognito Identity response received for ${target}`);

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      try {
        const response = await this.fetchWithTimeout(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/x-amz-json-1.1',
            'Content-Type': 'application/x-amz-json-1.1',
            'X-Amz-Target': target,
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const responseText = await safeReadText(response);
          const error = new HttpStatusError(
            responseText
              ? `Cognito Identity ${target} failed (HTTP ${response.status}) :: ${responseText}`
              : `Cognito Identity ${target} failed (HTTP ${response.status})`,
            response.status,
            responseText,
          );
          if (isRetriableStatus(response.status) && attempt < totalAttempts) {
            lastError = error;
            await this.retryDelay(attempt, error.message);
            continue;
          }
          throw error;
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

    throw new Error(`Cognito Identity ${target} failed after retries: ${asErrorMessage(lastError)}`);
  }

  private async requestAwsIotShadowUpdate(dsn: string, payload: Record<string, unknown>): Promise<void> {
    const payloadText = JSON.stringify(payload);
    const thingShadowPath = `/things/${encodeURIComponent(dsn)}/shadow`;
    const expectedStatuses = DEFAULT_EXPECTED_STATUSES;
    const totalAttempts = this.maxRetries + 1;
    const serviceCandidates = dedupeStringArray([this.awsIotServiceName, 'iotdata']);
    let lastError: unknown = new Error(`No AWS IoT response received for ${dsn}`);
    let hasRefreshedCredentialsAfterUnauthorized = false;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      let sawRetriableFailure = false;
      let lastRetriableError: unknown;
      const credentials = await this.ensureAwsIotCredentials(hasRefreshedCredentialsAfterUnauthorized);

      for (let serviceIndex = 0; serviceIndex < serviceCandidates.length; serviceIndex++) {
        const serviceName = serviceCandidates[serviceIndex]!;
        try {
          const headers = this.buildAwsIotSigV4Headers(
            'POST',
            thingShadowPath,
            payloadText,
            serviceName,
            credentials,
          );
          const response = await this.fetchWithTimeout(`${this.awsIotEndpointBaseUrl}${thingShadowPath}`, {
            method: 'POST',
            headers,
            body: payloadText,
          });

          if (expectedStatuses.includes(response.status)) {
            if (this.verboseLogging) {
              this.log.debug(`AWS IoT shadow update succeeded for ${dsn} via service=${serviceName}`);
            }
            return;
          }

          const responseText = await safeReadText(response);
          const statusError = new HttpStatusError(
            responseText
              ? `AWS IoT shadow update failed (HTTP ${response.status}) via service=${serviceName} on ${thingShadowPath} :: ${responseText}`
              : `AWS IoT shadow update failed (HTTP ${response.status}) via service=${serviceName} on ${thingShadowPath}`,
            response.status,
            responseText,
          );
          lastError = statusError;

          if ((response.status === 400 || response.status === 403) && serviceIndex < serviceCandidates.length - 1) {
            if (this.verboseLogging) {
              this.log.debug(
                `AWS IoT write rejected via service=${serviceName} (HTTP ${response.status}); trying next signing service candidate.`,
              );
            }
            continue;
          }

          if ((response.status === 401 || response.status === 403) && !hasRefreshedCredentialsAfterUnauthorized) {
            hasRefreshedCredentialsAfterUnauthorized = true;
            this.awsIotCredentials = null;
            this.awsIdentityId = null;
            sawRetriableFailure = true;
            lastRetriableError = statusError;
            break;
          }

          if (isRetriableStatus(response.status)) {
            sawRetriableFailure = true;
            lastRetriableError = statusError;
            break;
          }

          throw statusError;
        } catch (error) {
          if (!this.allowInsecureTls && isTlsCertificateError(error)) {
            const message = `${asErrorMessage(error)}. If Salus cloud certificate is invalid, set "allowInsecureTls": true in plugin config.`;
            throw new Error(message);
          }

          if (isRetriableFailure(error)) {
            lastError = error;
            sawRetriableFailure = true;
            lastRetriableError = error;
            break;
          }

          throw error;
        }
      }

      if (attempt < totalAttempts && sawRetriableFailure) {
        await this.retryDelay(attempt, asErrorMessage(lastRetriableError ?? lastError));
        continue;
      }

      if (lastError) {
        throw lastError;
      }
    }

    throw new Error(`AWS IoT shadow update exhausted retries for ${dsn}: ${asErrorMessage(lastError)}`);
  }

  private buildAwsIotSigV4Headers(
    method: HttpMethod,
    path: string,
    payload: string,
    serviceName: string,
    credentials: AwsIotCredentials,
  ): Record<string, string> {
    const now = new Date();
    const amzDate = formatAwsAmzDate(now);
    const dateStamp = formatAwsDateStamp(now);
    const payloadHash = sha256Hex(payload);
    const host = this.awsIotEndpointHost;

    const canonicalHeaders = [
      ['content-type', 'application/json'],
      ['host', host],
      ['x-amz-content-sha256', payloadHash],
      ['x-amz-date', amzDate],
      ['x-amz-security-token', credentials.sessionToken],
    ] as const;
    const signedHeaders = canonicalHeaders.map(([name]) => name).join(';');
    const canonicalRequest = [
      method,
      path,
      '',
      canonicalHeaders.map(([name, value]) => `${name}:${value}`).join('\n') + '\n',
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.awsIotRegion}/${serviceName}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');
    const signingKey = deriveAwsSigningKey(credentials.secretAccessKey, dateStamp, this.awsIotRegion, serviceName);
    const signature = hmacSha256Hex(signingKey, stringToSign);

    return {
      'content-type': 'application/json',
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'x-amz-security-token': credentials.sessionToken,
      Authorization: [
        `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}`,
        `SignedHeaders=${signedHeaders}`,
        `Signature=${signature}`,
      ].join(', '),
    };
  }

  private async setDatapointLegacy(dsn: string, propertyName: string, value: unknown): Promise<void> {
    const encodedDsn = encodeURIComponent(dsn);
    const encodedPropertyName = encodeURIComponent(propertyName);

    const attempts: Array<{ method: HttpMethod; path: string; body: unknown; description: string }> = [
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
    this.hasEstablishedModernAuthContext = false;
    this.blockedModernDeviceShadowUntilEpochMs = 0;
    this.hasWarnedAboutDeviceShadowAuthFailure = false;
    this.blockedSliderDetailsTargets.clear();
    this.blockedAllSliderDetailsUntilEpochMs = 0;

    if (!this.hasWarnedAboutLegacyFallback) {
      this.hasWarnedAboutLegacyFallback = true;
      this.log.warn(`Switching to legacy Salus cloud compatibility mode (${reason})`);
      this.log.warn('Legacy mode probes multiple legacy sign-in paths and /apiv1 endpoints for tenant compatibility.');
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
      this.propertyCacheByDsn.set(canonicalizeDsn(dsn), properties);
    }
  }

  private mergeIntoPropertyCache(next: Map<string, SalusPropertyMap>): void {
    for (const [dsn, properties] of next) {
      const dsnKey = canonicalizeDsn(dsn);
      const existing = this.propertyCacheByDsn.get(dsnKey);
      if (!existing) {
        this.propertyCacheByDsn.set(dsnKey, properties);
        continue;
      }
      mergePropertyMaps(existing, properties);
    }
  }

  private getActiveBlockedSliderDetailsTargetCount(): number {
    const now = Date.now();
    for (const [targetKey, expiresAt] of this.blockedSliderDetailsTargets) {
      if (expiresAt <= now) {
        this.blockedSliderDetailsTargets.delete(targetKey);
      }
    }
    return this.blockedSliderDetailsTargets.size;
  }

  private isSliderDetailsTargetBlocked(targetKey: string): boolean {
    const expiresAt = this.blockedSliderDetailsTargets.get(targetKey);
    if (!expiresAt) {
      return false;
    }
    if (expiresAt <= Date.now()) {
      this.blockedSliderDetailsTargets.delete(targetKey);
      return false;
    }
    return true;
  }

  private blockSliderDetailsTarget(targetKey: string): void {
    this.blockedSliderDetailsTargets.set(targetKey, Date.now() + SLIDER_DETAILS_BLOCK_TTL_MS);
  }

  private unblockSliderDetailsTarget(targetKey: string): void {
    this.blockedSliderDetailsTargets.delete(targetKey);
  }

  private isAllSliderDetailsBlocked(): boolean {
    if (this.blockedAllSliderDetailsUntilEpochMs <= 0) {
      return false;
    }
    if (this.blockedAllSliderDetailsUntilEpochMs <= Date.now()) {
      this.blockedAllSliderDetailsUntilEpochMs = 0;
      this.hasWarnedAboutSliderDetailsAuthFailure = false;
      if (this.verboseLogging) {
        this.log.debug('Retrying /occupants/slider_details after authorization cooldown.');
      }
      return false;
    }
    return true;
  }

  private blockAllSliderDetails(): void {
    this.blockedAllSliderDetailsUntilEpochMs = Date.now() + SLIDER_DETAILS_BLOCK_TTL_MS;
  }

  private unblockAllSliderDetails(): void {
    this.blockedAllSliderDetailsUntilEpochMs = 0;
    this.hasWarnedAboutSliderDetailsAuthFailure = false;
  }

  private isModernDeviceShadowBlocked(): boolean {
    if (this.blockedModernDeviceShadowUntilEpochMs <= 0) {
      return false;
    }
    if (this.blockedModernDeviceShadowUntilEpochMs <= Date.now()) {
      this.blockedModernDeviceShadowUntilEpochMs = 0;
      this.hasWarnedAboutDeviceShadowAuthFailure = false;
      if (this.verboseLogging) {
        this.log.debug('Retrying devices/device_shadows after authorization cooldown.');
      }
      return false;
    }
    return true;
  }

  private blockModernDeviceShadows(reason: string): void {
    const wasBlocked = this.isModernDeviceShadowBlocked();
    this.blockedModernDeviceShadowUntilEpochMs = Date.now() + DEVICE_SHADOW_BLOCK_TTL_MS;
    if (!this.hasWarnedAboutDeviceShadowAuthFailure) {
      this.hasWarnedAboutDeviceShadowAuthFailure = true;
      this.log.info(
        `${reason} Continuing sync with inline occupants/devices payload properties only for`
        + ` ${Math.round(DEVICE_SHADOW_BLOCK_TTL_MS / 60_000)} minutes before retrying.`,
      );
    } else if (this.verboseLogging && !wasBlocked) {
      this.log.debug(
        `Blocked devices/device_shadows for ${Math.round(DEVICE_SHADOW_BLOCK_TTL_MS / 60_000)} minutes (${reason})`,
      );
    }
  }

  private unblockModernDeviceShadows(): void {
    if (this.blockedModernDeviceShadowUntilEpochMs <= 0) {
      return;
    }
    this.blockedModernDeviceShadowUntilEpochMs = 0;
    this.hasWarnedAboutDeviceShadowAuthFailure = false;
    if (this.verboseLogging) {
      this.log.debug('devices/device_shadows authorization recovered; direct shadow sync re-enabled.');
    }
  }

  private rememberLastKnownDevices(devices: SalusDevice[]): void {
    this.lastKnownDevices = devices.map((device) => ({ ...device }));
  }

  private getLastKnownDevicesSnapshot(): SalusDevice[] {
    return this.lastKnownDevices.map((device) => ({ ...device }));
  }

  private shouldDisableModernDeviceShadowQueries(error: unknown): boolean {
    if (error instanceof LegacyFallbackRequiredError) {
      return true;
    }
    if (error instanceof HttpStatusError && (error.status === 401 || error.status === 403)) {
      return true;
    }
    return false;
  }

  private applyPartialDiscoveryProtection(devices: SalusDevice[]): SalusDevice[] {
    const previous = this.lastKnownDevices;
    if (previous.length === 0 || devices.length >= previous.length) {
      this.hasWarnedAboutPartialDiscoveryFallback = false;
      return devices;
    }

    const severeDropThreshold = Math.max(1, Math.floor(previous.length * 0.8));
    const severeDropDetected = devices.length <= severeDropThreshold;
    const authRestrictedDiscovery = this.getActiveBlockedSliderDetailsTargetCount() > 0
      || this.isAllSliderDetailsBlocked()
      || this.isModernDeviceShadowBlocked();
    if (!severeDropDetected || !authRestrictedDiscovery) {
      this.hasWarnedAboutPartialDiscoveryFallback = false;
      return devices;
    }

    const merged = mergeDevicesPreferCurrent(devices, previous);
    if (!this.hasWarnedAboutPartialDiscoveryFallback) {
      this.hasWarnedAboutPartialDiscoveryFallback = true;
      this.log.warn(
        `Salus discovery returned ${devices.length} device(s) while previous sync had ${previous.length}.`
        + ' Keeping prior device list to avoid stale accessory churn until discovery stabilizes.',
      );
    } else if (this.verboseLogging) {
      this.log.debug(`Keeping previous device list (${previous.length}) during partial discovery result (${devices.length}).`);
    }
    return merged;
  }

  private async fetchDeviceShadows(devices: SalusDevice[], preferredDsns?: string[]): Promise<Map<string, SalusPropertyMap>> {
    const dsns = [...new Set((preferredDsns ?? devices.map((device) => device.dsn)).filter((value) => value.trim() !== ''))];
    const ids = [...new Set(devices.map((device) => device.id).filter((value) => value.trim() !== ''))];
    const keys = [...new Set(devices.map((device) => device.key).filter((value): value is string => Boolean(value && value.trim() !== '')))];
    const hasExplicitPreferredDsns = Array.isArray(preferredDsns) && preferredDsns.length > 0;

    const variants: ShadowRequestVariant[] = [];

    if (!hasExplicitPreferredDsns) {
      variants.push({
        method: 'GET',
        path: '/devices/device_shadows',
        description: 'GET /devices/device_shadows',
      });
    }

    if (dsns.length > 0) {
      variants.push({
        method: 'POST',
        path: '/devices/device_shadows',
        body: { device_codes: dsns },
        description: 'POST /devices/device_shadows {device_codes}',
      });
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

    if (hasExplicitPreferredDsns) {
      variants.push({
        method: 'GET',
        path: '/devices/device_shadows',
        description: 'GET /devices/device_shadows',
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
            allow401Refresh: false,
            allowCompanyCodeRotation: false,
            activeServiceBaseOnly: true,
            maxAttempts: 1,
          },
        );

        this.updateShadowBaseKeyCache(payload);
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

  private updateCachedProperty(dsn: string, propertyName: string, value: unknown): void {
    const dsnKey = canonicalizeDsn(dsn);
    let map = this.propertyCacheByDsn.get(dsnKey);
    if (!map) {
      map = new Map();
      this.propertyCacheByDsn.set(dsnKey, map);
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
    const configuredAttempts = options.maxAttempts ?? (this.maxRetries + 1);
    const totalAttempts = Math.max(1, Math.floor(configuredAttempts));

    let hasRefreshedSessionAfter401 = false;
    const attemptedCompanyCodes = new Set<string>([companyCodeCandidateKey(this.activeCompanyCode)]);
    let unauthorizedRecoverySteps = 0;
    let lastError: unknown = new Error(`No Salus cloud response received for ${options.method} ${path}`);

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const orderedBaseUrls = options.activeServiceBaseOnly
        ? (this.activeServiceApiBaseUrl ? [this.activeServiceApiBaseUrl] : this.getOrderedServiceApiBaseUrls())
        : this.getOrderedServiceApiBaseUrls();
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
            const allowCompanyCodeRotation = (options.allowCompanyCodeRotation ?? true)
              && !this.hasEstablishedModernAuthContext;

            if (isCompanyCodeMismatch && allowCompanyCodeRotation && !this.hasWarnedAboutAuthCompanyCode) {
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

            if (isCompanyCodeMismatch && allowCompanyCodeRotation) {
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
            if (options.allow401Refresh ?? true) {
              sawRetriableFailure = true;
              lastRetriableError = unauthorizedError;
            } else {
              sawDefinitiveFailure = true;
              if (!definitiveError) {
                definitiveError = unauthorizedError;
              }
              // For discovery sub-endpoints where both session refresh and company-code
              // rotation are intentionally disabled, retrying all base hosts on 401
              // only adds latency and request noise. Fail fast.
              if (!(options.allowCompanyCodeRotation ?? true)) {
                break;
              }
            }
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
          if (authRequired) {
            this.hasEstablishedModernAuthContext = true;
          }

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
            if (options.allow401Refresh ?? true) {
              sawRetriableFailure = true;
              lastRetriableError = unauthorizedError;
            } else {
              sawDefinitiveFailure = true;
              if (!definitiveError) {
                definitiveError = unauthorizedError;
              }
            }
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
    this.log.info(`Retrying Salus cloud request in ${delayMs}ms (attempt ${attempt + 1}/${this.maxRetries + 1}): ${reason}`);
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

  private hydratePropertyCacheFromDeviceRecords(devices: SalusDevice[], sourceLabel: string): number {
    const parsed = extractInlinePropertiesFromDeviceRecords(devices);
    if (parsed.size === 0) {
      return 0;
    }

    this.mergeIntoPropertyCache(parsed);
    if (this.verboseLogging) {
      this.log.debug(`Hydrated property cache from ${sourceLabel} for ${parsed.size} device(s).`);
    }
    return parsed.size;
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
    ]
    : region === 'eu'
      ? [
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
      const regionalFallback = region === 'us'
        ? [DEFAULT_US_LEGACY_API_HOST, FALLBACK_US_LEGACY_API_HOST]
        : region === 'eu'
          ? [DEFAULT_EU_LEGACY_API_HOST, FALLBACK_EU_LEGACY_API_HOST]
          : [DEFAULT_EU_LEGACY_API_HOST, FALLBACK_EU_LEGACY_API_HOST, DEFAULT_US_LEGACY_API_HOST, FALLBACK_US_LEGACY_API_HOST];
      const withFallback = [
        ...overrideCandidates,
        ...regionalFallback,
      ];
      return dedupeStringArray(withFallback.map((value) => normalizeUrl(value)));
    }
  }

  const hosts = region === 'us'
    ? [
      DEFAULT_US_LEGACY_API_HOST,
      FALLBACK_US_LEGACY_API_HOST,
    ]
    : region === 'eu'
      ? [
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

function getRegionalAwsDefaults(region: SalusRegion | undefined): AwsRegionalDefaults {
  if (region === 'us') {
    return {
      cognitoRegion: DEFAULT_US_COGNITO_REGION,
      cognitoClientId: DEFAULT_US_COGNITO_CLIENT_ID,
      cognitoUserPoolId: DEFAULT_US_COGNITO_USER_POOL_ID,
      awsIdentityPoolId: DEFAULT_US_AWS_IDENTITY_POOL_ID,
      awsIotRegion: parseIdentityPoolRegion(DEFAULT_US_AWS_IDENTITY_POOL_ID) ?? DEFAULT_US_COGNITO_REGION,
      awsIotEndpointHost: DEFAULT_US_AWS_IOT_ENDPOINT_HOST,
    };
  }

  return {
    cognitoRegion: DEFAULT_COGNITO_REGION,
    cognitoClientId: DEFAULT_COGNITO_CLIENT_ID,
    cognitoUserPoolId: DEFAULT_COGNITO_USER_POOL_ID,
    awsIdentityPoolId: DEFAULT_EU_AWS_IDENTITY_POOL_ID,
    awsIotRegion: parseIdentityPoolRegion(DEFAULT_EU_AWS_IDENTITY_POOL_ID) ?? DEFAULT_COGNITO_REGION,
    awsIotEndpointHost: DEFAULT_EU_AWS_IOT_ENDPOINT_HOST,
  };
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

function awsPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sanitizeMqttClientIdSegment(value: string): string {
  const normalized = value
    .trim()
    .replaceAll(/[^A-Za-z0-9_-]+/g, '_')
    .replaceAll(/_+/g, '_')
    .replaceAll(/^-+|-+$/g, '');
  if (!normalized) {
    return 'homebridge-salus-cloud';
  }
  // Keep enough room for the random UUID suffix.
  return normalized.slice(0, 80);
}

function extractGatewayThingCodeFromDsn(dsn: string): string | undefined {
  const normalized = normalizeNonEmptyString(dsn);
  if (!normalized) {
    return undefined;
  }

  const directMatch = normalized.match(/^([A-Za-z0-9]+_GW-[A-Za-z0-9]+)/i);
  if (directMatch?.[1]) {
    return directMatch[1];
  }

  const pivot = normalized.indexOf('_GW-');
  if (pivot <= 0) {
    return undefined;
  }

  const suffix = normalized.slice(pivot + 4);
  const firstToken = suffix.split('-')[0]?.trim();
  if (!firstToken) {
    return undefined;
  }

  const prefix = normalized.slice(0, pivot);
  return `${prefix}_GW-${firstToken}`;
}

function isMqttUnauthorizedError(error: unknown): boolean {
  const message = asErrorMessage(error).toLowerCase();
  return message.includes('not authorized')
    || message.includes('unauthorized')
    || message.includes('connection refused: 5');
}

function isMqttRetryableError(error: unknown): boolean {
  if (isRetriableFailure(error)) {
    return true;
  }

  const message = asErrorMessage(error).toLowerCase();
  const retryableHints = [
    'timed out',
    'timeout',
    'connection reset',
    'connection closed',
    'socket',
    'offline',
    'temporarily unavailable',
    'network',
    'econnreset',
    'econnrefused',
    'ehostunreach',
    'enotfound',
    'etimedout',
  ];
  return retryableHints.some((hint) => message.includes(hint));
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

function normalizeAwsIotEndpointHost(raw: string): string {
  const normalized = normalizeNonEmptyString(raw);
  if (!normalized) {
    return DEFAULT_EU_AWS_IOT_ENDPOINT_HOST;
  }

  try {
    const withScheme = /^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`;
    return new URL(withScheme).hostname.trim().toLowerCase();
  } catch {
    const fallback = normalized
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      ?.trim()
      .toLowerCase();
    return fallback || DEFAULT_EU_AWS_IOT_ENDPOINT_HOST;
  }
}

function parseIdentityPoolRegion(identityPoolId: string | undefined): string | undefined {
  const normalized = normalizeNonEmptyString(identityPoolId);
  if (!normalized) {
    return undefined;
  }

  const separatorIndex = normalized.indexOf(':');
  if (separatorIndex <= 0) {
    return undefined;
  }

  const region = normalized.slice(0, separatorIndex).trim();
  if (!region || !/^[a-z]{2}-[a-z]+-\d+$/i.test(region)) {
    return undefined;
  }
  return region;
}

function parseAwsIotCredentials(payload: unknown): AwsIotCredentials | undefined {
  const root = asRecord(payload);
  const credentialsRecord = asRecord(root?.Credentials) ?? asRecord(root?.credentials);
  if (!credentialsRecord) {
    return undefined;
  }

  const accessKeyId = normalizeNonEmptyString(asString(credentialsRecord.AccessKeyId) ?? asString(credentialsRecord.accessKeyId));
  const secretAccessKey = normalizeNonEmptyString(
    asString(credentialsRecord.SecretKey)
    ?? asString(credentialsRecord.SecretAccessKey)
    ?? asString(credentialsRecord.secretAccessKey),
  );
  const sessionToken = normalizeNonEmptyString(asString(credentialsRecord.SessionToken) ?? asString(credentialsRecord.sessionToken));

  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    return undefined;
  }

  const expirationRaw = credentialsRecord.Expiration
    ?? credentialsRecord.expiration
    ?? credentialsRecord.ExpiresAt
    ?? credentialsRecord.expiresAt;
  const expiresAtEpochMs = parseAwsCredentialExpiryEpochMs(expirationRaw);

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken,
    expiresAtEpochMs,
  };
}

function parseAwsCredentialExpiryEpochMs(value: unknown): number {
  const now = Date.now();

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) {
      return value;
    }
    if (value > 1_000_000_000) {
      return Math.floor(value * 1_000);
    }
    if (value > 0) {
      return now + Math.floor(value * 1_000);
    }
  }

  if (typeof value === 'string') {
    const fromNumeric = Number(value);
    if (Number.isFinite(fromNumeric)) {
      return parseAwsCredentialExpiryEpochMs(fromNumeric);
    }

    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.getTime();
  }

  return now + (60 * 60_000);
}

function formatAwsAmzDate(now: Date): string {
  return [
    now.getUTCFullYear().toString().padStart(4, '0'),
    (now.getUTCMonth() + 1).toString().padStart(2, '0'),
    now.getUTCDate().toString().padStart(2, '0'),
    'T',
    now.getUTCHours().toString().padStart(2, '0'),
    now.getUTCMinutes().toString().padStart(2, '0'),
    now.getUTCSeconds().toString().padStart(2, '0'),
    'Z',
  ].join('');
}

function formatAwsDateStamp(now: Date): string {
  return [
    now.getUTCFullYear().toString().padStart(4, '0'),
    (now.getUTCMonth() + 1).toString().padStart(2, '0'),
    now.getUTCDate().toString().padStart(2, '0'),
  ].join('');
}

function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmacSha256Buffer(key: string | Buffer, value: string | Buffer): Buffer {
  return crypto.createHmac('sha256', key).update(value).digest();
}

function hmacSha256Hex(key: string | Buffer, value: string | Buffer): string {
  return crypto.createHmac('sha256', key).update(value).digest('hex');
}

function deriveAwsSigningKey(secretAccessKey: string, dateStamp: string, region: string, serviceName: string): Buffer {
  const kDate = hmacSha256Buffer(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256Buffer(kDate, region);
  const kService = hmacSha256Buffer(kRegion, serviceName);
  return hmacSha256Buffer(kService, 'aws4_request');
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
  const issuerDetails = parseCognitoIssuerDetails(decodedIdTokenClaims, decodedAccessTokenClaims);

  const expiresInRaw = parseNumberLike(authResult.ExpiresIn);
  const expiresInSeconds = expiresInRaw && Number.isFinite(expiresInRaw) ? Math.max(60, Math.floor(expiresInRaw)) : undefined;
  const tokenExpSeconds = parseNumberLike(decodedAccessTokenClaims?.exp ?? decodedIdTokenClaims?.exp);
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const expiresAtFromToken = tokenExpSeconds && tokenExpSeconds > Math.max(1_000_000_000, nowSeconds + 60)
    ? Math.floor(tokenExpSeconds * 1_000)
    : undefined;

  if (!accessToken || !idToken) {
    return undefined;
  }

  return {
    accessToken,
    idToken,
    refreshToken,
    tokenType,
    expiresAtEpochMs: expiresInSeconds !== undefined
      ? Date.now() + (expiresInSeconds * 1_000)
      : (expiresAtFromToken ?? (Date.now() + (3600 * 1_000))),
    companyCode: extractCompanyCodeFromTokenClaims(decodedIdTokenClaims, decodedAccessTokenClaims),
    cognitoRegion: issuerDetails?.region,
    userPoolId: issuerDetails?.userPoolId,
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

function parseCognitoIssuerDetails(
  ...claimSets: Array<Record<string, unknown> | undefined>
): { region: string; userPoolId: string } | undefined {
  for (const claims of claimSets) {
    if (!claims) {
      continue;
    }

    const issuer = normalizeNonEmptyString(asString(claims.iss) ?? asString(claims.issuer));
    if (!issuer) {
      continue;
    }

    const normalizedIssuer = issuer.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const match = normalizedIssuer.match(/^cognito-idp\.([^.]+)\.amazonaws\.com\/(.+)$/i);
    if (!match) {
      continue;
    }

    const region = normalizeNonEmptyString(match[1]);
    const userPoolId = normalizeNonEmptyString(match[2]);
    if (region && userPoolId) {
      return { region, userPoolId };
    }
  }

  return undefined;
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

function extractOccupantsSliderTargets(payload: unknown): OccupantsSliderTarget[] {
  const queue: unknown[] = [payload];
  const visited = new Set<unknown>();
  const byId = new Map<string, Set<string>>();

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
    for (const target of collectSliderTargetsFromRecord(record)) {
      const existing = byId.get(target.id);
      if (existing) {
        for (const hint of target.typeHints) {
          existing.add(hint);
        }
      } else {
        byId.set(target.id, new Set(target.typeHints));
      }
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return [...byId.entries()].map(([id, hints]) => ({
    id,
    typeHints: [...hints],
  }));
}

function collectSliderTargetsFromRecord(record: Record<string, unknown>): OccupantsSliderTarget[] {
  const targets: OccupantsSliderTarget[] = [];

  const addTarget = (idRaw: unknown, typeHints: string[]): void => {
    const id = normalizeNonEmptyString(asString(idRaw));
    if (!id) {
      return;
    }
    const normalizedTypeHints = dedupeStringArray(
      typeHints
        .map((value) => normalizeSliderType(value))
        .filter((value): value is string => Boolean(value)),
    );
    targets.push({
      id,
      typeHints: normalizedTypeHints,
    });
  };

  addTarget(record.gateway_id ?? record.gatewayId, ['gateway']);
  addTarget(record.occupant_id ?? record.occupantId ?? record.user_id ?? record.userId, ['occupant']);
  addTarget(record.home_id ?? record.homeId ?? record.house_id ?? record.houseId, ['home']);
  addTarget(record.site_id ?? record.siteId ?? record.location_id ?? record.locationId, ['site']);
  addTarget(record.group_id ?? record.groupId, ['group']);
  addTarget(record.room_id ?? record.roomId ?? record.zone_id ?? record.zoneId, ['room']);

  const id = normalizeNonEmptyString(
    asString(record.id)
    ?? asString(record.slider_id)
    ?? asString(record.item_id),
  );
  if (id && (!recordHasDeviceIdentity(record) || recordHasSliderNavigation(record))) {
    addTarget(id, inferSliderTypeHints(record));
  }

  return targets;
}

function inferSliderTypeHints(record: Record<string, unknown>): string[] {
  const hints: string[] = [];

  const typeCandidates = [
    asString(record.type),
    asString(record.slider_type),
    asString(record.item_type),
    asString(record.object_type),
    asString(record.kind),
    asString(record.category),
    asString(record.target_type),
  ];
  for (const candidate of typeCandidates) {
    if (!candidate) {
      continue;
    }
    const normalized = normalizeSliderType(candidate);
    if (normalized) {
      hints.push(normalized);
    }
  }

  if ('gateway_id' in record || 'gatewayId' in record || 'gateways' in record || parseBooleanLike(record.is_gateway) === true) {
    hints.push('gateway');
  }
  if ('occupant_id' in record || 'occupantId' in record) {
    hints.push('occupant');
  }
  if ('home_id' in record || 'homeId' in record || 'house_id' in record || 'houseId' in record || 'homes' in record || 'houses' in record) {
    hints.push('home');
  }
  if ('site_id' in record || 'siteId' in record || 'sites' in record || 'location_id' in record || 'locationId' in record) {
    hints.push('site');
  }
  if ('group_id' in record || 'groupId' in record || 'groups' in record) {
    hints.push('group');
  }
  if ('room_id' in record || 'roomId' in record || 'zone_id' in record || 'zoneId' in record || 'rooms' in record || 'zones' in record) {
    hints.push('room');
  }

  return dedupeStringArray(hints);
}

function normalizeSliderType(value: string): string | undefined {
  const compact = value.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!compact) {
    return undefined;
  }

  if (compact.includes('gateway') || compact === 'gw') {
    return 'gateway';
  }
  if (compact.includes('occupant') || compact.includes('user') || compact.includes('profile')) {
    return 'occupant';
  }
  if (compact.includes('home') || compact.includes('house') || compact.includes('residence')) {
    return 'home';
  }
  if (compact.includes('site') || compact.includes('location')) {
    return 'site';
  }
  if (compact.includes('group')) {
    return 'group';
  }
  if (compact.includes('room') || compact.includes('zone')) {
    return 'room';
  }

  return undefined;
}

function recordHasSliderNavigation(record: Record<string, unknown>): boolean {
  const navigationKeys = [
    'children',
    'child_list',
    'list',
    'items',
    'gateways',
    'homes',
    'houses',
    'sites',
    'groups',
    'rooms',
    'zones',
    'data',
    'results',
  ];

  for (const key of navigationKeys) {
    if (!(key in record)) {
      continue;
    }
    const value = record[key];
    if (Array.isArray(value)) {
      return true;
    }
    if (asRecord(value)) {
      return true;
    }
  }

  return false;
}

function buildSliderDetailsPathGroups(targetId: string, typeHints: string[]): string[][] {
  const encodedId = encodeURIComponent(targetId);
  const normalizedHints = typeHints
    .map((value) => normalizeSliderType(value))
    .filter((value): value is string => Boolean(value));
  const orderedTypes = dedupeStringArray([
    ...normalizedHints,
    ...OCCUPANTS_SLIDER_DETAIL_TYPE_FALLBACKS,
  ]).slice(0, MAX_OCCUPANTS_DETAIL_TYPES_PER_TARGET);

  const groups: string[][] = [];
  for (const type of orderedTypes) {
    const encodedType = encodeURIComponent(type);
    groups.push([
      `/occupants/slider_details?id=${encodedId}&type=${encodedType}`,
      `/api/v1/occupants/slider_details?id=${encodedId}&type=${encodedType}`,
    ]);
  }

  groups.push([
    `/occupants/slider_details?id=${encodedId}`,
    `/api/v1/occupants/slider_details?id=${encodedId}`,
  ]);

  return groups;
}

function parseDevices(payload: unknown): SalusDevice[] {
  const result: SalusDevice[] = [];
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
    const candidateRecords = [
      record,
      asRecord(record.device),
      asRecord(record.node),
      asRecord(record.registered_node),
      asRecord(record.value),
    ].filter((value): value is Record<string, unknown> => Boolean(value));

    for (const candidate of candidateRecords) {
      const parsed = parseDeviceRecord(candidate);
      if (parsed) {
        result.push(parsed);
      }
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return dedupeDevicesByDsn(result);
}

function extractInlinePropertiesFromDeviceRecords(devices: SalusDevice[]): Map<string, SalusPropertyMap> {
  const output: Map<string, SalusPropertyMap> = new Map();

  for (const device of devices) {
    const parsed = parseProperties(device.raw);
    if (parsed.size === 0) {
      continue;
    }

    const existing = output.get(device.dsn);
    if (existing) {
      mergePropertyMaps(existing, parsed);
    } else {
      output.set(device.dsn, parsed);
    }
  }

  return output;
}

function parseDeviceRecord(record: Record<string, unknown>): SalusDevice | undefined {
  const explicitDsn = normalizeNonEmptyString(
    asString(record.dsn)
    ?? asString(record.device_dsn)
    ?? asString(record.device_code)
    ?? asString(record.DSN)
    ?? asString(record.unique_hardware_id)
    ?? asString(record.uniqueHardwareId)
    ?? asString(record.serial_number)
    ?? asString(record.serialNumber)
    ?? asString(record.mac_address)
    ?? asString(record.mac)
    ?? asString(record.ieee_address),
  );

  const key = normalizeNonEmptyString(
    asString(record.key)
    ?? asString(record.device_key)
    ?? asString(record.unique_hardware_id)
    ?? asString(record.uniqueHardwareId),
  );
  const fallbackIdentity = normalizeNonEmptyString(
    asString(record.device_id)
    ?? asString(record.node_id),
  );
  const modelRaw = asString(record.oem_model)
    ?? asString(record.model)
    ?? asString(record.model_name)
    ?? asString(record.product_class)
    ?? asString(record.device_model)
    ?? asString(record.product_name)
    ?? '';
  const hasModelHint = Boolean(normalizeNonEmptyString(modelRaw));
  const hasStatePayload = recordHasStatePayload(record);
  const hasStrongIdentity = recordHasStrongDeviceIdentity(record);

  const id = normalizeNonEmptyString(
    asString(record.id)
    ?? asString(record.device_id)
    ?? asString(record.node_id)
    ?? key
    ?? explicitDsn,
  );
  let dsn = explicitDsn ?? key;
  if (!dsn && fallbackIdentity) {
    // Some tenants expose device_id/node_id without dsn/device_key.
    // Accept this fallback only when the record also carries device-like
    // model/state payloads, avoiding synthetic accessories for container rows.
    if (normalizeNonEmptyString(modelRaw) || recordHasStatePayload(record)) {
      dsn = fallbackIdentity;
    }
  }

  if (!dsn || !id) {
    return undefined;
  }
  if (!explicitDsn && !key && !fallbackIdentity) {
    return undefined;
  }
  if (!hasStrongIdentity && !hasModelHint && !hasStatePayload) {
    // Ignore synthetic rows such as automation/rule/status records that expose
    // only generic keys/names without real device identity or state payload.
    return undefined;
  }
  if (!looksLikeDeviceRecord(record)) {
    return undefined;
  }

  const model = normalizeModelName(modelRaw);
  const displayName = deriveDeviceDisplayName(record, dsn, model);
  const online = deriveOnlineState(record);

  return {
    id,
    dsn,
    key: key ?? undefined,
    model,
    name: displayName,
    productName: asString(record.product_name),
    online,
    raw: record,
  };
}

function looksLikeDeviceRecord(record: Record<string, unknown>): boolean {
  const hasStrongIdentity = recordHasStrongDeviceIdentity(record);
  const hasAnyIdentity = recordHasDeviceIdentity(record);
  const modelHints = [
    record.oem_model,
    record.model,
    record.model_name,
    record.product_class,
    record.device_model,
  ];
  const hasModelHint = modelHints.some((value) => normalizeNonEmptyString(asString(value)));
  const hasStatePayload = recordHasStatePayload(record);

  if (hasStrongIdentity && (hasModelHint || hasStatePayload || 'device_name' in record || 'product_name' in record)) {
    return true;
  }

  if (hasAnyIdentity && (hasModelHint || hasStatePayload)) {
    return true;
  }

  return false;
}

function recordHasStatePayload(record: Record<string, unknown>): boolean {
  const stateHints = ['shadow', 'device_shadow', 'properties', 'property_values', 'datapoints', 'reported', 'desired', 'state'];
  for (const key of stateHints) {
    if (key in record) {
      return true;
    }
  }
  return false;
}

function recordHasDeviceIdentity(record: Record<string, unknown>): boolean {
  const idHints = [
    record.dsn,
    record.device_dsn,
    record.device_code,
    record.DSN,
    record.unique_hardware_id,
    record.uniqueHardwareId,
    record.key,
    record.device_key,
    record.device_id,
    record.node_id,
  ];

  return idHints.some((value) => normalizeNonEmptyString(asString(value)));
}

function recordHasStrongDeviceIdentity(record: Record<string, unknown>): boolean {
  const strongHints = [
    record.dsn,
    record.device_dsn,
    record.device_code,
    record.DSN,
    record.unique_hardware_id,
    record.uniqueHardwareId,
    record.device_id,
    record.node_id,
    record.serial_number,
    record.serialNumber,
    record.mac_address,
    record.mac,
    record.ieee_address,
    record.ieee,
  ];

  return strongHints.some((value) => normalizeNonEmptyString(asString(value)));
}

function parseDeviceShadowBaseKeys(
  payload: unknown,
  deviceIdToDsn: Map<string, string>,
  deviceKeyToDsn: Map<string, string>,
  propertyNameHint?: string,
): Map<string, string> {
  const output = new Map<string, string>();
  const queue: unknown[] = [payload];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === null || current === undefined) {
      continue;
    }

    if (typeof current === 'string') {
      const parsed = parseJsonRecord(current);
      if (parsed) {
        queue.push(parsed);
      }
      continue;
    }

    if (typeof current !== 'object') {
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
      const baseKey = inferShadowBaseKey(record, propertyNameHint);
      if (baseKey) {
        output.set(dsn, baseKey);
      }
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
      if (typeof value === 'string') {
        const parsed = parseJsonRecord(value);
        if (parsed) {
          queue.push(parsed);
        }
      }
    }
  }

  return output;
}

function inferShadowBaseKey(record: Record<string, unknown>, propertyNameHint?: string): string | undefined {
  const containers: Array<Record<string, unknown> | undefined> = [
    asRecord(record.desired),
    asRecord(record.reported),
    asRecord(record.state),
    asRecord(asRecord(record.state)?.desired),
    asRecord(asRecord(record.state)?.reported),
    asRecord(asRecord(record.state)?.delta),
    asRecord(record.shadow),
    asRecord(record.device_shadow),
    asRecord(record.payload),
    asRecord(record.data),
    asRecord(record.value),
  ];

  for (const container of containers) {
    const resolved = inferShadowBaseKeyFromContainer(container, propertyNameHint);
    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

function inferShadowBaseKeyFromContainer(
  container: Record<string, unknown> | undefined,
  propertyNameHint?: string,
): string | undefined {
  if (!container) {
    return undefined;
  }

  const entries = Object.entries(container);
  if (entries.length === 0) {
    return undefined;
  }

  const withProperties: string[] = [];
  const numericWithProperties: string[] = [];
  for (const [key, rawValue] of entries) {
    const valueRecord = asRecord(rawValue);
    if (!valueRecord) {
      continue;
    }

    const properties = extractShadowPropertiesContainer(valueRecord);
    if (!properties) {
      continue;
    }

    if (propertyNameHint && Object.prototype.hasOwnProperty.call(properties, propertyNameHint)) {
      return key;
    }

    withProperties.push(key);
    if (/^\d+$/.test(key)) {
      numericWithProperties.push(key);
    }
  }

  if (numericWithProperties.includes('11')) {
    return '11';
  }
  if (numericWithProperties.length > 0) {
    return numericWithProperties.sort((left, right) => Number(left) - Number(right))[0];
  }
  if (withProperties.length > 0) {
    return withProperties[0];
  }

  return undefined;
}

function extractShadowPropertiesContainer(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const directProperties = asRecord(record.properties);
  if (directProperties) {
    return directProperties;
  }

  const nestedState = asRecord(record.state);
  if (nestedState) {
    const nestedProperties = asRecord(nestedState.properties)
      ?? asRecord(asRecord(nestedState.reported)?.properties)
      ?? asRecord(asRecord(nestedState.desired)?.properties)
      ?? asRecord(asRecord(nestedState.delta)?.properties);
    if (nestedProperties) {
      return nestedProperties;
    }
  }

  return undefined;
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
      const propertyCandidates: unknown[] = [
        record.shadow,
        record.device_shadow,
        record.properties,
        record.property_values,
        record.datapoints,
        record.reported,
        record.desired,
        record.delta,
        record.state,
        record.attrs,
      ];
      propertyCandidates.push(...collectEmbeddedShadowPropertyCandidates(record));

      const merged = new Map<string, SalusProperty>();
      for (const candidate of propertyCandidates) {
        const parsed = parseProperties(candidate);
        mergePropertyMaps(merged, parsed);
      }

      // Salus shadows can contain both desired and reported copies of the same
      // datapoint. Keep desired-only command fields (e.g. Set* properties), but
      // always let reported values win for overlapping keys so HomeKit reflects
      // actual live device state.
      const reportedCandidates = collectReportedShadowPropertyCandidates(record);
      if (reportedCandidates.length > 0) {
        const reportedProperties = new Map<string, SalusProperty>();
        for (const candidate of reportedCandidates) {
          const parsed = parseProperties(candidate);
          mergePropertyMaps(reportedProperties, parsed);
        }
        mergePropertyMaps(merged, reportedProperties);
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

function collectReportedShadowPropertyCandidates(record: Record<string, unknown>): unknown[] {
  const candidates: unknown[] = [];
  const queue: unknown[] = [record];
  const visited = new Set<unknown>();
  const seenCandidates = new Set<unknown>();

  const addCandidate = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') {
      return;
    }
    if (seenCandidates.has(candidate)) {
      return;
    }
    seenCandidates.add(candidate);
    candidates.push(candidate);
  };

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === null) {
      continue;
    }

    if (typeof current === 'string') {
      const parsed = parseJsonRecord(current);
      if (parsed) {
        queue.push(parsed);
      }
      continue;
    }

    if (typeof current !== 'object') {
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

    const currentRecord = current as Record<string, unknown>;
    const stateRecord = asRecord(currentRecord.state);
    const reportedLayers = [
      asRecord(currentRecord.reported),
      asRecord(stateRecord?.reported),
    ]
      .filter((value): value is Record<string, unknown> => Boolean(value));

    for (const reportedLayer of reportedLayers) {
      for (const candidate of collectLayerPropertyCandidates(reportedLayer)) {
        addCandidate(candidate);
      }
    }

    for (const value of Object.values(currentRecord)) {
      if (typeof value === 'string') {
        const parsed = parseJsonRecord(value);
        if (parsed) {
          queue.push(parsed);
        }
        continue;
      }
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return candidates;
}

function collectLayerPropertyCandidates(layerRoot: Record<string, unknown>): unknown[] {
  const candidates: unknown[] = [];
  const queue: unknown[] = [layerRoot];
  const visited = new Set<unknown>();
  const seenCandidates = new Set<unknown>();

  const addCandidate = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') {
      return;
    }
    if (seenCandidates.has(candidate)) {
      return;
    }
    seenCandidates.add(candidate);
    candidates.push(candidate);
  };

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === null) {
      continue;
    }

    if (typeof current === 'string') {
      const parsed = parseJsonRecord(current);
      if (parsed) {
        queue.push(parsed);
      }
      continue;
    }

    if (typeof current !== 'object') {
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

    const currentRecord = current as Record<string, unknown>;
    addCandidate(currentRecord);

    const propertyMaps = [
      asRecord(currentRecord.properties),
      asRecord(currentRecord.attrs),
      asRecord(currentRecord.property_values),
      asRecord(currentRecord.datapoints),
    ]
      .filter((value): value is Record<string, unknown> => Boolean(value));
    for (const propertyMap of propertyMaps) {
      addCandidate(propertyMap);
    }

    for (const value of Object.values(currentRecord)) {
      if (typeof value === 'string') {
        const parsed = parseJsonRecord(value);
        if (parsed) {
          queue.push(parsed);
        }
        continue;
      }
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return candidates;
}

function collectEmbeddedShadowPropertyCandidates(record: Record<string, unknown>): unknown[] {
  const candidates: unknown[] = [];
  const queue: unknown[] = [
    record.payload,
    record.shadow_payload,
    record.shadowPayload,
    record.state,
    record.reported,
    record.desired,
    record.delta,
    record.shadow,
    record.device_shadow,
    record.properties,
    record.property_values,
    record.datapoints,
    record.attrs,
    record.data,
    record.value,
  ];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === null) {
      continue;
    }

    if (typeof current === 'string') {
      const parsed = parseJsonRecord(current);
      if (parsed) {
        queue.push(parsed);
      }
      continue;
    }

    if (typeof current !== 'object') {
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

    const currentRecord = current as Record<string, unknown>;
    candidates.push(currentRecord);

    const propertyMaps = [
      asRecord(currentRecord.properties),
      asRecord(currentRecord.attrs),
      asRecord(currentRecord.shadow),
      asRecord(currentRecord.device_shadow),
      asRecord(currentRecord.property_values),
      asRecord(currentRecord.datapoints),
    ]
      .filter((value): value is Record<string, unknown> => Boolean(value));
    for (const propertyMap of propertyMaps) {
      candidates.push(propertyMap);
      queue.push(propertyMap);
    }

    const stateRecord = asRecord(currentRecord.state);
    if (stateRecord) {
      candidates.push(stateRecord);
      queue.push(stateRecord.reported);
      queue.push(stateRecord.desired);
      queue.push(stateRecord.delta);
      queue.push(stateRecord.properties);
    }

    queue.push(currentRecord.reported);
    queue.push(currentRecord.desired);
    queue.push(currentRecord.delta);
    queue.push(currentRecord.data);
    queue.push(currentRecord.value);

    for (const value of Object.values(currentRecord)) {
      if (typeof value === 'string') {
        // Some APIs return nested state snapshots as serialized JSON strings.
        const parsed = parseJsonRecord(value);
        if (parsed) {
          queue.push(parsed);
        }
        continue;
      }
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return candidates;
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

  const fromThingName = parseDsnFromShadowThingName(record);
  if (fromThingName) {
    return fromThingName;
  }

  return undefined;
}

function parseDsnFromShadowThingName(record: Record<string, unknown>): string | undefined {
  const rawThingName = normalizeNonEmptyString(
    asString(record.thing_name)
    ?? asString(record.thingName)
    ?? asString(record.thing)
    ?? asString(record.topic)
    ?? asString(record.shadow_topic),
  );
  if (!rawThingName) {
    return undefined;
  }

  const match = rawThingName.match(/\/things\/([^/]+)\/shadow/i);
  const candidate = match?.[1] ?? rawThingName;
  const decoded = normalizeNonEmptyString(decodeURIComponentSafe(candidate));
  if (!decoded) {
    return undefined;
  }

  // Keep this guard permissive for future DSN formats while rejecting obvious non-device labels.
  if (decoded.length < 6) {
    return undefined;
  }
  if (decoded.includes('/') || decoded.includes(' ')) {
    return undefined;
  }

  return decoded;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
    if (isMetadataFieldName(name)) {
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
  if (isMetadataFieldName(name)) {
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

  if (isMetadataFieldName(name)) {
    return false;
  }

  if (name.includes(':') || name.includes('.') || name.includes('/')) {
    return true;
  }

  if (/^[A-Za-z][A-Za-z0-9_]+$/.test(name) && /[A-Z]/.test(name)) {
    return true;
  }

  if (/_x\d+$/i.test(name)) {
    return true;
  }

  const record = asRecord(rawValue);
  if (record && (
    'value' in record
    || 'current_value' in record
    || 'datapoint' in record
    || 'last_datapoint' in record
    || 'reported' in record
    || 'desired' in record
  )) {
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

function isMetadataFieldName(name: string): boolean {
  return METADATA_FIELD_NAMES.has(name) || METADATA_FIELD_NAMES_LOWER.has(name.toLowerCase());
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
    const key = canonicalizeDsn(device.dsn);
    const existing = byDsn.get(key);
    if (!existing || scoreDeviceForMergePreference(device) > scoreDeviceForMergePreference(existing)) {
      byDsn.set(key, device);
    }
  }
  return [...byDsn.values()];
}

function mergeDevicesPreferCurrent(current: SalusDevice[], previous: SalusDevice[]): SalusDevice[] {
  const byDsn = new Map<string, SalusDevice>();
  for (const device of previous) {
    byDsn.set(canonicalizeDsn(device.dsn), device);
  }
  for (const device of current) {
    byDsn.set(canonicalizeDsn(device.dsn), device);
  }
  return [...byDsn.values()];
}

function scoreDeviceForMergePreference(device: SalusDevice): number {
  let score = 0;
  if (normalizeNonEmptyString(device.model)) {
    score += 3;
  }
  if (normalizeNonEmptyString(device.name)) {
    score += 2;
  }
  if (normalizeNonEmptyString(device.productName)) {
    score += 1;
  }
  if (device.online !== undefined) {
    score += 1;
  }
  if (normalizeNonEmptyString(device.key)) {
    score += 1;
  }
  return score;
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

function canonicalizeDsn(value: string): string {
  return value.trim().toLowerCase();
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
