/* eslint-disable @typescript-eslint/no-use-before-define */

import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { HomeKitDeviceKind } from './deviceCatalog.js';
import {
  clamp,
  encodePercentageLike,
  findPropertyByBaseName,
  getBooleanProperty,
  getNumberProperty,
  normalizePercentage,
  normalizeTemperatureFromX100,
} from './propertyUtils.js';
import type { SalusHomebridgePlatform } from './platform.js';
import type { DeviceProfile, PlatformAccessoryContext, SalusDevice, SalusPropertyMap } from './types.js';

const THERMOSTAT_CURRENT_TEMP = ['LocalTemperature_x100', 'MeasuredValue_x100', 'Temperature_x100', 'MeasuredValue'];
const THERMOSTAT_HEAT_SETPOINT = ['HeatingSetpoint_x100', 'SetHeatingSetpoint_x100', 'CloudySetpoint_x100'];
const THERMOSTAT_COOL_SETPOINT = ['CoolingSetpoint_x100', 'SetCoolingSetpoint_x100'];
const THERMOSTAT_SYSTEM_MODE = ['SystemMode', 'SetSystemMode'];
const THERMOSTAT_RUNNING_STATE = ['RunningState', 'RunningMode'];
const THERMOSTAT_HOLD_TYPE = ['HoldType', 'SetHoldType'];
const THERMOSTAT_HUMIDITY = ['RelativeHumidity', 'Humidity', 'SunnySetpoint_x100'];

const WRITE_SYSTEM_MODE = ['SetSystemMode', 'SystemMode'];
const WRITE_HEAT_SETPOINT = ['SetHeatingSetpoint_x100', 'HeatingSetpoint_x100'];
const WRITE_COOL_SETPOINT = ['SetCoolingSetpoint_x100', 'CoolingSetpoint_x100'];
const WRITE_AUTO_HEAT_SETPOINT = ['SetAutoHeatingSetpoint_x100', 'SetHeatingSetpoint_x100', 'HeatingSetpoint_x100'];
const WRITE_AUTO_COOL_SETPOINT = ['SetAutoCoolingSetpoint_x100', 'SetCoolingSetpoint_x100', 'CoolingSetpoint_x100'];
const WRITE_ON_OFF = ['SetOnOff', 'OnOff', 'ValveStatus', 'ButtonStatus', 'Mode'];
const WRITE_LEVEL = ['SetLevel', 'CurrentLevel', 'Level', 'Brightness', 'DimLevel'];
const WRITE_POSITION = ['TargetPosition', 'TargetLevel', 'CurrentLevel', 'LiftPercentage'];
const WRITE_LOCK = ['SetLockState', 'LockState', 'Lock', 'LockStatus', 'DoorLock'];
const WRITE_HOLD = ['SetHoldType', 'HoldType'];

const GENERIC_ONOFF = ['OnOff', 'ValveStatus', 'ButtonStatus', 'Mode'];
const GENERIC_LEVEL = ['CurrentLevel', 'Level', 'Brightness', 'DimLevel'];
const GENERIC_POSITION = ['CurrentPosition', 'CurrentLevel', 'LiftPercentage'];
const GENERIC_LOCK = ['LockState', 'Lock', 'LockStatus', 'DoorLock'];
const GENERIC_TEMPERATURE = ['MeasuredValue_x100', 'LocalTemperature_x100', 'Temperature_x100', 'MeasuredValue'];
const GENERIC_HUMIDITY = ['Humidity_x100', 'RelativeHumidity', 'Humidity', 'MeasuredValue'];
const GENERIC_BOOLEAN = [
  'ErrorIASZSAlarmed1',
  'ErrorIASZSAlarmed2',
  'Alarmed',
  'Leak',
  'Leakage',
  'Smoke',
  'CO',
  'Motion',
  'Occupancy',
  'Open',
];

const SALUS_MODE = {
  off: 0,
  auto: 1,
  cool: 3,
  heat: 4,
};

