/* eslint-disable max-len */

export type HomeKitDeviceKind =
  | 'thermostat'
  | 'switch'
  | 'outlet'
  | 'lightbulb'
  | 'windowCovering'
  | 'valve'
  | 'lock'
  | 'motionSensor'
  | 'contactSensor'
  | 'leakSensor'
  | 'smokeSensor'
  | 'carbonMonoxideSensor'
  | 'temperatureSensor'
  | 'humiditySensor'
  | 'airQualitySensor'
  | 'occupancySensor';

export interface ModelCatalogEntry {
  model: string;
  layout: string;
  categoryId: string;
  categoryName: string;
}

export const MODEL_CATALOG: Record<string, ModelCatalogEntry> = {
  '3041': { model: '3041', layout: 'Motion_Sensor', categoryId: '18', categoryName: 'Motion Sensor' },
  '3043': { model: '3043', layout: 'Motion_Sensor', categoryId: '18', categoryName: 'Motion Sensor' },
  '3315_G': { model: '3315_G', layout: 'Water_Leak_Sensor', categoryId: '5', categoryName: 'Water Leak Sensors' },
  '3315_S': { model: '3315_S', layout: 'Water_Leak_Sensor', categoryId: '5', categoryName: 'Water Leak Sensors' },
  '43102': { model: '43102', layout: 'Smart_Relay', categoryId: '34', categoryName: 'Smart Outlets' },
  '45856': { model: '45856', layout: 'Smart_Relay', categoryId: '32', categoryName: 'Fan Coil Thermostats' },
  '45857': { model: '45857', layout: 'light_switches', categoryId: '27', categoryName: 'Light Switches' },
  'A60_TW_Z3': { model: 'A60_TW_Z3', layout: 'Common_Light', categoryId: '14', categoryName: 'Light' },
  'AJSQ605RF': { model: 'AJSQ605RF', layout: 'Thermostat_dial_rf', categoryId: '15', categoryName: 'Dial RF Thermostats' },
  'ALTHCSQ605RF': { model: 'ALTHCSQ605RF', layout: 'Thermostat_dial_rf', categoryId: '15', categoryName: 'Dial RF Thermostats' },
  'ALTHRCU800': { model: 'ALTHRCU800', layout: 'control_box', categoryId: '37', categoryName: 'Control Box' },
  'ALTHRSQ800WRF': { model: 'ALTHRSQ800WRF', layout: 'Thermostat_RF', categoryId: '38', categoryName: 'RF Thermostats' },
  'AnionStop': { model: 'AnionStop', layout: 'AnionStop', categoryId: '201', categoryName: 'ArStop Valve' },
  'Arjonstop': { model: 'Arjonstop', layout: 'Arjonstop', categoryId: '201', categoryName: 'ArStop Valve' },
  'AVA10M30RF': { model: 'AVA10M30RF', layout: 'IT600TRV', categoryId: '10', categoryName: 'TRVs' },
  'AWC_Z': { model: 'AWC_Z', layout: 'wireless_uncontrollable_device_repeater', categoryId: '6', categoryName: 'Wireless Uncontrollable Devices' },
  'B40_DIM_Z3': { model: 'B40_DIM_Z3', layout: 'Common_Light', categoryId: '14', categoryName: 'Light' },
  'B40_TW_Z3': { model: 'B40_TW_Z3', layout: 'Common_Light', categoryId: '14', categoryName: 'Light' },
  'C900T': { model: 'C900T', layout: 'Thermostat_C900T', categoryId: '202', categoryName: 'Elypso Thermostats' },
  'CB12RF_IT600': { model: 'CB12RF_IT600', layout: 'wireless_uncontrollable_device_repeater', categoryId: '6', categoryName: 'Wireless Uncontrollable Devices' },
  'CB12RF_Z3': { model: 'CB12RF_Z3', layout: 'cb12rf_z3_wiring_centre', categoryId: '207', categoryName: 'CB12RF ZB3 Wiring Centre' },
  'CLA60_RGBW_OSRAM': { model: 'CLA60_RGBW_OSRAM', layout: 'Common_Light', categoryId: '14', categoryName: 'Light' },
  'Classic_A60_W_clear___LIGHTIFY': { model: 'Classic_A60_W_clear___LIGHTIFY', layout: 'Common_Light', categoryId: '14', categoryName: 'Light' },
  'CSB600': { model: 'CSB600', layout: 'smart_button_csb600', categoryId: '6', categoryName: 'Wireless Uncontrollable Devices' },
  'CTLP631': { model: 'CTLP631', layout: 'Smart_Plugs', categoryId: '7', categoryName: 'Smart Plugs' },
  'CTLP632': { model: 'CTLP632', layout: 'Smart_Plugs', categoryId: '7', categoryName: 'Smart Plugs' },
  'CTLS631': { model: 'CTLS631', layout: 'remote_temperature_sensors', categoryId: '20', categoryName: 'Remote Temperature Sensors' },
  'CTLS631E': { model: 'CTLS631E', layout: 'remote_temperature_sensors', categoryId: '20', categoryName: 'Remote Temperature Sensors' },
  'CTLS632': { model: 'CTLS632', layout: 'remote_temperature_sensors', categoryId: '20', categoryName: 'Remote Temperature Sensors' },
  'CTLS632E': { model: 'CTLS632E', layout: 'temp_humid_sensors', categoryId: '20', categoryName: 'Remote Temperature Sensors' },
  'CTLS633': { model: 'CTLS633', layout: 'remote_temperature_sensors', categoryId: '20', categoryName: 'Remote Temperature Sensors' },
  'CTLS633E': { model: 'CTLS633E', layout: 'co2_temp_humid_sensors', categoryId: '20', categoryName: 'Remote Temperature Sensors' },
  'CTLS634': { model: 'CTLS634', layout: 'window_sensor', categoryId: '9', categoryName: 'Window Monitors' },
  'CTLS634_': { model: 'CTLS634_', layout: 'window_sensor', categoryId: '9', categoryName: 'Window Monitors' },
  'CTLV630': { model: 'CTLV630', layout: 'trv_v630', categoryId: '11', categoryName: 'TRVs' },
  'DI600': { model: 'DI600', layout: 'ac_phase_cut_zigbee_dimmers', categoryId: '19', categoryName: 'AC Phase Cut ZigBee Dimmers' },
  'EasyFingerTouch': { model: 'EasyFingerTouch', layout: 'Door_Locks', categoryId: '300', categoryName: 'Door Locks' },
  'ECM600': { model: 'ECM600', layout: 'energy_meters', categoryId: '21', categoryName: 'Energy Meters' },
  'EL600T': { model: 'EL600T', layout: 'Thermostat_C900T', categoryId: '202', categoryName: 'Elypso Thermostats' },
  'FC600': { model: 'FC600', layout: 'thermostat_fan_coil', categoryId: '32', categoryName: 'Fan Coil Thermostats' },
  'FC600NH': { model: 'FC600NH', layout: 'thermostat_fan_coil', categoryId: '32', categoryName: 'Fan Coil Thermostats' },
  'FLEX_RGBW_Z3': { model: 'FLEX_RGBW_Z3', layout: 'Common_Light', categoryId: '14', categoryName: 'Light' },
  'HDW10ZB': { model: 'HDW10ZB', layout: 'window_sensor', categoryId: '9', categoryName: 'Window Monitors' },
  'HESZB_120': { model: 'HESZB_120', layout: 'develco_heat_sensor', categoryId: '209', categoryName: 'Heat Detector' },
  'HTR_RF_20_': { model: 'HTR_RF_20_', layout: 'Thermostat_it600', categoryId: '12', categoryName: 'iT600 Thermostats' },
  'HTRP_RF_50_': { model: 'HTRP_RF_50_', layout: 'Thermostat_it600', categoryId: '12', categoryName: 'iT600 Thermostats' },
  'HTRS_RF_30_': { model: 'HTRS_RF_30_', layout: 'Thermostat_it600', categoryId: '12', categoryName: 'iT600 Thermostats' },
  'HTS10ZB': { model: 'HTS10ZB', layout: 'remote_temperature_sensors', categoryId: '20', categoryName: 'Remote Temperature Sensors' },
  'it600HW': { model: 'it600HW', layout: 'hot_water_timer', categoryId: '28', categoryName: 'Hot Water Timers' },
  'it600HW_AC': { model: 'it600HW_AC', layout: 'hot_water_timer', categoryId: '28', categoryName: 'Hot Water Timers' },
  'it600HWNH': { model: 'it600HWNH', layout: 'hot_water_timer', categoryId: '28', categoryName: 'Hot Water Timers' },
  'it600HWNH_AC': { model: 'it600HWNH_AC', layout: 'hot_water_timer', categoryId: '28', categoryName: 'Hot Water Timers' },
  'it600MINITRV': { model: 'it600MINITRV', layout: 'IT600TRV', categoryId: '10', categoryName: 'TRVs' },
  'it600MINITRVNH': { model: 'it600MINITRVNH', layout: 'IT600TRV', categoryId: '10', categoryName: 'TRVs' },
  'IT600PumpWC': { model: 'IT600PumpWC', layout: 'wireless_uncontrollable_device_repeater', categoryId: '6', categoryName: 'Wireless Uncontrollable Devices' },
  'it600Receiver': { model: 'it600Receiver', layout: 'wireless_uncontrollable_equipment', categoryId: '6', categoryName: 'Wireless Uncontrollable Devices' },
  'it600Repeater': { model: 'it600Repeater', layout: 'wireless_uncontrollable_device_repeater', categoryId: '6', categoryName: 'Wireless Uncontrollable Devices' },
  'it600ThermHW': { model: 'it600ThermHW', layout: 'Thermostat_it600', categoryId: '12', categoryName: 'iT600 Thermostats' },
  'it600ThermHW_AC': { model: 'it600ThermHW_AC', layout: 'Thermostat_it600', categoryId: '12', categoryName: 'iT600 Thermostats' },
  'it600ThermHWNH': { model: 'it600ThermHWNH', layout: 'Thermostat_it600', categoryId: '12', categoryName: 'iT600 Thermostats' },
  'it600ThermHWNH_AC': { model: 'it600ThermHWNH_AC', layout: 'Thermostat_it600', categoryId: '12', categoryName: 'iT600 Thermostats' },
  'it600TRV': { model: 'it600TRV', layout: 'IT600TRV', categoryId: '10', categoryName: 'TRVs' },
  'it600WC': { model: 'it600WC', layout: 'wireless_uncontrollable_device_repeater', categoryId: '6', categoryName: 'Wireless Uncontrollable Devices' },
  'it600WCNH': { model: 'it600WCNH', layout: 'wireless_uncontrollable_device_repeater', categoryId: '6', categoryName: 'Wireless Uncontrollable Devices' },
  'IT700TX': { model: 'IT700TX', layout: 'Thermostat_quantum', categoryId: '205', categoryName: 'IT700TX Thermostats' },
  'IT710TX': { model: 'IT710TX', layout: 'Thermostat_quantum', categoryId: '208', categoryName: 'IT710TX Thermostats' },
  'IT800TX': { model: 'IT800TX', layout: 'Thermostat_iT800Tx', categoryId: '47', categoryName: 'iT800Tx Thermostats' },
  'KEPZB_110': { model: 'KEPZB_110', layout: 'key_pad', categoryId: '45', categoryName: 'Keypad' },
  'KEPZB_112': { model: 'KEPZB_112', layout: 'key_pad', categoryId: '45', categoryName: 'Keypad' },
  'moisturev4': { model: 'moisturev4', layout: 'Water_Leak_Sensor', categoryId: '5', categoryName: 'Water Leak Sensors' },
  'Motion_Sensor_A_': { model: 'Motion_Sensor_A_', layout: 'Motion_Sensor', categoryId: '18', categoryName: 'Motion Sensor' },
  'MR16_TW_OSRAM': { model: 'MR16_TW_OSRAM', layout: 'Common_Light', categoryId: '14', categoryName: 'Light' },
  'MS600': { model: 'MS600', layout: 'Motion_Sensor', categoryId: '18', categoryName: 'Motion Sensor' },
  'MS610': { model: 'MS610', layout: 'Motion_Sensor', categoryId: '18', categoryName: 'Motion Sensor' },
  'NimlyCode': { model: 'NimlyCode', layout: 'Door_Locks', categoryId: '300', categoryName: 'Door Locks' },
  'NTSQ605RF': { model: 'NTSQ605RF', layout: 'Thermostat_dial_rf', categoryId: '15', categoryName: 'Dial RF Thermostats' },
  'NTSQ610NH': { model: 'NTSQ610NH', layout: 'Thermostat_quantum', categoryId: '13', categoryName: 'Quantum Thermostats' },
  'NTSQ610RFNH': { model: 'NTSQ610RFNH', layout: 'Thermostat_quantum', categoryId: '13', categoryName: 'Quantum Thermostats' },
  'NTSW600': { model: 'NTSW600', layout: 'window_sensor', categoryId: '9', categoryName: 'Window Monitors' },
  'NTVS41': { model: 'NTVS41', layout: 'Thermostat_it600', categoryId: '12', categoryName: 'iT600 Thermostats' },
  'NTVS41HW': { model: 'NTVS41HW', layout: 'hot_water_timer', categoryId: '28', categoryName: 'Hot Water Timers' },
  'OS600': { model: 'OS600', layout: 'window_sensor', categoryId: '9', categoryName: 'Window Monitors' },
  'Outdoor_FLEX_RGBW_Z3': { model: 'Outdoor_FLEX_RGBW_Z3', layout: 'Common_Light', categoryId: '14', categoryName: 'Light' },
  'PAR16_DIM_Z3': { model: 'PAR16_DIM_Z3', layout: 'Common_Light', categoryId: '14', categoryName: 'Light' },
  'PAR16_RGBW_Z3': { model: 'PAR16_RGBW_Z3', layout: 'Common_Light', categoryId: '14', categoryName: 'Light' },
  'PAR16_TW_Z3': { model: 'PAR16_TW_Z3', layout: 'Common_Light', categoryId: '14', categoryName: 'Light' },
  'PIRSensor_EM': { model: 'PIRSensor_EM', layout: 'Motion_Sensor', categoryId: '18', categoryName: 'Motion Sensor' },
  'PS600': { model: 'PS600', layout: 'remote_temperature_sensors', categoryId: '20', categoryName: 'Remote Temperature Sensors' },
  'RCU800': { model: 'RCU800', layout: 'control_box', categoryId: '37', categoryName: 'Control Box' },
  'RE600': { model: 'RE600', layout: 'wireless_uncontrollable_device_repeater', categoryId: '6', categoryName: 'Wireless Uncontrollable Devices' },
  'RS600': { model: 'RS600', layout: 'roller_shutter', categoryId: '30', categoryName: 'Roller Shutters' },
  'RSQ800WRF': { model: 'RSQ800WRF', layout: 'Thermostat_RF', categoryId: '38', categoryName: 'RF Thermostats' },
  'RX30RF': { model: 'RX30RF', layout: 'Receiver_RX30RF', categoryId: '203', categoryName: 'Receivers' },
  'SAL2EM1': { model: 'SAL2EM1', layout: 'energy_meters', categoryId: '21', categoryName: 'Energy Meters' },
  'SAL3AG1': { model: 'SAL3AG1', layout: 'SAU2AG1_GW', categoryId: '1', categoryName: 'Gateways' },
  'SAL3AG1_GW': { model: 'SAL3AG1_GW', layout: 'SAU2AG1_GW', categoryId: '1', categoryName: 'Gateways' },
  'SAL3AG1_ZC': { model: 'SAL3AG1_ZC', layout: 'SAU2AG1_GW', categoryId: '1', categoryName: 'Gateways' },
  'SAL3AG1AT': { model: 'SAL3AG1AT', layout: 'SAU2AG1_GW', categoryId: '1', categoryName: 'Gateways' },
  'SAL3AG1AT_GW': { model: 'SAL3AG1AT_GW', layout: 'SAU2AG1_GW', categoryId: '1', categoryName: 'Gateways' },
  'SAL3AG1AT_ZC': { model: 'SAL3AG1AT_ZC', layout: 'SAU2AG1_GW', categoryId: '1', categoryName: 'Gateways' },
  'SAL3AG1ATGW': { model: 'SAL3AG1ATGW', layout: 'SAU2AG1_GW', categoryId: '1', categoryName: 'Gateways' },
  'SAL3AG1ATZC': { model: 'SAL3AG1ATZC', layout: 'SAU2AG1_GW', categoryId: '1', categoryName: 'Gateways' },
  'SAL3AG1GW': { model: 'SAL3AG1GW', layout: 'SAU2AG1_GW', categoryId: '1', categoryName: 'Gateways' },
  'SAL3AG1ZC': { model: 'SAL3AG1ZC', layout: 'SAU2AG1_GW', categoryId: '1', categoryName: 'Gateways' },
  'SAU2AG1_GW': { model: 'SAU2AG1_GW', layout: 'SAU2AG1_GW', categoryId: '1', categoryName: 'Gateways' },
  'SAU2AG1_ZC': { model: 'SAU2AG1_ZC', layout: 'SAU2AG1_GW', categoryId: '1', categoryName: 'Gateways' },
  'SAU3AG1': { model: 'SAU3AG1', layout: 'SAU2AG1_GW', categoryId: '1', categoryName: 'Gateways' },
  'SAU3AG1_GW': { model: 'SAU3AG1_GW', layout: 'SAU2AG1_GW', categoryId: '1', categoryName: 'Gateways' },
  'SAU3AG1_ZC': { model: 'SAU3AG1_ZC', layout: 'SAU2AG1_GW', categoryId: '1', categoryName: 'Gateways' },
  'SAU3AG1GW': { model: 'SAU3AG1GW', layout: 'SAU2AG1_GW', categoryId: '1', categoryName: 'Gateways' },
  'SAU3AG1ZC': { model: 'SAU3AG1ZC', layout: 'SAU2AG1_GW', categoryId: '1', categoryName: 'Gateways' },
  'SAWZ600GW': { model: 'SAWZ600GW', layout: 'WZ600', categoryId: '1', categoryName: 'Gateways' },
  'SAWZ600ZC': { model: 'SAWZ600ZC', layout: 'WZ600', categoryId: '1', categoryName: 'Gateways' },
  'SB600': { model: 'SB600', layout: 'smart_button_sb600', categoryId: '6', categoryName: 'Wireless Uncontrollable Devices' },
  'SC812ZB': { model: 'SC812ZB', layout: 'Smart_Relay', categoryId: '4', categoryName: 'Smart Relays' },
  'SC824ZB': { model: 'SC824ZB', layout: 'Smart_Relay', categoryId: '4', categoryName: 'Smart Relays' },
  'SIR600': { model: 'SIR600', layout: 'smart_ir_ac_controllers', categoryId: '206', categoryName: 'Smart IR AC Controllers' },
  'SIRZB_110': { model: 'SIRZB_110', layout: 'Siren', categoryId: '46', categoryName: 'Siren' },
  'SIRZB_112': { model: 'SIRZB_112', layout: 'Siren', categoryId: '46', categoryName: 'Siren' },
  'SmokeSensor_EM': { model: 'SmokeSensor_EM', layout: 'smoke_sensor', categoryId: '23', categoryName: 'Smoke Detector' },
  'SMSZB_120': { model: 'SMSZB_120', layout: 'develco_smoke_sensor', categoryId: '23', categoryName: 'Smoke Detector' },
  'SP600': { model: 'SP600', layout: 'Smart_Plugs', categoryId: '7', categoryName: 'Smart Plugs' },
  'SPE600': { model: 'SPE600', layout: 'Smart_Plugs', categoryId: '7', categoryName: 'Smart Plugs' },
  'SQ605RF_WB_': { model: 'SQ605RF_WB_', layout: 'Thermostat_dial_rf', categoryId: '15', categoryName: 'Dial RF Thermostats' },
  'SQ610': { model: 'SQ610', layout: 'Thermostat_quantum', categoryId: '13', categoryName: 'Quantum Thermostats' },
  'SQ610_WB_': { model: 'SQ610_WB_', layout: 'Thermostat_quantum', categoryId: '13', categoryName: 'Quantum Thermostats' },
  'SQ610NH': { model: 'SQ610NH', layout: 'Thermostat_quantum', categoryId: '13', categoryName: 'Quantum Thermostats' },
  'SQ610NH_WB_': { model: 'SQ610NH_WB_', layout: 'Thermostat_quantum', categoryId: '13', categoryName: 'Quantum Thermostats' },
  'SQ610RF': { model: 'SQ610RF', layout: 'Thermostat_quantum', categoryId: '13', categoryName: 'Quantum Thermostats' },
  'SQ610RF_WB_': { model: 'SQ610RF_WB_', layout: 'Thermostat_quantum', categoryId: '13', categoryName: 'Quantum Thermostats' },
  'SQ610RFNH': { model: 'SQ610RFNH', layout: 'Thermostat_quantum', categoryId: '13', categoryName: 'Quantum Thermostats' },
  'SQ610RFNH_WB_': { model: 'SQ610RFNH_WB_', layout: 'Thermostat_quantum', categoryId: '13', categoryName: 'Quantum Thermostats' },
  'SQ610RFNH1': { model: 'SQ610RFNH1', layout: 'Thermostat_quantum', categoryId: '13', categoryName: 'Quantum Thermostats' },
  'SQ620B': { model: 'SQ620B', layout: 'thermostat_quantum_plus', categoryId: '210', categoryName: 'Quantum Plus Thermostats' },
  'SQ620BRF': { model: 'SQ620BRF', layout: 'thermostat_quantum_plus', categoryId: '210', categoryName: 'Quantum Plus Thermostats' },
  'SR600': { model: 'SR600', layout: 'Smart_Relay', categoryId: '4', categoryName: 'Smart Relays' },
  'SS881ZB': { model: 'SS881ZB', layout: 'door_sensor', categoryId: '24', categoryName: 'Door Monitors' },
  'SS882ZB': { model: 'SS882ZB', layout: 'window_sensor', categoryId: '9', categoryName: 'Window Monitors' },
  'SS883ZB': { model: 'SS883ZB', layout: 'smart_button_csb600', categoryId: '6', categoryName: 'Wireless Uncontrollable Devices' },
  'SS884ZB': { model: 'SS884ZB', layout: 'smart_button_sb600', categoryId: '6', categoryName: 'Wireless Uncontrollable Devices' },
  'SS901ZB': { model: 'SS901ZB', layout: 'Water_Leak_Sensor', categoryId: '5', categoryName: 'Water Leak Sensors' },
  'SS909ZB': { model: 'SS909ZB', layout: 'remote_temperature_sensors', categoryId: '20', categoryName: 'Remote Temperature Sensors' },
  'SS912ZB': { model: 'SS912ZB', layout: 'window_sensor', categoryId: '9', categoryName: 'Window Monitors' },
  'SW600': { model: 'SW600', layout: 'window_sensor', categoryId: '9', categoryName: 'Window Monitors' },
  'SX885ZB': { model: 'SX885ZB', layout: 'Smart_Plugs', categoryId: '7', categoryName: 'Smart Plugs' },
  'Tibea_TW_Z3': { model: 'Tibea_TW_Z3', layout: 'Common_Light', categoryId: '14', categoryName: 'Light' },
  'TRV10RFM': { model: 'TRV10RFM', layout: 'IT600TRV', categoryId: '10', categoryName: 'TRVs' },
  'TRV10RFMNH': { model: 'TRV10RFMNH', layout: 'IT600TRV', categoryId: '10', categoryName: 'TRVs' },
  'TRV3RF': { model: 'TRV3RF', layout: 'TRV_TRV3RF', categoryId: '204', categoryName: 'TRVs' },
  'TS600': { model: 'TS600', layout: 'Thermostat_it600', categoryId: '12', categoryName: 'iT600 Thermostats' },
  'TS600HW': { model: 'TS600HW', layout: 'hot_water_timer', categoryId: '28', categoryName: 'Hot Water Timers' },
  'WLS600': { model: 'WLS600', layout: 'Water_Leak_Sensor', categoryId: '5', categoryName: 'Water Leak Sensors' },
  'ZB_MotionSensor_D0000': { model: 'ZB_MotionSensor_D0000', layout: 'Motion_Sensor', categoryId: '18', categoryName: 'Motion Sensor' },
  'ZB_MotionSensor_S00000001': { model: 'ZB_MotionSensor_S00000001', layout: 'Motion_Sensor', categoryId: '18', categoryName: 'Motion Sensor' },
  'ZB_SMART_PIR_ALL_ONOFV2': { model: 'ZB_SMART_PIR_ALL_ONOFV2', layout: 'Motion_Sensor', categoryId: '18', categoryName: 'Motion Sensor' },
  'ZG9101SAC_HP': { model: 'ZG9101SAC_HP', layout: 'ac_phase_cut_zigbee_dimmers', categoryId: '19', categoryName: 'AC Phase Cut ZigBee Dimmers' },
};

