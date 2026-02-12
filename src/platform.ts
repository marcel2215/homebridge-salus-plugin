/* eslint-disable @typescript-eslint/no-use-before-define */

import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { getCatalogEntry, inferKindFromCatalog } from './deviceCatalog.js';
import { getBooleanProperty, hasAnyPropertyBase } from './propertyUtils.js';
import { SalusCloudClient } from './salusCloudClient.js';
import { SalusPlatformAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type { DeviceProfile, PlatformAccessoryContext, SalusDevice, SalusPlatformConfig, SalusPropertyMap } from './types.js';

const DEFAULT_POLL_INTERVAL_SECONDS = 20;
const DEFAULT_MAX_PARALLEL_PROPERTY_REQUESTS = 4;
const DEFAULT_FULL_DISCOVERY_INTERVAL_SECONDS = 300;
const WRITE_BOOST_POLL_INTERVAL_SECONDS = 8;
const WRITE_BOOST_WINDOW_MS = 60_000;
const MIN_POLL_INTERVAL_SECONDS = 10;
const MAX_POLL_INTERVAL_SECONDS = 300;
const STALE_ACCESSORY_REMOVAL_GRACE_POLLS = 3;
const POLL_BUSY_LOG_THROTTLE_MS = 30_000;
const POLL_FAILURE_BACKOFF_BASE_MS = 5_000;
const POLL_FAILURE_BACKOFF_MAX_MS = 300_000;
const POLL_DELAY_JITTER_FACTOR = 0.15;
const POLL_HEALTH_LOG_EVERY_CYCLES = 30;

const THERMOSTAT_PROPERTY_BASES = [
  'HeatingSetpoint_x100',
  'AutoHeatingSetpoint_x100',
  'SetAutoHeatingSetpoint_x100',
  'TargetTemperature_x100',
  'SetTargetTemperature_x100',
  'Setpoint_x100',
  'HeatSetpoint_x100',
  'OccupiedHeatingSetpoint_x100',
  'CloudySetpoint_x100',
  'HeatingSetpoint',
  'AutoHeatingSetpoint',
  'SetAutoHeatingSetpoint',
  'TargetTemperature',
  'SetTargetTemperature',
  'Setpoint',
  'HeatSetpoint',
  'OccupiedHeatingSetpoint',
  'CloudySetpoint',
  'CoolingSetpoint_x100',
  'AutoCoolingSetpoint_x100',
  'SetAutoCoolingSetpoint_x100',
  'TargetTemperature_x100',
  'SetTargetTemperature_x100',
  'Setpoint_x100',
  'CoolSetpoint_x100',
  'OccupiedCoolingSetpoint_x100',
  'SunnySetpoint_x100',
  'CoolingSetpoint',
  'AutoCoolingSetpoint',
  'SetAutoCoolingSetpoint',
  'TargetTemperature',
  'SetTargetTemperature',
  'Setpoint',
  'CoolSetpoint',
  'OccupiedCoolingSetpoint',
  'SunnySetpoint',
  'SetHeatingSetpoint_x100',
  'SetHeatingSetpoint',
  'SetCoolingSetpoint_x100',
  'SetCoolingSetpoint',
  'SetSystemMode',
  'SystemMode',
  'RunningState',
  'RunningMode',
  'HoldType',
  'SetHoldType',
];
const THERMOSTAT_SETPOINT_PROPERTY_BASES = [
  'HeatingSetpoint_x100',
  'AutoHeatingSetpoint_x100',
  'SetAutoHeatingSetpoint_x100',
  'HeatSetpoint_x100',
  'OccupiedHeatingSetpoint_x100',
  'CloudySetpoint_x100',
  'HeatingSetpoint',
  'AutoHeatingSetpoint',
  'SetAutoHeatingSetpoint',
  'HeatSetpoint',
  'OccupiedHeatingSetpoint',
  'CloudySetpoint',
  'CoolingSetpoint_x100',
  'AutoCoolingSetpoint_x100',
  'SetAutoCoolingSetpoint_x100',
  'CoolSetpoint_x100',
  'OccupiedCoolingSetpoint_x100',
  'SunnySetpoint_x100',
  'CoolingSetpoint',
  'AutoCoolingSetpoint',
  'SetAutoCoolingSetpoint',
  'CoolSetpoint',
  'OccupiedCoolingSetpoint',
  'SunnySetpoint',
  'SetHeatingSetpoint_x100',
  'SetHeatingSetpoint',
  'SetCoolingSetpoint_x100',
  'SetCoolingSetpoint',
  'TargetTemperature_x100',
  'SetTargetTemperature_x100',
  'Setpoint_x100',
  'TargetTemperature',
  'SetTargetTemperature',
  'Setpoint',
];
const THERMOSTAT_MODE_HINT_PROPERTY_BASES = [
  'SetSystemMode',
  'SystemMode',
  'RunningState',
  'RunningMode',
  'HoldType',
  'SetHoldType',
];
const THERMOSTAT_TEMP_HINT_PROPERTY_BASES = [
  'LocalTemperature_x100',
  'CurrentTemperature_x100',
  'Temperature_x100',
  'MeasuredValue_x100',
  'PresentValue_x100',
  'CurrentValue_x100',
  'LocalTemperature',
  'CurrentTemperature',
  'Temperature',
  'MeasuredValue',
  'PresentValue',
  'CurrentValue',
  'RoomTemperature_x100',
  'RoomTemperature',
];
const LOCK_PROPERTY_BASES = ['Lock', 'LockState', 'LockStatus', 'DoorLock'];
const POSITION_PROPERTY_BASES = ['CurrentLevel', 'TargetLevel', 'LiftPercentage', 'CurrentPosition'];
const ONOFF_PROPERTY_BASES = ['OnOff', 'SetOnOff', 'ValveStatus', 'ButtonStatus', 'Mode'];
const BRIGHTNESS_PROPERTY_BASES = ['CurrentLevel', 'SetLevel', 'Brightness', 'DimLevel'];
const MOTION_PROPERTY_BASES = ['Motion', 'Occupancy', 'IASZSAlarmed'];
const CONTACT_PROPERTY_BASES = ['Open', 'Door', 'Window', 'Contact'];
const LEAK_PROPERTY_BASES = ['Leak', 'WaterLeak'];
const SMOKE_PROPERTY_BASES = ['Smoke', 'Heat'];
const CO_PROPERTY_BASES = ['CO', 'CarbonMonoxide'];
const TEMPERATURE_PROPERTY_BASES = ['LocalTemperature_x100', 'MeasuredValue_x100', 'Temperature_x100'];
const HUMIDITY_PROPERTY_BASES = ['Humidity', 'RelativeHumidity'];
const AIR_QUALITY_PROPERTY_BASES = ['CO2', 'CarbonDioxide', 'CO2_x100', 'CarbonDioxide_x100'];

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
  private readonly fullDiscoveryIntervalMs: number;
  private readonly writeBoostPollIntervalMs: number;
  private readonly maxParallelPropertyRequests: number;
  private readonly missingAccessoryPollCounts: Map<string, number> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInProgress = false;
  private pollRequestedWhileBusy = false;
  private lastBusyPollLogEpochMs = 0;
  private lastFullDiscoveryEpochMs = 0;
  private boostPollingUntilEpochMs = 0;
  private consecutivePollFailures = 0;
  private totalPollCycles = 0;
  private successfulPollCycles = 0;
  private lastSuccessfulPollEpochMs = 0;
  private launchCompleted = false;
  private hasLoggedDuplicateRegisterWorkaround = false;

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
    this.fullDiscoveryIntervalMs = Math.max(
      this.pollIntervalMs,
      Math.round((DEFAULT_FULL_DISCOVERY_INTERVAL_SECONDS) * 1_000),
    );
    this.writeBoostPollIntervalMs = Math.max(
      5_000,
      Math.min(this.pollIntervalMs, Math.round(WRITE_BOOST_POLL_INTERVAL_SECONDS * 1_000)),
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
    await this.writeDeviceProperties(device, { [propertyName]: value });
  }

  public async writeDeviceProperties(device: SalusDevice, properties: Record<string, unknown>): Promise<void> {
    if (!this.cloudClient) {
      throw new Error('Salus cloud client is not initialized due to missing credentials.');
    }
    const entries = Object.entries(properties).filter(([name]) => name.trim() !== '');
    if (entries.length === 0) {
      throw new Error(`No writable properties were provided for ${device.name} (${device.dsn}).`);
    }

    try {
      await this.cloudClient.setDatapoints(device.dsn, Object.fromEntries(entries));
      if (entries.length === 1) {
        const [propertyName, value] = entries[0]!;
        this.log.debug(`Set datapoint ${propertyName}=${JSON.stringify(value)} for ${device.name} (${device.dsn})`);
      } else {
        const summary = entries.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(', ');
        this.log.debug(`Set ${entries.length} datapoints for ${device.name} (${device.dsn}): ${summary}`);
      }
      this.markWriteBoostWindow();
      this.schedulePoll(1_000);
    } catch (error) {
      const summary = entries.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(', ');
      this.log.error(`Failed to set datapoint(s) on ${device.name}: ${summary}. ${asErrorMessage(error)}`);
      throw error;
    }
  }

  public async readDeviceProperties(device: SalusDevice): Promise<SalusPropertyMap> {
    if (!this.cloudClient) {
      throw new Error('Salus cloud client is not initialized due to missing credentials.');
    }
    return await this.cloudClient.listProperties(device.dsn);
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

  private markWriteBoostWindow(): void {
    const boostedUntil = Date.now() + WRITE_BOOST_WINDOW_MS;
    if (boostedUntil > this.boostPollingUntilEpochMs) {
      this.boostPollingUntilEpochMs = boostedUntil;
    }
  }

  private getActivePollIntervalMs(): number {
    if (Date.now() < this.boostPollingUntilEpochMs) {
      return this.writeBoostPollIntervalMs;
    }
    return this.pollIntervalMs;
  }

  private withDelayJitter(baseDelayMs: number): number {
    const bounded = Math.max(1_000, Math.round(baseDelayMs));
    const spread = bounded * POLL_DELAY_JITTER_FACTOR;
    const jittered = bounded + ((Math.random() * 2 * spread) - spread);
    return Math.max(1_000, Math.round(jittered));
  }

  private computeNextPollDelayMs(): number {
    if (this.consecutivePollFailures <= 0) {
      return this.withDelayJitter(this.getActivePollIntervalMs());
    }

    const exponent = Math.min(6, this.consecutivePollFailures - 1);
    const baseBackoff = Math.min(
      POLL_FAILURE_BACKOFF_MAX_MS,
      POLL_FAILURE_BACKOFF_BASE_MS * (2 ** exponent),
    );
    return this.withDelayJitter(baseBackoff);
  }

  private maybeLogPollHealth(): void {
    if (this.totalPollCycles <= 0 || (this.totalPollCycles % POLL_HEALTH_LOG_EVERY_CYCLES) !== 0) {
      return;
    }
    const successRate = Math.round((this.successfulPollCycles / this.totalPollCycles) * 100);
    const sinceLastSuccessSec = this.lastSuccessfulPollEpochMs > 0
      ? Math.round((Date.now() - this.lastSuccessfulPollEpochMs) / 1000)
      : -1;
    const sinceLastSuccessText = sinceLastSuccessSec >= 0 ? `${sinceLastSuccessSec}s` : 'n/a';
    this.log.info(
      `Salus poll health: success=${this.successfulPollCycles}/${this.totalPollCycles} (${successRate}%),`
      + ` consecutiveFailures=${this.consecutivePollFailures}, lastSuccessAgo=${sinceLastSuccessText}.`,
    );
  }

  private async pollDevices(): Promise<void> {
    if (!this.cloudClient) {
      return;
    }
    if (this.pollInProgress) {
      this.pollRequestedWhileBusy = true;
      const now = Date.now();
      if ((now - this.lastBusyPollLogEpochMs) >= POLL_BUSY_LOG_THROTTLE_MS) {
        this.lastBusyPollLogEpochMs = now;
        this.log.info('Previous Salus poll is still in progress; queued one immediate follow-up poll.');
      }
      return;
    }

    this.pollInProgress = true;
    this.totalPollCycles += 1;
    const discoveredUuids = new Set<string>();
    let nextPollDelayMs: number | undefined;

    try {
      const now = Date.now();
      const knownDevices = this.cloudClient.getKnownDevicesSnapshot();
      const runFullDiscovery = knownDevices.length === 0
        || (now - this.lastFullDiscoveryEpochMs) >= this.fullDiscoveryIntervalMs;

      let devices: SalusDevice[];
      if (runFullDiscovery) {
        devices = await this.cloudClient.listDevices();
        this.lastFullDiscoveryEpochMs = Date.now();
      } else {
        try {
          await this.cloudClient.refreshKnownDeviceShadows();
          devices = this.cloudClient.getKnownDevicesSnapshot();
        } catch (error) {
          this.log.info(
            `Fast Salus shadow refresh failed (${asErrorMessage(error)}). Falling back to full discovery.`,
          );
          devices = await this.cloudClient.listDevices();
          this.lastFullDiscoveryEpochMs = Date.now();
        }
        if (devices.length === 0) {
          devices = await this.cloudClient.listDevices();
          this.lastFullDiscoveryEpochMs = Date.now();
        }
      }

      const dedupedByDsn = dedupeDevicesByDsn(devices)
        .filter((device) => !shouldIgnoreInfrastructureDevice(device))
        .map((device) => ({ ...device, name: sanitizeHomeKitName(device.name, device.model || device.dsn) }));
      const uniqueDevices = dedupeDevicesByHomeKitUuid(this.api, dedupedByDsn, this.log);
      for (const device of uniqueDevices) {
        discoveredUuids.add(this.api.hap.uuid.generate(`salus:${canonicalizeDsn(device.dsn)}`));
      }

      const deviceSnapshots = await mapWithConcurrency(
        uniqueDevices,
        this.maxParallelPropertyRequests,
        async (device) => {
          try {
            const cached = this.cloudClient!.getCachedProperties(device.dsn);
            const properties = (cached && cached.size > 0)
              ? cached
              : await this.cloudClient!.listProperties(device.dsn);
            const normalizedDevice = normalizeDeviceOnlineState(device, properties);
            const profile = this.deriveProfile(normalizedDevice, properties);
            return { device: normalizedDevice, properties, profile };
          } catch (error) {
            const cachedFallback = this.cloudClient!.getCachedProperties(device.dsn);
            const fallbackProperties = cachedFallback ?? new Map();
            const normalizedDevice = normalizeDeviceOnlineState(device, fallbackProperties);
            const profile = this.deriveProfile(normalizedDevice, fallbackProperties);
            this.log.info(
              `Property sync degraded for ${device.name} (${device.dsn}): ${asErrorMessage(error)}.`
              + ` Continuing with ${cachedFallback ? 'cached' : 'empty'} properties.`,
            );
            return { device: normalizedDevice, properties: fallbackProperties, profile };
          }
        },
      );

      let updatedDeviceCount = 0;
      for (const snapshot of deviceSnapshots) {
        if (!snapshot) {
          continue;
        }
        updatedDeviceCount++;
        const uuid = this.api.hap.uuid.generate(`salus:${canonicalizeDsn(snapshot.device.dsn)}`);
        const existingAccessory = this.accessories.get(uuid);
        if (existingAccessory) {
          this.restoreOrUpdateAccessory(existingAccessory, snapshot.device, snapshot.profile, snapshot.properties);
        } else {
          this.addAccessory(snapshot.device, snapshot.profile, snapshot.properties, uuid);
        }
      }

      this.removeStaleAccessories(discoveredUuids);
      this.log.info(`Salus sync completed: ${uniqueDevices.length} device(s) discovered, ${updatedDeviceCount} device(s) refreshed.`);
      this.consecutivePollFailures = 0;
      this.successfulPollCycles += 1;
      this.lastSuccessfulPollEpochMs = Date.now();
      this.maybeLogPollHealth();
    } catch (error) {
      this.consecutivePollFailures += 1;
      this.lastFullDiscoveryEpochMs = 0;
      this.log.error(`Salus sync failed: ${asErrorMessage(error)}`);
      nextPollDelayMs = this.computeNextPollDelayMs();
      if (this.consecutivePollFailures === 1 || this.consecutivePollFailures % 3 === 0) {
        const nextDelaySeconds = Math.round(nextPollDelayMs / 1000);
        this.log.warn(
          `Salus sync has failed ${this.consecutivePollFailures} consecutive time(s).`
          + ` Next retry in ~${nextDelaySeconds}s with backoff.`,
        );
      }
      this.maybeLogPollHealth();
    } finally {
      this.pollInProgress = false;
      if (this.pollRequestedWhileBusy) {
        this.pollRequestedWhileBusy = false;
        this.schedulePoll(0);
      } else {
        this.schedulePoll(nextPollDelayMs ?? this.computeNextPollDelayMs());
      }
    }
  }

  private addAccessory(device: SalusDevice, profile: DeviceProfile, properties: SalusPropertyMap, uuid: string): void {
    const accessoryConstructor = this.api.platformAccessory as unknown as PlatformAccessoryConstructorWithInjectionState;
    if (accessoryConstructor.injectedAccessory) {
      // Defensive reset for rare stale static injection state from deserialization paths.
      // When stuck, Homebridge can return an already-bridged HAP accessory object.
      accessoryConstructor.injectedAccessory = undefined;
    }

    const accessory = new accessoryConstructor(device.name, uuid);
    const hapAccessory = (accessory as unknown as PlatformAccessoryWithHapState)._associatedHAPAccessory;
    if (hapAccessory?.bridge) {
      this.log.debug(`Accessory ${device.name} (${device.dsn}) was already bridge-associated before registration; resetting stale bridge state.`);
      // If Homebridge returned a bridged HAP accessory instance unexpectedly,
      // clear the association so dynamic registration can proceed correctly.
      hapAccessory.bridge = undefined;
      hapAccessory.bridged = false;
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

    const handler = new SalusPlatformAccessory(this, accessory, device, profile);
    handler.updateFromCloud(device, profile, properties);

    this.accessories.set(uuid, accessory);
    this.accessoryHandlers.set(uuid, handler);
    this.missingAccessoryPollCounts.delete(uuid);
    try {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`Added accessory: ${device.name} [${device.model}] (${device.dsn})`);
    } catch (error) {
      if (isDuplicateBridgeRegistrationError(error)) {
        if (!this.hasLoggedDuplicateRegisterWorkaround) {
          this.hasLoggedDuplicateRegisterWorkaround = true;
          if (this.configTyped.verboseLogging) {
            this.log.info(
              'Homebridge emitted a duplicate bridge-registration error while adding accessories.'
              + ' Keeping accessory registration state and continuing.',
            );
          }
        } else if (this.configTyped.verboseLogging) {
          this.log.debug(`Duplicate bridge-registration callback ignored for ${device.name} (${device.dsn}).`);
        }
        return;
      }
      this.accessories.delete(uuid);
      this.accessoryHandlers.delete(uuid);
      this.missingAccessoryPollCounts.delete(uuid);
      throw error;
    }
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
    const nextContextDevice = {
      id: device.id,
      dsn: device.dsn,
      key: device.key,
      model: device.model,
      name: device.name,
    };
    const contextChanged = !areContextDevicesEqual(context.device, nextContextDevice)
      || !areProfilesEquivalent(context.profile, profile);
    if (contextChanged || needsNameUpdate) {
      if (contextChanged) {
        context.device = nextContextDevice;
        context.profile = profile;
      }
      this.api.updatePlatformAccessories([accessory]);
    }

    let handler = this.accessoryHandlers.get(accessory.UUID);
    if (!handler) {
      handler = new SalusPlatformAccessory(this, accessory, device, profile);
      this.accessoryHandlers.set(accessory.UUID, handler);
    }

    handler.updateFromCloud(device, profile, properties);
  }

  private removeStaleAccessories(discoveredUuids: Set<string>): void {
    for (const uuid of discoveredUuids) {
      this.missingAccessoryPollCounts.delete(uuid);
    }

    let deferredRemovalCount = 0;
    for (const [uuid, accessory] of this.accessories) {
      if (discoveredUuids.has(uuid)) {
        continue;
      }

      const missingPollCount = (this.missingAccessoryPollCounts.get(uuid) ?? 0) + 1;
      this.missingAccessoryPollCounts.set(uuid, missingPollCount);
      if (missingPollCount < STALE_ACCESSORY_REMOVAL_GRACE_POLLS) {
        deferredRemovalCount += 1;
        continue;
      }

      this.log.info(`Removing stale accessory from cache: ${accessory.displayName}`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(uuid);
      this.accessoryHandlers.delete(uuid);
      this.missingAccessoryPollCounts.delete(uuid);
    }

    if (deferredRemovalCount > 0) {
      this.log.info(
        `Discovery temporarily omitted ${deferredRemovalCount} cached accessory(ies).`
        + ` Deferring removal until missing for ${STALE_ACCESSORY_REMOVAL_GRACE_POLLS} consecutive polls.`,
      );
    }
  }

  private deriveProfile(device: SalusDevice, properties: SalusPropertyMap): DeviceProfile {
    const catalog = getCatalogEntry(device.model);
    const propertyInferredKind = inferKindFromProperties(properties);
    const catalogInferredKind = inferKindFromCatalog(device.model);
    const kind = resolveDeviceKind(catalogInferredKind, propertyInferredKind);

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

type PlatformAccessoryWithHapState = PlatformAccessory & {
  _associatedHAPAccessory: {
    bridge?: unknown;
    bridged?: boolean;
  };
};

interface PlatformAccessoryConstructorWithInjectionState {
  new (displayName: string, uuid: string): PlatformAccessory;
  injectedAccessory?: unknown;
}

function inferKindFromProperties(properties: SalusPropertyMap): DeviceProfile['kind'] | undefined {
  if (isLikelyThermostat(properties)) {
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

function resolveDeviceKind(
  catalogInferredKind: DeviceProfile['kind'] | undefined,
  propertyInferredKind: DeviceProfile['kind'] | undefined,
): DeviceProfile['kind'] {
  if (!catalogInferredKind) {
    return propertyInferredKind ?? 'switch';
  }
  if (!propertyInferredKind || propertyInferredKind === catalogInferredKind) {
    return catalogInferredKind;
  }

  // Allow property-derived upgrade for broad catalog buckets.
  if (catalogInferredKind === 'switch' && propertyInferredKind !== 'switch') {
    return propertyInferredKind;
  }
  if (catalogInferredKind === 'temperatureSensor'
    && (propertyInferredKind === 'humiditySensor' || propertyInferredKind === 'airQualitySensor')) {
    return propertyInferredKind;
  }

  return catalogInferredKind;
}

function isLikelyThermostat(properties: SalusPropertyMap): boolean {
  if (!hasAnyPropertyBase(properties, THERMOSTAT_PROPERTY_BASES)) {
    return false;
  }

  // Generic keys like "Setpoint" appear on non-thermostat devices. Require
  // a thermostat-specific combination to reduce false positives.
  const hasSetpoint = hasAnyPropertyBase(properties, THERMOSTAT_SETPOINT_PROPERTY_BASES);
  const hasModeHint = hasAnyPropertyBase(properties, THERMOSTAT_MODE_HINT_PROPERTY_BASES);
  const hasTempHint = hasAnyPropertyBase(properties, THERMOSTAT_TEMP_HINT_PROPERTY_BASES);

  return hasSetpoint && (hasModeHint || hasTempHint);
}

function shouldIgnoreInfrastructureDevice(device: SalusDevice): boolean {
  const normalizedModel = device.model.toUpperCase();
  return normalizedModel.includes('AG1') || normalizedModel.includes('UG600') || normalizedModel.includes('WZ600');
}

function dedupeDevicesByDsn(devices: SalusDevice[]): SalusDevice[] {
  const byDsn = new Map<string, SalusDevice>();
  for (const device of devices) {
    const key = canonicalizeDsn(device.dsn);
    if (!key) {
      continue;
    }
    byDsn.set(key, device);
  }
  return [...byDsn.values()];
}

function dedupeDevicesByHomeKitUuid(api: API, devices: SalusDevice[], log: Logging): SalusDevice[] {
  const byUuid = new Map<string, SalusDevice>();
  for (const device of devices) {
    const uuid = api.hap.uuid.generate(`salus:${canonicalizeDsn(device.dsn)}`);
    const existing = byUuid.get(uuid);
    if (!existing) {
      byUuid.set(uuid, device);
      continue;
    }
    const chosen = choosePreferredDevice(existing, device);
    byUuid.set(uuid, chosen);
    if (chosen === existing) {
      log.info(
        `Discovery produced duplicate HomeKit UUID for ${existing.dsn} and ${device.dsn}.`
        + ` Keeping ${existing.dsn} and skipping ${device.dsn}.`,
      );
    } else {
      log.info(
        `Discovery produced duplicate HomeKit UUID for ${existing.dsn} and ${device.dsn}.`
        + ` Replacing with ${device.dsn}.`,
      );
    }
  }
  return [...byUuid.values()];
}

function choosePreferredDevice(left: SalusDevice, right: SalusDevice): SalusDevice {
  const leftScore = scoreDeviceForDiscoveryPreference(left);
  const rightScore = scoreDeviceForDiscoveryPreference(right);
  if (rightScore > leftScore) {
    return right;
  }
  return left;
}

function scoreDeviceForDiscoveryPreference(device: SalusDevice): number {
  let score = 0;
  if (device.model && device.model.trim() !== '') {
    score += 4;
  }
  if (device.name && device.name.trim() !== '') {
    score += 2;
  }
  if (device.productName && device.productName.trim() !== '') {
    score += 1;
  }
  if (device.online !== undefined) {
    score += 1;
  }
  return score;
}

function canonicalizeDsn(value: string): string {
  return value.trim().toLowerCase();
}

function sanitizeHomeKitName(name: string, fallback: string): string {
  const candidate = (name || fallback || '').trim();
  const normalized = candidate
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036F]/g, '')
    .replaceAll(/[^A-Za-z0-9' ]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  const trimmedEdges = normalized
    .replaceAll(/^[^A-Za-z0-9]+/g, '')
    .replaceAll(/[^A-Za-z0-9]+$/g, '')
    .trim();
  if (trimmedEdges !== '') {
    return trimmedEdges;
  }

  const fallbackNormalized = (fallback || 'Salus Device')
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036F]/g, '')
    .replaceAll(/[^A-Za-z0-9' ]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  if (fallbackNormalized !== '') {
    return fallbackNormalized;
  }
  return 'Salus Device';
}

function normalizeDeviceOnlineState(device: SalusDevice, properties: SalusPropertyMap): SalusDevice {
  if (device.online !== undefined) {
    return device;
  }

  const inferredOnline = inferOnlineStateFromProperties(properties);
  if (inferredOnline === undefined) {
    return device;
  }

  return {
    ...device,
    online: inferredOnline,
  };
}

function inferOnlineStateFromProperties(properties: SalusPropertyMap): boolean | undefined {
  const directOnline = getBooleanProperty(properties, [
    'connected',
    'OnlineState',
    'OnlineStatus_i',
    'WiFiConnected_d',
    'LANConnected_d',
    'CloudStatus',
  ]);
  if (directOnline !== undefined) {
    return directOnline;
  }

  const lostConnection = getBooleanProperty(properties, [
    'LostConnectionState',
  ]);
  if (lostConnection !== undefined) {
    return !lostConnection;
  }

  return undefined;
}

function isDuplicateBridgeRegistrationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes('already bridged');
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

function areContextDevicesEqual(
  left: PlatformAccessoryContext['device'],
  right: PlatformAccessoryContext['device'],
): boolean {
  if (!left || !right) {
    return false;
  }
  return left.id === right.id
    && left.dsn === right.dsn
    && left.key === right.key
    && left.model === right.model
    && left.name === right.name;
}

function areProfilesEquivalent(
  left: PlatformAccessoryContext['profile'],
  right: PlatformAccessoryContext['profile'],
): boolean {
  if (!left || !right) {
    return false;
  }
  return left.kind === right.kind
    && left.catalog?.model === right.catalog?.model;
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}
