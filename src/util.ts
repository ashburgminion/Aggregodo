import path from "path";

export const DATA_DIR = path.join(__dirname, '../data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const FEEDS_PATH = path.join(DATA_DIR, 'feeds.txt');
export const SQLITE_PATH = path.join(DATA_DIR, 'data.sqlite');

export type Nullable<T> = T|null|undefined;