type TargetCharacteristicType = {
  OFF: number;
  AUTO: number;
  COOL: number;
  HEAT: number;
};

type CurrentCharacteristicType = {
  OFF: number;
  COOL: number;
  HEAT: number;
};

interface WriteTargets {
  systemMode?: string;
  holdType?: string;
  heatSetpoint?: string;
  coolSetpoint?: string;
  autoHeatSetpoint?: string;
  autoCoolSetpoint?: string;
  onOff?: string;
  brightness?: string;
  position?: string;
  lock?: string;
}

export class SalusPlatformAccessory {
  private service: Service;
  private currentKind: HomeKitDeviceKind;
  private readonly context: PlatformAccessoryContext;
  private latestProperties: SalusPropertyMap = new Map();
  private writeTargets: WriteTargets = {};
  private cachedTargetState = 0;
  private cachedSystemMode = SALUS_MODE.auto;

  constructor(
    private readonly platform: SalusHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    private device: SalusDevice,
    private profile: DeviceProfile,
  ) {
    this.context = this.accessory.context as PlatformAccessoryContext;
    this.context.device = toContextDevice(device);
    this.context.profile = profile;
    this.currentKind = profile.kind;

    this.setAccessoryInformation();
    this.service = this.ensureService(this.currentKind);
    this.configureHandlersForCurrentKind();
  }

  public updateFromCloud(device: SalusDevice, profile: DeviceProfile, properties: SalusPropertyMap): void {
    this.device = device;
    this.profile = profile;
    this.latestProperties = properties;
    this.context.device = toContextDevice(device);
    this.context.profile = profile;

    this.setAccessoryInformation();

    if (this.currentKind !== profile.kind) {
      this.currentKind = profile.kind;
      this.service = this.ensureService(this.currentKind);
      this.configureHandlersForCurrentKind();
      this.platform.log.info(`Reconfigured ${device.name} (${device.dsn}) as ${profile.kind}`);
    }

    this.service.updateCharacteristic(this.platform.Characteristic.Name, this.device.name);
    this.refreshWriteTargets();
    this.updateServiceCharacteristics();
  }

  public getCurrentKind(): HomeKitDeviceKind {
    return this.currentKind;
  }

