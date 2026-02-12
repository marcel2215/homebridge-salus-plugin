# Homebridge Salus Cloud

Cloud-only Homebridge dynamic platform for Salus Connect.

This plugin authenticates with Salus cloud using the same modern Cognito + service-api flow used by the Salus mobile app, auto-discovers your devices, and exposes one HomeKit accessory per one Salus device.

## Design goals

- Cloud transport only (no local LAN gateway control).
- Login with Salus email/password from Homebridge config.
- Automatic device discovery and ongoing state sync.
- One HomeKit accessory per one Salus device.
- Reliable transport with retries, token refresh, endpoint fallback, and detailed logs.
- Priority support for heating devices (including SQ610/SQ610RF family) while mapping all model categories from the Salus app catalog.

## 2026 cloud flow implemented

The plugin follows the app's modern cloud stack:

- Cognito auth endpoint: `https://cognito-idp.<region>.amazonaws.com/`
- Auth target: `AWSCognitoIdentityProviderService.InitiateAuth`
- Login flow: `USER_PASSWORD_AUTH`
- Refresh flow: `REFRESH_TOKEN_AUTH`
- Service API base (EU default): `https://service-api.eu.premium.salusconnect.io/api/v1`
- Service API fallback: `/api/v2`
- Discovery endpoints (in order): `GET /api/v1/occupants/slider_list` + `GET /api/v1/occupants/slider_details?id=...&type=gateway`, then fallback `GET /devices/`
- Property shadow endpoint: `POST /devices/device_shadows` with `{ "device_codes": [...] }` (with compatibility fallback shapes)
- Control write endpoint (primary): AWS IoT thing-shadow `POST /things/{dsn}/shadow` with SigV4 signing, using temporary credentials from Cognito Identity
- Control write endpoint (fallback): `POST /devices/bulk` and `PATCH /devices/device_shadows` payload variants for compatibility fallback

## Install

```bash
npm install
npm run build
```

For local Homebridge testing:

```bash
npm link
homebridge -D
```

## Homebridge config

```json
{
  "platform": "SalusCloud",
  "name": "Salus Cloud",
  "email": "your-salus-email@example.com",
  "password": "your-salus-password",
  "region": "eu",
  "pollIntervalSeconds": 20,
  "requestTimeoutSeconds": 30,
  "maxRetries": 3,
  "retryBaseDelayMs": 750,
  "maxParallelPropertyRequests": 4,
  "verboseLogging": false,
  "allowInsecureTls": false,
  "apiVersionPreference": "auto",
  "cognitoRegion": "eu-central-1",
  "cognitoClientId": "4pk5efh3v84g5dav43imsv4fbj",
  "awsIdentityPoolId": "eu-central-1:60912c00-287d-413b-a2c9-ece3ccef9230",
  "awsIotEndpointHost": "a24u3z7zzwrtdl-ats.iot.eu-central-1.amazonaws.com",
  "awsIotRegion": "eu-central-1",
  "awsIotServiceName": "iotdevicegateway"
}
```

## Advanced options

- `apiHost`: Override Salus service-api host (`https://...`) with optional `/api/v1` or `/api/v2` suffix.
- `apiVersionPreference`: `auto`, `v1`, or `v2`.
- `cognitoRegion`: Override AWS Cognito region.
- `cognitoClientId`: Override Cognito app client ID.
- `awsIdentityPoolId`: Override Cognito Identity pool id used for AWS IoT credential exchange.
- `awsIotEndpointHost`: Override AWS IoT data endpoint host (no path).
- `awsIotRegion`: Override AWS IoT SigV4 signing region.
- `awsIotServiceName`: Override AWS IoT SigV4 service (`iotdevicegateway` by default, falls back to `iotdata` automatically).
- `companyCode`: Optional `x-company-code` override (for example `salus-eu`, `salus-us`, `heatlink_us`). If omitted, the plugin now starts with region defaults (`salus-eu` / `salus-us`) and only then tries alternatives.
- `allowInsecureTls`: Only for certificate troubleshooting (not recommended long-term).

