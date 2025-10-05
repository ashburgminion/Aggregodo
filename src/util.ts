import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { parse as parseIniLib } from 'js-ini';
import { createHash } from "crypto";

export const DATA_DIR = path.join(__dirname, '../data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const FEEDS_PATH = path.join(DATA_DIR, 'feeds.ini');
export const USER_PROFILES_PATH = path.join(DATA_DIR, 'profiles.ini');
export const SYSTEM_PROFILES_PATH = path.join(__dirname, '../res/profiles.ini');
export const SQLITE_PATH = path.join(DATA_DIR, 'data.sqlite');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.ini');
export const TEMPLATE_CONFIG_PATH = path.join(__dirname, '../res/config.template.ini');

export type Nullable<T> = T|null|undefined;

export const parseIni = (ini: string) => parseIniLib(ini, { comment: ['#', ';'] });

export function prepareFilesystem() {
  mkdirSync(DATA_DIR, { recursive: true });
  for (const file of [FEEDS_PATH, USER_PROFILES_PATH]) {
    if (!existsSync(file)) {
      writeFileSync(file, '');
    }
  }
  if (!existsSync(CONFIG_PATH)) {
    copyFileSync(TEMPLATE_CONFIG_PATH, CONFIG_PATH);
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