  private setAccessoryInformation(): void {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Salus')
      .setCharacteristic(this.platform.Characteristic.Model, this.device.model || 'Unknown')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.dsn);
  }

  private ensureService(kind: HomeKitDeviceKind): Service {
    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    const existingPrimary = this.accessory.services.find((service) => service !== infoService);
    const targetServiceConstructor = this.getServiceConstructor(kind);
    const desiredServiceDisplay = this.getServiceDisplayName(kind);

    // Always recreate non-information services when kind may have changed.
    // This avoids stale characteristic handlers across service type transitions.
    void existingPrimary;

    for (const service of this.accessory.services) {
      if (service !== infoService) {
        this.accessory.removeService(service);
      }
    }

    return this.accessory.addService(targetServiceConstructor, desiredServiceDisplay, 'primary');
  }

  private configureHandlersForCurrentKind(): void {
    switch (this.currentKind) {
    case 'thermostat':
      this.configureThermostat();
      break;
    case 'switch':
      this.configureSwitch();
      break;
    case 'outlet':
      this.configureOutlet();
      break;
    case 'lightbulb':
      this.configureLightbulb();
      break;
    case 'windowCovering':
      this.configureWindowCovering();
      break;
    case 'valve':
      this.configureValve();
      break;
    case 'lock':
      this.configureLock();
      break;
    case 'motionSensor':
    case 'contactSensor':
    case 'leakSensor':
    case 'smokeSensor':
    case 'carbonMonoxideSensor':
    case 'temperatureSensor':
    case 'humiditySensor':
    case 'airQualitySensor':
    case 'occupancySensor':
      break;
    default:
      this.configureSwitch();
      break;
    }
  }

  private configureThermostat(): void {
    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .updateValue(this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS);

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature).setProps({
      minValue: -40,
      maxValue: 100,
      minStep: 0.1,
    });

    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature).setProps({
      minValue: 4.5,
      maxValue: 35,
      minStep: 0.5,
    }).onSet(this.setTargetTemperature.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState).onSet(this.setTargetHeatingCoolingState.bind(this));
  }

  private configureSwitch(): void {
    this.service.getCharacteristic(this.platform.Characteristic.On).onSet(this.setOnOff.bind(this));
  }

  private configureOutlet(): void {
    this.service.getCharacteristic(this.platform.Characteristic.On).onSet(this.setOnOff.bind(this));
  }

  private configureLightbulb(): void {
    this.service.getCharacteristic(this.platform.Characteristic.On).onSet(this.setOnOff.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.Brightness).setProps({
      minValue: 0,
      maxValue: 100,
      minStep: 1,
    }).onSet(this.setBrightness.bind(this));
  }

  private configureWindowCovering(): void {
    this.service.getCharacteristic(this.platform.Characteristic.TargetPosition).onSet(this.setTargetPosition.bind(this));
  }

  private configureValve(): void {
    this.service.getCharacteristic(this.platform.Characteristic.Active).onSet(this.setValveActive.bind(this));
  }

  private configureLock(): void {
    this.service.getCharacteristic(this.platform.Characteristic.LockTargetState).onSet(this.setLockTargetState.bind(this));
  }

  private refreshWriteTargets(): void {
    this.writeTargets = {
      systemMode: findPropertyByBaseName(this.latestProperties, WRITE_SYSTEM_MODE),
      holdType: findPropertyByBaseName(this.latestProperties, WRITE_HOLD),
      heatSetpoint: findPropertyByBaseName(this.latestProperties, WRITE_HEAT_SETPOINT),
      coolSetpoint: findPropertyByBaseName(this.latestProperties, WRITE_COOL_SETPOINT),
      autoHeatSetpoint: findPropertyByBaseName(this.latestProperties, WRITE_AUTO_HEAT_SETPOINT),
      autoCoolSetpoint: findPropertyByBaseName(this.latestProperties, WRITE_AUTO_COOL_SETPOINT),
      onOff: findPropertyByBaseName(this.latestProperties, WRITE_ON_OFF),
      brightness: findPropertyByBaseName(this.latestProperties, WRITE_LEVEL),
      position: findPropertyByBaseName(this.latestProperties, WRITE_POSITION),
      lock: findPropertyByBaseName(this.latestProperties, WRITE_LOCK),
    };
  }

  private updateServiceCharacteristics(): void {
    switch (this.currentKind) {
    case 'thermostat':
      this.updateThermostatCharacteristics();
      break;
    case 'switch':
      this.updateSwitchCharacteristics();
      break;
    case 'outlet':
      this.updateOutletCharacteristics();
      break;
    case 'lightbulb':
      this.updateLightbulbCharacteristics();
      break;
    case 'windowCovering':
      this.updateWindowCoveringCharacteristics();
      break;
    case 'valve':
      this.updateValveCharacteristics();
      break;
    case 'lock':
      this.updateLockCharacteristics();
      break;
    case 'motionSensor':
      this.updateMotionSensorCharacteristics();
      break;
    case 'contactSensor':
      this.updateContactSensorCharacteristics();
      break;
    case 'leakSensor':
      this.updateLeakSensorCharacteristics();
      break;
    case 'smokeSensor':
      this.updateSmokeSensorCharacteristics();
      break;
    case 'carbonMonoxideSensor':
      this.updateCarbonMonoxideCharacteristics();
      break;
    case 'temperatureSensor':
      this.updateTemperatureSensorCharacteristics();
      break;
    case 'humiditySensor':
      this.updateHumiditySensorCharacteristics();
      break;
    case 'airQualitySensor':
      this.updateAirQualityCharacteristics();
      break;
    case 'occupancySensor':
      this.updateOccupancySensorCharacteristics();
      break;
    default:
      this.updateSwitchCharacteristics();
      break;
    }
  }

  private updateThermostatCharacteristics(): void {
    const currentTempRaw = getNumberProperty(this.latestProperties, THERMOSTAT_CURRENT_TEMP);
    const heatingSetpointRaw = getNumberProperty(this.latestProperties, THERMOSTAT_HEAT_SETPOINT);
    const coolingSetpointRaw = getNumberProperty(this.latestProperties, THERMOSTAT_COOL_SETPOINT);
    const systemModeRaw = getNumberProperty(this.latestProperties, THERMOSTAT_SYSTEM_MODE);
    const runningStateRaw = getNumberProperty(this.latestProperties, THERMOSTAT_RUNNING_STATE);
    const holdTypeRaw = getNumberProperty(this.latestProperties, THERMOSTAT_HOLD_TYPE);
    const humidityRaw = getNumberProperty(this.latestProperties, THERMOSTAT_HUMIDITY);

    if (systemModeRaw !== undefined) {
      this.cachedSystemMode = Math.round(systemModeRaw);
    }

    const currentTemp = currentTempRaw !== undefined
      ? clamp(normalizeTemperatureFromX100(currentTempRaw), -40, 100)
      : undefined;
    const heatingSetpoint = heatingSetpointRaw !== undefined
      ? clamp(normalizeTemperatureFromX100(heatingSetpointRaw), 4.5, 35)
      : undefined;
    const coolingSetpoint = coolingSetpointRaw !== undefined
      ? clamp(normalizeTemperatureFromX100(coolingSetpointRaw), 4.5, 35)
      : undefined;

    const targetState = mapSystemModeToTargetState(this.platform.Characteristic.TargetHeatingCoolingState, this.cachedSystemMode, holdTypeRaw);
    const currentState = mapRunningStateToCurrentState(this.platform.Characteristic.CurrentHeatingCoolingState, runningStateRaw, holdTypeRaw);
    this.cachedTargetState = targetState;

    let targetTemp = heatingSetpoint ?? coolingSetpoint ?? 21;
    if (targetState === this.platform.Characteristic.TargetHeatingCoolingState.COOL && coolingSetpoint !== undefined) {
      targetTemp = coolingSetpoint;
    }
    if (targetState === this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
      targetTemp = heatingSetpoint ?? coolingSetpoint ?? targetTemp;
    }

    if (currentTemp !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, currentTemp);
    }
    this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, targetTemp);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, targetState);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, currentState);

    if (humidityRaw !== undefined) {
      const humidity = humidityRaw > 100 ? humidityRaw / 100 : humidityRaw;
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, clamp(humidity, 0, 100));
    }
  }

  private updateSwitchCharacteristics(): void {
    const on = this.resolveOnOffState();
    if (on !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.On, on);
    }
  }

  private updateOutletCharacteristics(): void {
    const on = this.resolveOnOffState();
    if (on !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.On, on);
      this.service.updateCharacteristic(this.platform.Characteristic.OutletInUse, on);
    }
  }

  private updateLightbulbCharacteristics(): void {
    const on = this.resolveOnOffState();
    if (on !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.On, on);
    }

    const brightnessValue = normalizePercentage(this.getPropertyValue(this.writeTargets.brightness))
      ?? normalizePercentage(getNumberProperty(this.latestProperties, GENERIC_LEVEL));
    if (brightnessValue !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightnessValue);
    }
  }

  private updateWindowCoveringCharacteristics(): void {
    const percentage = normalizePercentage(this.getPropertyValue(this.writeTargets.position))
      ?? normalizePercentage(getNumberProperty(this.latestProperties, GENERIC_POSITION));
    if (percentage === undefined) {
      return;
    }
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, percentage);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, percentage);
    this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.platform.Characteristic.PositionState.STOPPED);
  }

  private updateValveCharacteristics(): void {
    const active = this.resolveOnOffState();
    if (active === undefined) {
      return;
    }
    const hkActive = active ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
    const hkInUse = active ? this.platform.Characteristic.InUse.IN_USE : this.platform.Characteristic.InUse.NOT_IN_USE;
    this.service.updateCharacteristic(this.platform.Characteristic.Active, hkActive);
    this.service.updateCharacteristic(this.platform.Characteristic.InUse, hkInUse);
    this.service.updateCharacteristic(this.platform.Characteristic.ValveType, this.platform.Characteristic.ValveType.GENERIC_VALVE);
  }

  private updateLockCharacteristics(): void {
    const locked = this.resolveLockState();
    if (locked === undefined) {
      return;
    }
    const current = locked
      ? this.platform.Characteristic.LockCurrentState.SECURED
      : this.platform.Characteristic.LockCurrentState.UNSECURED;
    const target = locked
      ? this.platform.Characteristic.LockTargetState.SECURED
      : this.platform.Characteristic.LockTargetState.UNSECURED;
    this.service.updateCharacteristic(this.platform.Characteristic.LockCurrentState, current);
    this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState, target);
  }

  private updateMotionSensorCharacteristics(): void {
    const value = this.resolveGenericBoolean();
    if (value !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.MotionDetected, value);
    }
  }

  private updateContactSensorCharacteristics(): void {
    const value = this.resolveGenericBoolean();
    if (value !== undefined) {
      const state = value
        ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED;
      this.service.updateCharacteristic(this.platform.Characteristic.ContactSensorState, state);
    }
  }

  private updateLeakSensorCharacteristics(): void {
    const value = this.resolveGenericBoolean();
    if (value !== undefined) {
      const state = value
        ? this.platform.Characteristic.LeakDetected.LEAK_DETECTED
        : this.platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
      this.service.updateCharacteristic(this.platform.Characteristic.LeakDetected, state);
    }
  }

  private updateSmokeSensorCharacteristics(): void {
    const value = this.resolveGenericBoolean();
    if (value !== undefined) {
      const state = value
        ? this.platform.Characteristic.SmokeDetected.SMOKE_DETECTED
        : this.platform.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
      this.service.updateCharacteristic(this.platform.Characteristic.SmokeDetected, state);
    }
  }

  private updateCarbonMonoxideCharacteristics(): void {
    const value = this.resolveGenericBoolean();
    if (value !== undefined) {
      const state = value
        ? this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
        : this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL;
      this.service.updateCharacteristic(this.platform.Characteristic.CarbonMonoxideDetected, state);
    }
  }

  private updateTemperatureSensorCharacteristics(): void {
    const tempRaw = getNumberProperty(this.latestProperties, GENERIC_TEMPERATURE);
    if (tempRaw !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, clamp(normalizeTemperatureFromX100(tempRaw), -40, 100));
    }
  }

  private updateHumiditySensorCharacteristics(): void {
    const humidityRaw = getNumberProperty(this.latestProperties, GENERIC_HUMIDITY);
    if (humidityRaw !== undefined) {
      const humidity = humidityRaw > 100 ? humidityRaw / 100 : humidityRaw;
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, clamp(humidity, 0, 100));
    }
  }

  private updateAirQualityCharacteristics(): void {
    const co2 = getNumberProperty(this.latestProperties, ['MeasuredValue', 'CO2', 'CarbonDioxide']);
    if (co2 === undefined) {
      return;
    }

    this.service.updateCharacteristic(this.platform.Characteristic.CarbonDioxideLevel, co2);
    if (co2 >= 1000) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.CarbonDioxideDetected,
        this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL,
      );
      this.service.updateCharacteristic(this.platform.Characteristic.AirQuality, this.platform.Characteristic.AirQuality.POOR);
    } else {
      this.service.updateCharacteristic(
        this.platform.Characteristic.CarbonDioxideDetected,
        this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL,
      );
      this.service.updateCharacteristic(this.platform.Characteristic.AirQuality, this.platform.Characteristic.AirQuality.EXCELLENT);
    }
  }

  private updateOccupancySensorCharacteristics(): void {
    const value = this.resolveGenericBoolean();
    if (value !== undefined) {
      const occupancy = value
        ? this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
      this.service.updateCharacteristic(this.platform.Characteristic.OccupancyDetected, occupancy);
    }
  }

  private resolveOnOffState(): boolean | undefined {
    const direct = getBooleanProperty(this.latestProperties, GENERIC_ONOFF);
    if (direct !== undefined) {
      return direct;
    }
    const brightness = normalizePercentage(getNumberProperty(this.latestProperties, GENERIC_LEVEL));
    if (brightness !== undefined) {
      return brightness > 0;
    }
    return undefined;
  }

  private resolveLockState(): boolean | undefined {
    const bool = getBooleanProperty(this.latestProperties, GENERIC_LOCK);
    if (bool !== undefined) {
      return bool;
    }
    const numeric = getNumberProperty(this.latestProperties, GENERIC_LOCK);
    if (numeric !== undefined) {
      return numeric !== 0;
    }
    return undefined;
  }

  private resolveGenericBoolean(): boolean | undefined {
    const direct = getBooleanProperty(this.latestProperties, GENERIC_BOOLEAN);
    if (direct !== undefined) {
      return direct;
    }
    const fallback = getNumberProperty(this.latestProperties, GENERIC_BOOLEAN);
    if (fallback !== undefined) {
      return fallback !== 0;
    }
    return undefined;
  }

  private getPropertyValue(name: string | undefined): unknown {
    if (!name) {
      return undefined;
    }
    return this.latestProperties.get(name)?.value;
  }

  private async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    const targetTemperature = clamp(Number(value), 4.5, 35);
    const scaled = Math.round(targetTemperature * 100);
    const targetState = this.cachedTargetState;

    const writes: Array<{ property: string; value: unknown }> = [];

    if (targetState === this.platform.Characteristic.TargetHeatingCoolingState.COOL) {
      if (this.writeTargets.coolSetpoint) {
        writes.push({ property: this.writeTargets.coolSetpoint, value: scaled });
      }
    } else if (targetState === this.platform.Characteristic.TargetHeatingCoolingState.AUTO) {
      if (this.writeTargets.autoHeatSetpoint) {
        writes.push({ property: this.writeTargets.autoHeatSetpoint, value: scaled });
      }
      if (this.writeTargets.autoCoolSetpoint) {
        writes.push({ property: this.writeTargets.autoCoolSetpoint, value: scaled });
      }
    } else if (targetState === this.platform.Characteristic.TargetHeatingCoolingState.HEAT) {
      if (this.writeTargets.heatSetpoint) {
        writes.push({ property: this.writeTargets.heatSetpoint, value: scaled });
      }
    }

    if (writes.length === 0) {
      throw this.communicationFailure('No writable thermostat setpoint property was discovered');
    }

    for (const write of writes) {
      await this.platform.writeDeviceProperty(this.device, write.property, write.value);
    }
    this.platform.log.info(`Set thermostat target for ${this.device.name} to ${targetTemperature.toFixed(1)}°C`);
  }

  private async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    const hkState = Number(value) as number;
    let mode = SALUS_MODE.auto;
    if (hkState === this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
      mode = SALUS_MODE.off;
    } else if (hkState === this.platform.Characteristic.TargetHeatingCoolingState.COOL) {
      mode = SALUS_MODE.cool;
    } else if (hkState === this.platform.Characteristic.TargetHeatingCoolingState.HEAT) {
      mode = SALUS_MODE.heat;
    }

    if (!this.writeTargets.systemMode) {
      throw this.communicationFailure('No writable system mode property was discovered');
    }
    await this.platform.writeDeviceProperty(this.device, this.writeTargets.systemMode, mode);

    if (mode === SALUS_MODE.off && this.writeTargets.holdType) {
      await this.platform.writeDeviceProperty(this.device, this.writeTargets.holdType, 7);
    }

    this.cachedTargetState = hkState;
    this.cachedSystemMode = mode;
    this.platform.log.info(`Set thermostat mode for ${this.device.name} to ${hkState}`);
  }

  private async setOnOff(value: CharacteristicValue): Promise<void> {
    const on = Boolean(value);
    const property = this.writeTargets.onOff ?? this.writeTargets.brightness;
    if (!property) {
      throw this.communicationFailure('No writable On/Off property was discovered');
    }

    if (property === this.writeTargets.brightness) {
      await this.setBrightness(on ? 100 : 0);
      return;
    }

    await this.platform.writeDeviceProperty(this.device, property, on ? 1 : 0);
    this.platform.log.info(`Set On/Off for ${this.device.name} to ${on}`);
  }

  private async setBrightness(value: CharacteristicValue): Promise<void> {
    const target = clamp(Number(value), 0, 100);
    const property = this.writeTargets.brightness;
    if (!property) {
      throw this.communicationFailure('No writable brightness property was discovered');
    }

    const sample = this.getPropertyValue(property);
    let outgoingValue: number | string = target;
    if (typeof sample === 'number' && sample > 100) {
      outgoingValue = Math.round((target / 100) * 255);
    } else if (typeof sample === 'string') {
      outgoingValue = encodePercentageLike(sample, target);
    }

    await this.platform.writeDeviceProperty(this.device, property, outgoingValue);
    this.platform.log.info(`Set brightness for ${this.device.name} to ${target}%`);
  }

  private async setTargetPosition(value: CharacteristicValue): Promise<void> {
    const target = clamp(Number(value), 0, 100);
    const property = this.writeTargets.position;
    if (!property) {
      throw this.communicationFailure('No writable position property was discovered');
    }

    const sample = this.getPropertyValue(property);
    const outgoingValue = encodePercentageLike(sample, target);
    await this.platform.writeDeviceProperty(this.device, property, outgoingValue);
    this.platform.log.info(`Set position for ${this.device.name} to ${target}%`);
  }

  private async setValveActive(value: CharacteristicValue): Promise<void> {
    const active = Number(value) === this.platform.Characteristic.Active.ACTIVE;
    const property = this.writeTargets.onOff;
    if (!property) {
      throw this.communicationFailure('No writable valve property was discovered');
    }
    await this.platform.writeDeviceProperty(this.device, property, active ? 1 : 0);
    this.platform.log.info(`Set valve for ${this.device.name} to ${active ? 'active' : 'inactive'}`);
  }

  private async setLockTargetState(value: CharacteristicValue): Promise<void> {
    const shouldLock = Number(value) === this.platform.Characteristic.LockTargetState.SECURED;
    const property = this.writeTargets.lock;
    if (!property) {
      throw this.communicationFailure('No writable lock property was discovered');
    }
    await this.platform.writeDeviceProperty(this.device, property, shouldLock ? 1 : 0);
    this.platform.log.info(`Set lock for ${this.device.name} to ${shouldLock ? 'secured' : 'unsecured'}`);
  }

  private communicationFailure(message: string): Error {
    this.platform.log.error(`${message} [${this.device.name} / ${this.device.dsn}]`);
    return new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private getServiceDisplayName(kind: HomeKitDeviceKind): string {
    if (kind === 'thermostat') {
      return 'Thermostat';
    }
    if (kind === 'windowCovering') {
      return 'Window Covering';
    }
    if (kind === 'contactSensor') {
      return 'Contact';
    }
    if (kind === 'motionSensor') {
      return 'Motion';
    }
    if (kind === 'leakSensor') {
      return 'Leak';
    }
    if (kind === 'smokeSensor') {
      return 'Smoke';
    }
    if (kind === 'carbonMonoxideSensor') {
      return 'Carbon Monoxide';
    }
    if (kind === 'temperatureSensor') {
      return 'Temperature';
    }
    if (kind === 'humiditySensor') {
      return 'Humidity';
    }
    if (kind === 'airQualitySensor') {
      return 'Air Quality';
    }
    if (kind === 'occupancySensor') {
      return 'Occupancy';
    }
    if (kind === 'lightbulb') {
      return 'Light';
    }
    if (kind === 'outlet') {
      return 'Outlet';
    }
    if (kind === 'valve') {
      return 'Valve';
    }
    if (kind === 'lock') {
      return 'Lock';
    }
    return 'Switch';
  }

  private getServiceConstructor(kind: HomeKitDeviceKind): typeof Service {
    switch (kind) {
    case 'thermostat':
      return this.platform.Service.Thermostat;
    case 'switch':
      return this.platform.Service.Switch;
    case 'outlet':
      return this.platform.Service.Outlet;
    case 'lightbulb':
      return this.platform.Service.Lightbulb;
    case 'windowCovering':
      return this.platform.Service.WindowCovering;
    case 'valve':
      return this.platform.Service.Valve;
    case 'lock':
      return this.platform.Service.LockMechanism;
    case 'motionSensor':
      return this.platform.Service.MotionSensor;
    case 'contactSensor':
      return this.platform.Service.ContactSensor;
    case 'leakSensor':
      return this.platform.Service.LeakSensor;
    case 'smokeSensor':
      return this.platform.Service.SmokeSensor;
    case 'carbonMonoxideSensor':
      return this.platform.Service.CarbonMonoxideSensor;
    case 'temperatureSensor':
      return this.platform.Service.TemperatureSensor;
    case 'humiditySensor':
      return this.platform.Service.HumiditySensor;
    case 'airQualitySensor':
      return this.platform.Service.AirQualitySensor;
    case 'occupancySensor':
      return this.platform.Service.OccupancySensor;
    default:
      return this.platform.Service.Switch;
    }
  }
}

