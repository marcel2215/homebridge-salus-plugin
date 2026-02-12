import type { PlatformConfig } from 'homebridge';

import type { HomeKitDeviceKind, ModelCatalogEntry } from './deviceCatalog.js';

export type SalusRegion = 'eu' | 'us';
export type SalusApiVersionPreference = 'auto' | 'v1' | 'v2';

export interface SalusPlatformConfig extends PlatformConfig {
  email?: string;
  password?: string;
  region?: SalusRegion;
  apiVersionPreference?: SalusApiVersionPreference;
  apiHost?: string;
  cognitoRegion?: string;
  cognitoClientId?: string;
  cognitoUserPoolId?: string;
  awsIdentityPoolId?: string;
  awsIotEndpointHost?: string;
  awsIotRegion?: string;
  awsIotServiceName?: string;
  companyCode?: string;
  pollIntervalSeconds?: number;
  requestTimeoutSeconds?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  maxParallelPropertyRequests?: number;
  verboseLogging?: boolean;
  allowInsecureTls?: boolean;
}

export interface SalusDevice {
  id: string;
  dsn: string;
  key?: string;
  model: string;
  name: string;
  productName?: string;
  online?: boolean;
  raw: Record<string, unknown>;
}

export interface SalusProperty {
  name: string;
  baseName: string;
  value: unknown;
  updatedAt?: string;
  raw: Record<string, unknown>;
}

export type SalusPropertyMap = Map<string, SalusProperty>;

export interface DeviceProfile {
  kind: HomeKitDeviceKind;
  catalog?: ModelCatalogEntry;
  constraints: string[];
}

export interface PlatformContextDevice {
  id: string;
  dsn: string;
  key?: string;
  model: string;
  name: string;
}

export interface PlatformAccessoryContext {
  device?: PlatformContextDevice;
  profile?: DeviceProfile;
}
