/* eslint-disable @typescript-eslint/no-use-before-define */

import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { HomeKitDeviceKind } from './deviceCatalog.js';
import {
  clamp,
  encodeBooleanLike,
  encodePercentageLike,
  findPropertyByBaseName,
  getBooleanProperty,
  getNumberProperty,
  normalizePercentage,
  normalizeTemperatureFromX100,
  parseNumberLike,
} from './propertyUtils.js';
import type { SalusHomebridgePlatform } from './platform.js';
import type { DeviceProfile, PlatformAccessoryContext, SalusDevice, SalusPropertyMap } from './types.js';

const THERMOSTAT_CURRENT_TEMP = [
  'LocalTemperature_x100',
  'CurrentTemperature_x100',
  'PresentValue_x100',
  'CurrentValue_x100',
  'Temperature_x100',
  'MeasuredValue_x100',
  'LocalTemperature',
  'CurrentTemperature',
  'PresentValue',
  'CurrentValue',
  'RoomTemperature_x100',
  'RoomTemperature',
  'Temperature',
  'MeasuredValue',
];
const THERMOSTAT_HEAT_SETPOINT_EFFECTIVE = [
  'HeatingSetpoint_x100',
  'HeatingSetpoint_x100_a',
  'HeatingSetpoint',
  'HeatingSetpoint_a',
  'TargetTemperature_x100',
  'TargetTemperature',
  'Setpoint_x100',
  'Setpoint',
];
const THERMOSTAT_HEAT_SETPOINT_COMMAND = [
  'SetHeatingSetpoint_x100',
  'SetHeatingSetpoint_x100_a',
  'SetHeatingSetpoint',
  'SetHeatingSetpoint_a',
  'SetTargetTemperature_x100',
  'SetTargetTemperature',
];
const THERMOSTAT_COOL_SETPOINT_EFFECTIVE = [
  'CoolingSetpoint_x100',
  'CoolingSetpoint_x100_a',
  'CoolingSetpoint',
  'CoolingSetpoint_a',
  'TargetTemperature_x100',
  'TargetTemperature',
  'Setpoint_x100',
  'Setpoint',
];
const THERMOSTAT_COOL_SETPOINT_COMMAND = [
  'SetCoolingSetpoint_x100',
  'SetCoolingSetpoint_x100_a',
  'SetCoolingSetpoint',
  'SetCoolingSetpoint_a',
  'SetTargetTemperature_x100',
  'SetTargetTemperature',
];
const THERMOSTAT_SYSTEM_MODE = ['SystemMode', 'SetSystemMode'];
const THERMOSTAT_RUNNING_STATE = ['RunningState', 'RunningMode'];
const THERMOSTAT_HOLD_TYPE = ['HoldType', 'SetHoldType'];
const THERMOSTAT_HUMIDITY = ['RelativeHumidity_x100', 'RelativeHumidity', 'Humidity_x100', 'Humidity'];

