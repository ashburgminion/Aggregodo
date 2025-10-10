import path from "path";

const DATA_DIR = path.join(__dirname, '../data');

export const PATHS = {
  DATA_DIR,
  MEDIA_DIR: path.join(DATA_DIR, 'media'),
  LOG_FILE: path.join(DATA_DIR, 'log.txt'),
  FEEDS: path.join(DATA_DIR, 'feeds.ini'),
  USER_PROFILES: path.join(DATA_DIR, 'profiles.ini'),
  SYSTEM_PROFILES: path.join(__dirname, '../res/profiles.ini'),
  SQLITE: path.join(DATA_DIR, 'data.sqlite'),
  CONFIG: path.join(DATA_DIR, 'config.ini'),
  TEMPLATE_CONFIG: path.join(__dirname, '../res/config.template.ini'),
} as const;

export const ATOM_CONTENT_TYPE = 'application/atom+xml; charset=UTF-8';