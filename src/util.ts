import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { PATHS } from "./data";

export type Nullable<T> = T|null|undefined;

export function prepareFilesystem() {
  mkdirSync(PATHS.DATA_DIR, { recursive: true });
  for (const file of [PATHS.FEEDS, PATHS.USER_PROFILES]) {
    if (!existsSync(file)) {
      writeFileSync(file, '');
    }
  }
  if (!existsSync(PATHS.CONFIG)) {
    copyFileSync(PATHS.TEMPLATE_CONFIG, PATHS.CONFIG);
  }
}

export function parseBool(v: Nullable<boolean|string|number>) {
  if (v === null || v === undefined) {
    return null;
  } else if (typeof v === 'boolean') {
    return v;
  } else {
    v = v.toString().toLowerCase();
    if (['true', 'yes', '1'].includes(v)) {
      return true;
    } else if (['false', 'no', '0'].includes(v)) {
      return false;
    } else {
      return null;
    }
  }
}

export const checkDateValid = (date: Nullable<Date|string>): date is Date => date ? !isNaN(new Date(date).getTime()) : false;

export function compareDates(a: Nullable<Date|string>, b: Nullable<Date|string>) {
  if (!a || !b) {
    throw new Error('Invalid date input');
  }
  const [timeA, timeB] = [new Date(a).getTime(), new Date(b).getTime()];
  if (isNaN(timeA) || isNaN(timeB)) {
    throw new Error('Invalid date input');
  }
  return timeA === timeB;
}

export const hashString = (str: string, method: string) => createHash(method).update(str).digest('hex');

export const debugStringHash = (str?: string|null) => str ? hashString(str, 'md5') : 'null';

export const filterObject = (obj: object, keys: string[], inclusive: boolean = true, revert: boolean = true) => {
  const entries = Object.entries(obj).filter(([key, value]) => (value && (inclusive ? keys.includes(key) : !keys.includes(key))));
  return (revert ? Object.fromEntries(entries) : entries);
}