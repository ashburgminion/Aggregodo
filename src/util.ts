import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { parse as parseIniLib } from 'js-ini';
import { createHash } from "crypto";
import { PATHS } from "./data";

export type Nullable<T> = T|null|undefined;

export const parseIni = (ini: string) => parseIniLib(ini, { comment: ['#', ';'] });

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

export const debugStringHash = (str?: string|null) => str ? createHash('md5').update(str).digest('hex') : 'null';

// export const extendMerge = <A, B extends A>(a: A, b: B): A & B => ({ ...a, ...b });