const WRITE_SYSTEM_MODE = ['SetSystemMode', 'SystemMode'];
const WRITE_HEAT_SETPOINT = [
  'SetHeatingSetpoint_x100',
  'SetTargetTemperature_x100',
  'HeatingSetpoint_x100',
  'TargetTemperature_x100',
  'Setpoint_x100',
  'CloudySetpoint_x100',
  'SetTargetTemperature',
  'SetHeatingSetpoint',
  'HeatingSetpoint',
  'TargetTemperature',
  'Setpoint',
  'CloudySetpoint',
];
const WRITE_COOL_SETPOINT = [
  'SetCoolingSetpoint_x100',
  'SetTargetTemperature_x100',
  'CoolingSetpoint_x100',
  'TargetTemperature_x100',
  'Setpoint_x100',
  'SunnySetpoint_x100',
  'SetTargetTemperature',
  'SetCoolingSetpoint',
  'CoolingSetpoint',
  'TargetTemperature',
  'Setpoint',
  'SunnySetpoint',
];
const WRITE_AUTO_HEAT_SETPOINT = [
  'SetAutoHeatingSetpoint_x100',
  'SetHeatingSetpoint_x100',
  'SetTargetTemperature_x100',
  'HeatingSetpoint_x100',
  'TargetTemperature_x100',
  'Setpoint_x100',
  'CloudySetpoint_x100',
  'SetAutoHeatingSetpoint',
  'SetHeatingSetpoint',
  'SetTargetTemperature',
  'HeatingSetpoint',
  'TargetTemperature',
  'Setpoint',
  'CloudySetpoint',
];
const WRITE_AUTO_COOL_SETPOINT = [
  'SetAutoCoolingSetpoint_x100',
  'SetCoolingSetpoint_x100',
  'SetTargetTemperature_x100',
  'CoolingSetpoint_x100',
  'TargetTemperature_x100',
  'Setpoint_x100',
  'SunnySetpoint_x100',
  'SetAutoCoolingSetpoint',
  'SetCoolingSetpoint',
  'SetTargetTemperature',
  'CoolingSetpoint',
  'TargetTemperature',
  'Setpoint',
  'SunnySetpoint',
];
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
const THERMOSTAT_APPLY_TOLERANCE_C = 0.4;
const THERMOSTAT_OPTIMISTIC_TARGET_TTL_MS = 60_000;

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

interface OptimisticThermostatTarget {
  valueC: number;
  expiresAtEpochMs: number;
  writeSequence: number;
}