## Device mapping

The plugin infers HomeKit service type from both:

1. Salus app model catalog (included in source).
2. Live property/shadow inspection from cloud.

Examples:

- Thermostats (including SQ610RF): `Thermostat`
- Relays/plugs/receivers/hot-water timers: `Switch` or `Outlet`
- Lights/dimmers: `Lightbulb`
- Roller shutters: `WindowCovering`
- Valves: `Valve`
- Door locks: `LockMechanism`
- Contact/motion/leak/smoke/CO/temperature/humidity/air-quality devices: matching sensor services where available

## Reliability behavior

- Automatic token refresh before expiry and on `401` responses.
- Exponential backoff retries for transient network/API failures.
- API base fallback between `/api/v1` and `/api/v2`.
- Modern discovery fallback from `occupants` API to legacy `/devices` API shape.
- Bounded `occupants/slider_details` traversal per poll (target-count + time budget) to avoid long stalls during upstream `5xx` bursts.
- Automatic compatibility fallback to legacy Salus cloud auth/API (multi-path legacy sign-in probe + `/apiv1`) when modern API returns persistent authorization errors (for example `response_code=900008`).
- Flexible shadow parser for multiple payload shapes.
- Primary write path matches Salus app behavior via AWS IoT thing-shadow updates (`state.desired.<baseKey>.properties`).
- Automatic AWS IoT credential refresh and signing-service fallback (`iotdevicegateway` -> `iotdata`) for tenant variations.
- Service API write payload fallbacks remain enabled as a compatibility safety net.
- Per-poll property refresh (with cached fallback on transient errors) to keep HomeKit target/current values up-to-date.
- Thermostat write confirmation loop verifies that setpoint actually changed in cloud state; failed convergence is surfaced as HomeKit communication failure instead of silent no-op.
- Thermostat setpoint writes mirror both effective and command fields (`HeatingSetpoint*` + `SetHeatingSetpoint*`) to keep Salus app and Home app in sync when the cloud updates them asynchronously.
- Device online state is inferred from Salus connectivity datapoints (`connected`, `OnlineState`, `OnlineStatus_i`, etc.) and mapped to HomeKit reachability so disconnected devices can show as not responding.
- Immediate short re-poll after write to keep HomeKit state aligned.
- Detailed logs for auth, discovery, shadow sync, writes, retries, and failures.

## Thermostat mode mapping

For Salus thermostat UX parity (standby/working):

- HomeKit `Off` -> Salus standby (`HoldType=7`, no active heating)
- HomeKit `Heat` -> Salus working mode
- HomeKit `Cool` / `Auto` requests are forced to `Heat`

Target mode characteristic is constrained to `Off` + `Heat` to avoid unsupported mode selection in Home app.

## 900008 troubleshooting

If logs show `response_code=900008` from modern `service-api`, the plugin now uses the same modern header model as the Salus AWS flow (`x-access-token` = access token, `x-auth-token` = id token, `x-company-code`), retries with refreshed tokens, and rotates company-code candidates before switching to legacy compatibility mode.

If legacy fallback is required, you will see:

- `Switching to legacy Salus cloud compatibility mode (...)`
- `Authenticated with Salus cloud (legacy API compatibility mode)`

## Salus features not cleanly mappable to HomeKit

These are intentionally not represented as extra virtual accessories:

1. Full Salus schedule editors and rule-engine objects.
2. Detailed hold-mode matrix (`follow`, `temp hold`, `perm hold`, `holiday`, `boost`) as first-class HomeKit concepts.
3. Installer/expert parameters (algorithm tuning, floor limits, valve protection tuning).
4. Firmware management, pairing/binding topology operations, provisioning workflows.
5. Historical analytics dashboards and advanced alert configuration UI workflows.

These remain available in the Salus app/cloud UI.
