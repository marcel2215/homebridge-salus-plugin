/* eslint-disable @typescript-eslint/no-use-before-define */

import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { getCatalogEntry, inferKindFromCatalog } from './deviceCatalog.js';
import { hasAnyPropertyBase } from './propertyUtils.js';
import { SalusCloudClient } from './salusCloudClient.js';
import { SalusPlatformAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type { DeviceProfile, PlatformAccessoryContext, SalusDevice, SalusPlatformConfig, SalusPropertyMap } from './types.js';

const DEFAULT_POLL_INTERVAL_SECONDS = 20;
const DEFAULT_MAX_PARALLEL_PROPERTY_REQUESTS = 4;
const MIN_POLL_INTERVAL_SECONDS = 10;
const MAX_POLL_INTERVAL_SECONDS = 300;

const THERMOSTAT_PROPERTY_BASES = [
  'LocalTemperature_x100',
  'HeatingSetpoint_x100',
  'CoolingSetpoint_x100',
  'SetHeatingSetpoint_x100',
  'SetCoolingSetpoint_x100',
  'SetSystemMode',
  'SystemMode',
  'RunningState',
  'RunningMode',
];
const LOCK_PROPERTY_BASES = ['Lock', 'LockState', 'LockStatus', 'DoorLock'];
const POSITION_PROPERTY_BASES = ['CurrentLevel', 'TargetLevel', 'LiftPercentage', 'CurrentPosition'];
const ONOFF_PROPERTY_BASES = ['OnOff', 'SetOnOff', 'ValveStatus', 'ButtonStatus', 'Mode'];
const BRIGHTNESS_PROPERTY_BASES = ['CurrentLevel', 'SetLevel', 'Brightness', 'DimLevel'];
const MOTION_PROPERTY_BASES = ['Motion', 'Occupancy', 'IASZSAlarmed', 'ErrorIASZSAlarmed1'];
const CONTACT_PROPERTY_BASES = ['Open', 'Door', 'Window', 'Contact'];
const LEAK_PROPERTY_BASES = ['Leak', 'WaterLeak', 'ErrorIASZSAlarmed1'];
const SMOKE_PROPERTY_BASES = ['Smoke', 'Heat', 'ErrorIASZSAlarmed1'];
const CO_PROPERTY_BASES = ['CO', 'CarbonMonoxide'];
const TEMPERATURE_PROPERTY_BASES = ['LocalTemperature_x100', 'MeasuredValue_x100', 'Temperature_x100'];
const HUMIDITY_PROPERTY_BASES = ['Humidity', 'RelativeHumidity'];
const AIR_QUALITY_PROPERTY_BASES = ['CO2', 'CarbonDioxide'];

const UNSUPPORTED_CONSTRAINTS = [
  'Schedules and calendar programs are not directly editable via HomeKit characteristics.',
  'Salus multi-stage hold modes (holiday/boost/permanent/follow) are collapsed to HomeKit mode + target temperature.',
  'Firmware management, binding/pairing topology and low-level diagnostics are cloud-only and not represented in HomeKit.',
  'Advanced thermostat installer parameters (control algorithm, floor limits, valve protection tuning) are not exposed by HomeKit.',
  'Energy history/consumption charts and alert-rule automation are not representable in the Home app UI.',
];

export class SalusHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  private readonly accessoryHandlers: Map<string, SalusPlatformAccessory> = new Map();
  private readonly configTyped: SalusPlatformConfig;
  private readonly cloudClient: SalusCloudClient | null;
  private readonly pollIntervalMs: number;
  private readonly maxParallelPropertyRequests: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInProgress = false;
  private launchCompleted = false;

  constructor(
    public readonly log: Logging,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.configTyped = config as SalusPlatformConfig;
    this.pollIntervalMs = Math.round(clamp(
      this.configTyped.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
      MIN_POLL_INTERVAL_SECONDS,
      MAX_POLL_INTERVAL_SECONDS,
    ) * 1_000);
    this.maxParallelPropertyRequests = Math.max(
      1,
      Math.floor(this.configTyped.maxParallelPropertyRequests ?? DEFAULT_MAX_PARALLEL_PROPERTY_REQUESTS),
    );

    if (!this.configTyped.email || !this.configTyped.password) {
      this.cloudClient = null;
      this.log.error('Salus credentials are missing. Configure both "email" and "password" in Homebridge settings.');
    } else {
      this.cloudClient = new SalusCloudClient(this.log, this.configTyped);
      this.log.info(`Configured Salus cloud endpoint: ${this.cloudClient.getCloudBaseUrl()}`);
    }

    this.api.on('didFinishLaunching', () => {
      this.launchCompleted = true;
      this.log.info('Homebridge launch completed. Starting Salus device discovery.');
      this.schedulePoll(0);
    });

    this.api.on('shutdown', () => {
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
    this.log.debug(`Restored cached accessory: ${accessory.displayName}`);
  }

  public async writeDeviceProperty(device: SalusDevice, propertyName: string, value: unknown): Promise<void> {
    if (!this.cloudClient) {
      throw new Error('Salus cloud client is not initialized due to missing credentials.');
    }
    try {
      await this.cloudClient.setDatapoint(device.dsn, propertyName, value);
      this.log.debug(`Set datapoint ${propertyName}=${JSON.stringify(value)} for ${device.name} (${device.dsn})`);
      this.schedulePoll(2_000);
    } catch (error) {
      this.log.error(`Failed to set datapoint ${propertyName} on ${device.name}: ${asErrorMessage(error)}`);
      throw error;
    }
  }

  public getUnmappedConstraintList(): string[] {
    return [...UNSUPPORTED_CONSTRAINTS];
  }

  private schedulePoll(delayMs: number): void {
    if (!this.launchCompleted) {
      return;
    }
    if (!this.cloudClient) {
      return;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.pollTimer = setTimeout(() => {
      void this.pollDevices();
    }, Math.max(0, delayMs));
  }

  private async pollDevices(): Promise<void> {
    if (!this.cloudClient) {
      return;
    }
    if (this.pollInProgress) {
      this.log.warn('Previous Salus poll is still in progress; delaying next cycle.');
      this.schedulePoll(2_000);
      return;
    }

    this.pollInProgress = true;
    const discoveredUuids = new Set<string>();

    try {
      const devices = await this.cloudClient.listDevices();
      const uniqueDevices = dedupeDevicesByDsn(devices)
        .filter((device) => !shouldIgnoreInfrastructureDevice(device));

      for (const device of uniqueDevices) {
        discoveredUuids.add(this.api.hap.uuid.generate(`salus:${device.dsn}`));
      }

      const deviceSnapshots = await mapWithConcurrency(
        uniqueDevices,
        this.maxParallelPropertyRequests,
        async (device) => {
          try {
            const properties = await this.cloudClient!.listProperties(device.dsn);
            const profile = this.deriveProfile(device, properties);
            return { device, properties, profile };
          } catch (error) {
            this.log.error(`Failed to fetch properties for ${device.name} (${device.dsn}): ${asErrorMessage(error)}`);
            return null;
          }
        },
      );

      let updatedDeviceCount = 0;
      for (const snapshot of deviceSnapshots) {
        if (!snapshot) {
          continue;
        }
        updatedDeviceCount++;
        const uuid = this.api.hap.uuid.generate(`salus:${snapshot.device.dsn}`);
        const existingAccessory = this.accessories.get(uuid);
        if (existingAccessory) {
          this.restoreOrUpdateAccessory(existingAccessory, snapshot.device, snapshot.profile, snapshot.properties);
        } else {
          this.addAccessory(snapshot.device, snapshot.profile, snapshot.properties, uuid);
        }
      }

      this.removeStaleAccessories(discoveredUuids);
      this.log.info(`Salus sync completed: ${uniqueDevices.length} device(s) discovered, ${updatedDeviceCount} device(s) refreshed.`);
    } catch (error) {
      this.log.error(`Salus sync failed: ${asErrorMessage(error)}`);
    } finally {
      this.pollInProgress = false;
      this.schedulePoll(this.pollIntervalMs);
    }
  }

  private addAccessory(device: SalusDevice, profile: DeviceProfile, properties: SalusPropertyMap, uuid: string): void {
    const accessory = new this.api.platformAccessory(device.name, uuid);
    const context = accessory.context as PlatformAccessoryContext;
    context.device = {
      id: device.id,
      dsn: device.dsn,
      key: device.key,
      model: device.model,
      name: device.name,
    };
    context.profile = profile;

    const handler = new SalusPlatformAccessory(this, accessory, device, profile);
    handler.updateFromCloud(device, profile, properties);

    this.accessories.set(uuid, accessory);
    this.accessoryHandlers.set(uuid, handler);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.log.info(`Added accessory: ${device.name} [${device.model}] (${device.dsn})`);
  }

  private restoreOrUpdateAccessory(
    accessory: PlatformAccessory,
    device: SalusDevice,
    profile: DeviceProfile,
    properties: SalusPropertyMap,
  ): void {
    const needsNameUpdate = accessory.displayName !== device.name;
    if (needsNameUpdate) {
      accessory.displayName = device.name;
    }

    const context = accessory.context as PlatformAccessoryContext;
    context.device = {
      id: device.id,
      dsn: device.dsn,
      key: device.key,
      model: device.model,
      name: device.name,
    };
    context.profile = profile;
    this.api.updatePlatformAccessories([accessory]);

    let handler = this.accessoryHandlers.get(accessory.UUID);
    if (!handler) {
      handler = new SalusPlatformAccessory(this, accessory, device, profile);
      this.accessoryHandlers.set(accessory.UUID, handler);
    }

    handler.updateFromCloud(device, profile, properties);
  }

  private removeStaleAccessories(discoveredUuids: Set<string>): void {
    for (const [uuid, accessory] of this.accessories) {
      if (discoveredUuids.has(uuid)) {
        continue;
      }
      this.log.info(`Removing stale accessory from cache: ${accessory.displayName}`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(uuid);
      this.accessoryHandlers.delete(uuid);
    }
  }

  private deriveProfile(device: SalusDevice, properties: SalusPropertyMap): DeviceProfile {
    const catalog = getCatalogEntry(device.model);
    const propertyInferredKind = inferKindFromProperties(properties);
    const catalogInferredKind = inferKindFromCatalog(device.model);
    const kind = propertyInferredKind ?? catalogInferredKind ?? 'switch';

    const constraints = [...UNSUPPORTED_CONSTRAINTS];
    if (kind === 'thermostat') {
      constraints.push('Fan modes and multi-point cooling/heating bands are simplified to HomeKit thermostat controls.');
    }
    if (kind === 'lightbulb') {
      constraints.push('Color scenes/vendor presets are not represented as HomeKit characteristics.');
    }
    if (kind === 'windowCovering') {
      constraints.push('Proprietary roller modes (single/double light relay mode) are mapped to standard position controls.');
    }

    return {
      kind,
      catalog,
      constraints,
    };
  }
}

function inferKindFromProperties(properties: SalusPropertyMap): DeviceProfile['kind'] | undefined {
  if (hasAnyPropertyBase(properties, THERMOSTAT_PROPERTY_BASES)) {
    return 'thermostat';
  }
  if (hasAnyPropertyBase(properties, LOCK_PROPERTY_BASES)) {
    return 'lock';
  }
  if (hasAnyPropertyBase(properties, POSITION_PROPERTY_BASES)) {
    return 'windowCovering';
  }
  if (hasAnyPropertyBase(properties, LEAK_PROPERTY_BASES)) {
    return 'leakSensor';
  }
  if (hasAnyPropertyBase(properties, SMOKE_PROPERTY_BASES)) {
    return 'smokeSensor';
  }
  if (hasAnyPropertyBase(properties, CO_PROPERTY_BASES)) {
    return 'carbonMonoxideSensor';
  }
  if (hasAnyPropertyBase(properties, MOTION_PROPERTY_BASES)) {
    return 'motionSensor';
  }
  if (hasAnyPropertyBase(properties, CONTACT_PROPERTY_BASES)) {
    return 'contactSensor';
  }
  if (hasAnyPropertyBase(properties, AIR_QUALITY_PROPERTY_BASES)) {
    return 'airQualitySensor';
  }
  if (hasAnyPropertyBase(properties, HUMIDITY_PROPERTY_BASES) && !hasAnyPropertyBase(properties, TEMPERATURE_PROPERTY_BASES)) {
    return 'humiditySensor';
  }
  if (hasAnyPropertyBase(properties, TEMPERATURE_PROPERTY_BASES)) {
    return 'temperatureSensor';
  }
  if (hasAnyPropertyBase(properties, BRIGHTNESS_PROPERTY_BASES)) {
    return 'lightbulb';
  }
  if (hasAnyPropertyBase(properties, ONOFF_PROPERTY_BASES)) {
    return 'switch';
  }
  return undefined;
}

function shouldIgnoreInfrastructureDevice(device: SalusDevice): boolean {
  return device.model.includes('AG1') || device.model.includes('UG600') || device.model.includes('WZ600');
}

function dedupeDevicesByDsn(devices: SalusDevice[]): SalusDevice[] {
  const byDsn = new Map<string, SalusDevice>();
  for (const device of devices) {
    byDsn.set(device.dsn, device);
  }
  return [...byDsn.values()];
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const workers = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runner = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      const mapped = await mapper(items[index]!);
      results[index] = mapped;
    }
  };

  await Promise.all(Array.from({ length: workers }, () => runner()));
  return results;
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}