export class SalusPlatformAccessory {
  private service: Service;
  private currentKind: HomeKitDeviceKind;
  private readonly context: PlatformAccessoryContext;
  private latestProperties: SalusPropertyMap = new Map();
  private writeTargets: WriteTargets = {};
  private cachedTargetState = 0;
  private cachedSystemMode = SALUS_MODE.auto;
  private thermostatSetpointWriteSequence = 0;
  private optimisticThermostatTarget: OptimisticThermostatTarget | null = null;

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
    this.applyDeviceReachabilityState();
    this.refreshWriteTargets();
    this.updateServiceCharacteristics();
  }

  private applyDeviceReachabilityState(): void {
    if (typeof this.device.online !== 'boolean') {
      return;
    }

    const expectedReachable = this.device.online;
    const hapAccessory = (this.accessory as unknown as {
      _associatedHAPAccessory?: { reachable?: boolean };
    })._associatedHAPAccessory;
    if (hapAccessory && hapAccessory.reachable !== expectedReachable) {
      hapAccessory.reachable = expectedReachable;
      this.platform.log.info(
        `${this.device.name} (${this.device.dsn}) marked as ${expectedReachable ? 'reachable' : 'unreachable'} based on Salus cloud online state.`,
      );
    }

    if (this.service.testCharacteristic(this.platform.Characteristic.StatusActive)) {
      const statusActive = expectedReachable ? 1 : 0;
      this.service.updateCharacteristic(this.platform.Characteristic.StatusActive, statusActive);
    }

    if (this.service.testCharacteristic(this.platform.Characteristic.StatusFault)) {
      const statusFault = expectedReachable
        ? this.platform.Characteristic.StatusFault.NO_FAULT
        : this.platform.Characteristic.StatusFault.GENERAL_FAULT;
      this.service.updateCharacteristic(this.platform.Characteristic.StatusFault, statusFault);
    }
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

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState).setProps({
      validValues: [
        this.platform.Characteristic.TargetHeatingCoolingState.OFF,
        this.platform.Characteristic.TargetHeatingCoolingState.HEAT,
      ],
    }).onSet(this.setTargetHeatingCoolingState.bind(this));
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
    const heatingSetpointRaw = this.resolveEffectiveThermostatSetpoint(
      THERMOSTAT_HEAT_SETPOINT_EFFECTIVE,
      THERMOSTAT_HEAT_SETPOINT_COMMAND,
    );
    const coolingSetpointRaw = this.resolveEffectiveThermostatSetpoint(
      THERMOSTAT_COOL_SETPOINT_EFFECTIVE,
      THERMOSTAT_COOL_SETPOINT_COMMAND,
    );
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

    let targetTemp: number | undefined;
    targetTemp = heatingSetpoint ?? coolingSetpoint;
    if (targetTemp === undefined) {
      targetTemp = currentTemp;
    }
    if (targetTemp === undefined) {
      const previousTargetRaw = this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature).value;
      const previousTarget = previousTargetRaw === null ? undefined : parseCharacteristicNumber(previousTargetRaw);
      if (previousTarget !== undefined) {
        targetTemp = clamp(previousTarget, 4.5, 35);
      }
    }

    const optimisticTarget = this.getActiveOptimisticThermostatTarget();
    if (optimisticTarget) {
      targetTemp = clamp(optimisticTarget.valueC, 4.5, 35);
      if (heatingSetpoint !== undefined && Math.abs(heatingSetpoint - optimisticTarget.valueC) <= THERMOSTAT_APPLY_TOLERANCE_C) {
        this.optimisticThermostatTarget = null;
      }
    }

    if (currentTemp !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, currentTemp);
    }
    if (targetTemp !== undefined) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.TargetTemperature,
        clamp(targetTemp, 4.5, 35),
      );
    }
    this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, targetState);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, currentState);

    if (humidityRaw !== undefined) {
      const humidity = humidityRaw > 100 ? humidityRaw / 100 : humidityRaw;
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, clamp(humidity, 0, 100));
    }
  }

  private resolveEffectiveThermostatSetpoint(
    effectiveCandidates: string[],
    commandCandidates: string[],
  ): number | undefined {
    const primaryRaw = getNumberProperty(this.latestProperties, effectiveCandidates);
    const commandRaw = getNumberProperty(this.latestProperties, commandCandidates);

    if (primaryRaw !== undefined) {
      return primaryRaw;
    }

    return commandRaw;
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
    const co2Raw = getNumberProperty(this.latestProperties, [
      'MeasuredValue',
      'MeasuredValue_x100',
      'CO2',
      'CO2_x100',
      'CarbonDioxide',
      'CarbonDioxide_x100',
    ]);
    if (co2Raw === undefined) {
      return;
    }
    const co2 = co2Raw > 10_000 ? Math.round(co2Raw / 100) : Math.round(co2Raw);
    const boundedCo2 = clamp(co2, 0, 100_000);

    this.service.updateCharacteristic(this.platform.Characteristic.CarbonDioxideLevel, boundedCo2);
    if (boundedCo2 >= 1000) {
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

  private firstDefined(...candidates: Array<string | undefined>): string | undefined {
    for (const candidate of candidates) {
      if (candidate && candidate.trim() !== '') {
        return candidate;
      }
    }
    return undefined;
  }

  private encodeThermostatTemperatureForProperty(propertyName: string, temperatureC: number): number {
    const sample = this.getPropertyValue(propertyName);
    const numericSample = parseNumberLike(sample);
    const normalizedName = propertyName.trim().toLowerCase();
    const looksLikeX100 = normalizedName.includes('_x100')
      || normalizedName.endsWith('x100')
      || (numericSample !== undefined && Math.abs(numericSample) >= 100);
    if (looksLikeX100) {
      return Math.round(temperatureC * 100);
    }
    return Math.round(temperatureC * 10) / 10;
  }

  private async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    const numericValue = parseCharacteristicNumber(value);
    if (numericValue === undefined) {
      throw this.communicationFailure('Received invalid thermostat target temperature value from HomeKit');
    }

    const targetTemperature = clamp(numericValue, 4.5, 35);
    const writeSequence = ++this.thermostatSetpointWriteSequence;
    this.setOptimisticThermostatTarget(targetTemperature, writeSequence);

    const setpointProperty = this.firstDefined(
      this.writeTargets.heatSetpoint,
      this.writeTargets.autoHeatSetpoint,
      findPropertyByBaseName(this.latestProperties, THERMOSTAT_HEAT_SETPOINT_COMMAND),
      findPropertyByBaseName(this.latestProperties, THERMOSTAT_HEAT_SETPOINT_EFFECTIVE),
      this.writeTargets.coolSetpoint,
      this.writeTargets.autoCoolSetpoint,
      findPropertyByBaseName(this.latestProperties, THERMOSTAT_COOL_SETPOINT_COMMAND),
    );
    if (!setpointProperty) {
      throw this.communicationFailure('No writable thermostat setpoint property was discovered');
    }

    const writes: Record<string, unknown> = {
      [setpointProperty]: this.encodeThermostatTemperatureForProperty(setpointProperty, targetTemperature),
    };

    // Match Salus app behavior: changing target temperature forces working/manual mode.
    if (this.writeTargets.systemMode) {
      writes[this.writeTargets.systemMode] = SALUS_MODE.heat;
    }
    if (this.writeTargets.holdType) {
      writes[this.writeTargets.holdType] = 2;
    }

    try {
      await this.platform.writeDeviceProperties(this.device, writes);
    } catch (error) {
      if (this.optimisticThermostatTarget?.writeSequence === writeSequence) {
        this.optimisticThermostatTarget = null;
      }
      this.platform.log.error(`Thermostat target write failed for ${this.device.name}: ${asErrorMessage(error)}`);
      throw this.communicationFailure('Thermostat target temperature write failed');
    }

    this.cachedTargetState = this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
    this.cachedSystemMode = SALUS_MODE.heat;
    this.platform.log.info(`Set thermostat target for ${this.device.name} to ${targetTemperature.toFixed(1)}°C`);
    void this.confirmThermostatTargetInBackground(targetTemperature, writeSequence);
  }

  private async ensureThermostatTargetApplied(
    expectedTemperatureC: number,
    writeSequence: number,
  ): Promise<'applied' | 'superseded' | 'pending'> {
    const maxAttempts = 10;
    let lastObserved: number | undefined;
    let lastPrimaryObserved: number | undefined;
    let lastCommandObserved: number | undefined;
    let lastError: unknown;
    let sawCommandMatch = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (writeSequence !== this.thermostatSetpointWriteSequence) {
        return 'superseded';
      }
      try {
        const properties = await this.platform.readDeviceProperties(this.device);
        const primaryObserved = getNumberProperty(properties, THERMOSTAT_HEAT_SETPOINT_EFFECTIVE);
        const commandObserved = getNumberProperty(properties, THERMOSTAT_HEAT_SETPOINT_COMMAND);

        const primaryC = primaryObserved === undefined ? undefined : clamp(normalizeTemperatureFromX100(primaryObserved), 4.5, 35);
        const commandC = commandObserved === undefined ? undefined : clamp(normalizeTemperatureFromX100(commandObserved), 4.5, 35);
        if (primaryC !== undefined) {
          lastObserved = primaryC;
          lastPrimaryObserved = primaryC;
        }
        if (commandC !== undefined) {
          lastCommandObserved = commandC;
          if (lastObserved === undefined) {
            lastObserved = commandC;
          }
        }

        const primaryMatches = primaryC !== undefined && Math.abs(primaryC - expectedTemperatureC) <= THERMOSTAT_APPLY_TOLERANCE_C;
        const commandMatches = commandC !== undefined && Math.abs(commandC - expectedTemperatureC) <= THERMOSTAT_APPLY_TOLERANCE_C;
        if (commandMatches) {
          sawCommandMatch = true;
        }
        if (primaryMatches) {
          return 'applied';
        }
      } catch (error) {
        lastError = error;
      }

      if (attempt < maxAttempts) {
        await sleep(1_500);
      }
    }

    if (lastError) {
      this.platform.log.info(
        `Thermostat setpoint confirmation is delayed for ${this.device.name}: ${asErrorMessage(lastError)}.`
        + ' Continuing with optimistic HomeKit value.',
      );
      return 'pending';
    }
    this.platform.log.info(
      `Thermostat setpoint for ${this.device.name} did not converge to ${expectedTemperatureC.toFixed(1)}°C yet`
      + `${lastObserved !== undefined ? ` (latest observed ${lastObserved.toFixed(1)}°C)` : ''}`
      + `${lastPrimaryObserved !== undefined ? `, effective=${lastPrimaryObserved.toFixed(1)}°C` : ''}`
      + `${lastCommandObserved !== undefined ? `, command=${lastCommandObserved.toFixed(1)}°C` : ''}`
      + `${sawCommandMatch ? '. Command is queued in cloud.' : '.'}`,
    );
    return 'pending';
  }

  private async confirmThermostatTargetInBackground(
    expectedTemperatureC: number,
    writeSequence: number,
  ): Promise<void> {
    try {
      const confirmation = await this.ensureThermostatTargetApplied(expectedTemperatureC, writeSequence);
      if (confirmation === 'superseded') {
        this.platform.log.debug(
          `Skipped outdated thermostat confirmation for ${this.device.name}; a newer target write is in progress.`,
        );
        return;
      }
      if (confirmation === 'applied') {
        if (this.optimisticThermostatTarget?.writeSequence === writeSequence) {
          this.optimisticThermostatTarget = null;
        }
        return;
      }
      this.platform.log.info(
        `Thermostat target for ${this.device.name} is pending Salus cloud apply; keeping optimistic HomeKit value for`
        + ` ${Math.round(THERMOSTAT_OPTIMISTIC_TARGET_TTL_MS / 1000)}s.`,
      );
    } catch (error) {
      this.platform.log.info(
        `Thermostat target confirmation failed for ${this.device.name}: ${asErrorMessage(error)}.`
        + ' Keeping optimistic HomeKit value until it expires.',
      );
    }
  }

  private async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    const hkStateRaw = parseCharacteristicNumber(value);
    if (hkStateRaw === undefined) {
      throw this.communicationFailure('Received invalid thermostat mode value from HomeKit');
    }
    const hkStateRounded = Math.round(hkStateRaw);
    const requestedOff = hkStateRounded === this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    const hkState = requestedOff
      ? this.platform.Characteristic.TargetHeatingCoolingState.OFF
      : this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
    const mode = requestedOff ? SALUS_MODE.off : SALUS_MODE.heat;

    if (!this.writeTargets.systemMode && !this.writeTargets.holdType) {
      throw this.communicationFailure('No writable thermostat mode/standby property was discovered');
    }

    const writes: Record<string, unknown> = {};
    if (this.writeTargets.systemMode) {
      writes[this.writeTargets.systemMode] = mode;
    }
    if (this.writeTargets.holdType) {
      // HomeKit mode mapping requested by user:
      // OFF -> standby (7), HEAT -> working/manual (2).
      writes[this.writeTargets.holdType] = requestedOff ? 7 : 2;
    }
    await this.platform.writeDeviceProperties(this.device, writes);
    if (requestedOff) {
      this.optimisticThermostatTarget = null;
    }

    this.cachedTargetState = hkState;
    this.cachedSystemMode = mode;
    const modeLabel = hkState === this.platform.Characteristic.TargetHeatingCoolingState.OFF
      ? 'off (standby)'
      : 'heat (working)';
    this.platform.log.info(
      `Set thermostat mode for ${this.device.name} to ${modeLabel}`,
    );
  }

  private async setOnOff(value: CharacteristicValue): Promise<void> {
    const on = parseCharacteristicBoolean(value);
    if (on === undefined) {
      throw this.communicationFailure('Received invalid On/Off value from HomeKit');
    }
    const property = this.writeTargets.onOff ?? this.writeTargets.brightness;
    if (!property) {
      throw this.communicationFailure('No writable On/Off property was discovered');
    }

    if (property === this.writeTargets.brightness) {
      await this.setBrightness(on ? 100 : 0);
      return;
    }

    const sample = this.getPropertyValue(property);
    const outgoingValue = encodeBooleanLike(sample, on);
    await this.platform.writeDeviceProperty(this.device, property, outgoingValue);
    this.platform.log.info(`Set On/Off for ${this.device.name} to ${on}`);
  }

  private async setBrightness(value: CharacteristicValue): Promise<void> {
    const numericValue = parseCharacteristicNumber(value);
    if (numericValue === undefined) {
      throw this.communicationFailure('Received invalid brightness value from HomeKit');
    }
    const target = clamp(numericValue, 0, 100);
    const property = this.writeTargets.brightness;
    if (!property) {
      throw this.communicationFailure('No writable brightness property was discovered');
    }

    const sample = this.getPropertyValue(property);
    const outgoingValue = encodePercentageLike(sample, target);

    await this.platform.writeDeviceProperty(this.device, property, outgoingValue);
    this.platform.log.info(`Set brightness for ${this.device.name} to ${target}%`);
  }

  private async setTargetPosition(value: CharacteristicValue): Promise<void> {
    const numericValue = parseCharacteristicNumber(value);
    if (numericValue === undefined) {
      throw this.communicationFailure('Received invalid target position value from HomeKit');
    }
    const target = clamp(numericValue, 0, 100);
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
    const numericValue = parseCharacteristicNumber(value);
    if (numericValue === undefined) {
      throw this.communicationFailure('Received invalid valve active value from HomeKit');
    }
    const active = Math.round(numericValue) === this.platform.Characteristic.Active.ACTIVE;
    const property = this.writeTargets.onOff;
    if (!property) {
      throw this.communicationFailure('No writable valve property was discovered');
    }
    const sample = this.getPropertyValue(property);
    const outgoingValue = encodeBooleanLike(sample, active);
    await this.platform.writeDeviceProperty(this.device, property, outgoingValue);
    this.platform.log.info(`Set valve for ${this.device.name} to ${active ? 'active' : 'inactive'}`);
  }

  private async setLockTargetState(value: CharacteristicValue): Promise<void> {
    const numericValue = parseCharacteristicNumber(value);
    if (numericValue === undefined) {
      throw this.communicationFailure('Received invalid lock target value from HomeKit');
    }
    const shouldLock = Math.round(numericValue) === this.platform.Characteristic.LockTargetState.SECURED;
    const property = this.writeTargets.lock;
    if (!property) {
      throw this.communicationFailure('No writable lock property was discovered');
    }
    const sample = this.getPropertyValue(property);
    const outgoingValue = encodeBooleanLike(sample, shouldLock);
    await this.platform.writeDeviceProperty(this.device, property, outgoingValue);
    this.platform.log.info(`Set lock for ${this.device.name} to ${shouldLock ? 'secured' : 'unsecured'}`);
  }

  private communicationFailure(message: string): Error {
    this.platform.log.error(`${message} [${this.device.name} / ${this.device.dsn}]`);
    return new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private setOptimisticThermostatTarget(valueC: number, writeSequence: number): void {
    this.optimisticThermostatTarget = {
      valueC: clamp(valueC, 4.5, 35),
      expiresAtEpochMs: Date.now() + THERMOSTAT_OPTIMISTIC_TARGET_TTL_MS,
      writeSequence,
    };
    this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.optimisticThermostatTarget.valueC);
  }

  private getActiveOptimisticThermostatTarget(): OptimisticThermostatTarget | undefined {
    const optimistic = this.optimisticThermostatTarget;
    if (!optimistic) {
      return undefined;
    }
    if (optimistic.expiresAtEpochMs <= Date.now()) {
      this.optimisticThermostatTarget = null;
      return undefined;
    }
    return optimistic;
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
  // Salus consumer thermostat UX is effectively standby vs working.
  // HomeKit modes beyond OFF/HEAT are collapsed to HEAT.
  return characteristic.HEAT;
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
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return characteristic.OFF;
  }
  return characteristic.HEAT;
}

function parseCharacteristicNumber(value: CharacteristicValue): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseCharacteristicBoolean(value: CharacteristicValue): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'on') {
      return true;
    }
    if (normalized === 'false' || normalized === 'off') {
      return false;
    }
  }

  const numeric = parseCharacteristicNumber(value);
  if (numeric !== undefined) {
    return numeric !== 0;
  }

  return undefined;
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