function canonicalizeModelKey(model: string): string {
  return model
    .trim()
    .replaceAll(/[^A-Za-z0-9]/g, '_')
    .replaceAll(/_+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
    .toUpperCase();
}

const MODEL_CATALOG_BY_CANONICAL_KEY: Map<string, ModelCatalogEntry> = new Map(
  Object.values(MODEL_CATALOG).map((entry) => [canonicalizeModelKey(entry.model), entry]),
);

function resolveCatalogEntry(model: string): ModelCatalogEntry | undefined {
  const direct = MODEL_CATALOG[model];
  if (direct) {
    return direct;
  }
  return MODEL_CATALOG_BY_CANONICAL_KEY.get(canonicalizeModelKey(model));
}

const THERMOSTAT_CATEGORY_IDS = new Set(['12', '13', '15', '32', '38', '47', '202', '205', '208', '210']);
const SWITCH_CATEGORY_IDS = new Set(['4', '7', '8', '28', '33', '34', '37', '45', '46', '203', '206', '207']);
const LIGHT_CATEGORY_IDS = new Set(['14', '19', '27']);
const CONTACT_CATEGORY_IDS = new Set(['9', '24']);
const MOTION_CATEGORY_IDS = new Set(['18']);
const LEAK_CATEGORY_IDS = new Set(['5']);
const SMOKE_CATEGORY_IDS = new Set(['23', '209']);
// Category 6 is "Wireless Uncontrollable Devices" and includes repeaters/buttons,
// so carbon-monoxide must be inferred from live properties instead of category id.
const CO_CATEGORY_IDS = new Set<string>();
const LOCK_CATEGORY_IDS = new Set(['300']);
const VALVE_CATEGORY_IDS = new Set(['201']);
const WINDOW_COVERING_CATEGORY_IDS = new Set(['30']);
const TEMP_SENSOR_CATEGORY_IDS = new Set(['20']);

export function inferKindFromCatalog(model: string): HomeKitDeviceKind | undefined {
  const entry = resolveCatalogEntry(model);
  if (!entry) {
    return undefined;
  }

  const categoryId = entry.categoryId;
  if (THERMOSTAT_CATEGORY_IDS.has(categoryId)) {
    return 'thermostat';
  }
  if (WINDOW_COVERING_CATEGORY_IDS.has(categoryId)) {
    return 'windowCovering';
  }
  if (VALVE_CATEGORY_IDS.has(categoryId)) {
    return 'valve';
  }
  if (LOCK_CATEGORY_IDS.has(categoryId)) {
    return 'lock';
  }
  if (LIGHT_CATEGORY_IDS.has(categoryId)) {
    return 'lightbulb';
  }
  if (SWITCH_CATEGORY_IDS.has(categoryId)) {
    return 'switch';
  }
  if (CONTACT_CATEGORY_IDS.has(categoryId)) {
    return 'contactSensor';
  }
  if (MOTION_CATEGORY_IDS.has(categoryId)) {
    return 'motionSensor';
  }
  if (LEAK_CATEGORY_IDS.has(categoryId)) {
    return 'leakSensor';
  }
  if (SMOKE_CATEGORY_IDS.has(categoryId)) {
    return 'smokeSensor';
  }
  if (CO_CATEGORY_IDS.has(categoryId)) {
    return 'carbonMonoxideSensor';
  }
  if (TEMP_SENSOR_CATEGORY_IDS.has(categoryId)) {
    return 'temperatureSensor';
  }

  return undefined;
}

export function getCatalogEntry(model: string): ModelCatalogEntry | undefined {
  return resolveCatalogEntry(model);
}
