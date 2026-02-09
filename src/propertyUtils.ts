/* eslint-disable @typescript-eslint/no-use-before-define */

import type { SalusPropertyMap } from './types.js';

export function baseNameForProperty(name: string): string {
  const parts = name.split(':');
  return parts[parts.length - 1] ?? name;
}

export function normalizeModelName(model: string): string {
  return model.replaceAll(/[^A-Za-z0-9]/g, '_').replaceAll('__', '_');
}

export function parseBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'on' || normalized === 'open' || normalized === 'locked') {
      return true;
    }
    if (normalized === 'false' || normalized === 'off' || normalized === 'closed' || normalized === 'unlocked') {
      return false;
    }
    const parsed = Number(normalized);
    if (!Number.isNaN(parsed)) {
      return parsed !== 0;
    }
  }

  return undefined;
}

export function parseNumberLike(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function hasAnyPropertyBase(map: SalusPropertyMap, baseNames: string[]): boolean {
  const names = new Set(baseNames);
  for (const prop of map.values()) {
    if (names.has(prop.baseName)) {
      return true;
    }
  }
  return false;
}

export function findPropertyByBaseName(map: SalusPropertyMap, baseNames: string[]): string | undefined {
  for (const baseName of baseNames) {
    for (const [name, prop] of map) {
      if (prop.baseName === baseName || name === baseName) {
        return name;
      }
    }
  }
  return undefined;
}

export function getNumberProperty(map: SalusPropertyMap, baseNames: string[]): number | undefined {
  for (const baseName of baseNames) {
    for (const prop of map.values()) {
      if (prop.baseName === baseName || prop.name === baseName) {
        const parsed = parseNumberLike(prop.value);
        if (parsed !== undefined) {
          return parsed;
        }
      }
    }
  }
  return undefined;
}

export function getStringProperty(map: SalusPropertyMap, baseNames: string[]): string | undefined {
  for (const baseName of baseNames) {
    for (const prop of map.values()) {
      if (prop.baseName === baseName || prop.name === baseName) {
        if (typeof prop.value === 'string') {
          return prop.value;
        }
      }
    }
  }
  return undefined;
}

export function getBooleanProperty(map: SalusPropertyMap, baseNames: string[]): boolean | undefined {
  for (const baseName of baseNames) {
    for (const prop of map.values()) {
      if (prop.baseName === baseName || prop.name === baseName) {
        const parsed = parseBooleanLike(prop.value);
        if (parsed !== undefined) {
          return parsed;
        }
      }
    }
  }
  return undefined;
}

export function normalizeTemperatureFromX100(value: number): number {
  if (Math.abs(value) >= 100) {
    return Math.round(value) / 100;
  }
  return value;
}

export function normalizePercentage(value: unknown): number | undefined {
  const numeric = parseNumberLike(value);
  if (numeric !== undefined) {
    if (numeric <= 1 && numeric >= 0) {
      return Math.round(numeric * 100);
    }
    if (numeric > 100 && numeric <= 255) {
      return clamp(Math.round((numeric / 255) * 100), 0, 100);
    }
    return clamp(Math.round(numeric), 0, 100);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
      const head = Number.parseInt(trimmed.slice(0, 2), 16);
      return clamp(Math.round((head / 255) * 100), 0, 100);
    }
  }

  return undefined;
}

export function encodePercentageLike(sample: unknown, percentage: number): number | string {
  const bounded = clamp(Math.round(percentage), 0, 100);
  if (typeof sample === 'string' && /^[0-9a-fA-F]{6}$/.test(sample.trim())) {
    const suffix = sample.trim().slice(2);
    const scaled = Math.round((bounded / 100) * 255).toString(16).padStart(2, '0').toUpperCase();
    return `${scaled}${suffix}`;
  }
  return bounded;
}

export function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}