function toContextDevice(device: SalusDevice): NonNullable<PlatformAccessoryContext['device']> {
  return {
    id: device.id,
    dsn: device.dsn,
    key: device.key,
    model: device.model,
    name: device.name,
  };
}

function mapSystemModeToTargetState(
  characteristic: TargetCharacteristicType,
  systemModeRaw: number,
  holdTypeRaw: number | undefined,
): number {
  if (holdTypeRaw !== undefined && Math.round(holdTypeRaw) === 7) {
    return characteristic.OFF;
  }
  const systemMode = Math.round(systemModeRaw);
  if (systemMode === SALUS_MODE.off) {
    return characteristic.OFF;
  }
  if (systemMode === SALUS_MODE.cool) {
    return characteristic.COOL;
  }
  if (systemMode === SALUS_MODE.heat || systemMode === 5) {
    return characteristic.HEAT;
  }
  return characteristic.AUTO;
}

function mapRunningStateToCurrentState(
  characteristic: CurrentCharacteristicType,
  runningStateRaw: number | undefined,
  holdTypeRaw: number | undefined,
): number {
  if (holdTypeRaw !== undefined && Math.round(holdTypeRaw) === 7) {
    return characteristic.OFF;
  }
  if (runningStateRaw === undefined) {
    return characteristic.OFF;
  }

  const normalized = Math.round(runningStateRaw);
  if (normalized === 0) {
    return characteristic.OFF;
  }
  if (normalized === 1 || normalized === 4) {
    return characteristic.HEAT;
  }
  if (normalized === 2 || normalized === 3) {
    return characteristic.COOL;
  }

  const asBits = normalized.toString(2).padStart(8, '0').split('').reverse();
  if (asBits[0] === '1' || asBits[4] === '1') {
    return characteristic.HEAT;
  }
  if (asBits[1] === '1' || asBits[3] === '1') {
    return characteristic.COOL;
  }
  return characteristic.OFF;
}
