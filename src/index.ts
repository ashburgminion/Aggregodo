import { readFile, writeFile, mkdir } from 'fs/promises';
import Fastify, { FastifyReply } from 'fastify';
import { FastifyRequest } from 'fastify';
import view from '@fastify/view';
import nunjucks from 'nunjucks';
import { sequelize, Feed, FeedType, Entry, EntryType } from './db';
import { fastifySchedule } from '@fastify/schedule';
import { SimpleIntervalJob, AsyncTask } from 'toad-scheduler';
import Parser from 'rss-parser';
import fastifyStatic from '@fastify/static';
import path, { dirname, extname } from 'path';
import { formatDistanceToNow } from 'date-fns';
import { WebSocket } from '@fastify/websocket';
import { Model, ModelStatic, WhereOptions } from 'sequelize';
import { MakeNullishOptional } from 'sequelize/types/utils';
import { createWriteStream, existsSync } from 'fs';
import { finished } from 'stream/promises';
import { Readable } from 'stream';
import { Config, Prefs } from './prefs';
import createError from '@fastify/error';
import axios from 'axios';
import { parseHtmlFeed } from './html-scraper';
import { prepareFilesystem, parseBool, checkDateValid, compareDates } from './util';
import { PATHS, ATOM_CONTENT_TYPE } from './data';
import cookie from '@fastify/cookie';
import { getMediaFromHtml, patchReaderContent, readerifyWebpage, sanitizeHtml } from './html-utils';
import { parseIni } from './ini-support';

prepareFilesystem();

const NotFoundError = createError('NOT_FOUND', 'Page Not Found', 404);

const feedParser: Parser<{}, {
  'media:group': any;
  'media:content': string;
  'media:thumbnail': string;
  'media:description': string;
  'content:encoded': string;
  'content:encodedSnippet': string;
}> = new Parser({ customFields: {
  item: ['media:group', 'media:content', 'media:thumbnail', 'media:description'],
} });

const activeClients = new Set<WebSocket>();
const feedUpdateLocks = new Set<number>();

const app = Fastify({
  maxParamLength: 1000, // by default request with very long paths are rejected
  logger: Config.Development,
  ...(Config.Development && { bodyLimit: 1024 * 1024 * 10 }), // allow big POST requests in dev mode, eg. in debug panel
})
.register(fastifySchedule)
.register(cookie)
.register(require('@fastify/formbody'))
.register(require('@fastify/websocket'))
.register(async function (fastify) {
  fastify.get('/ws', { websocket: true }, (socket, _req) => {
    activeClients.add(socket);
    broadcastMessage('CONNECTED');

    socket.on('close', () => {
      activeClients.delete(socket);
    });
  })
})
.register(view, {
  engine: { nunjucks },
  templates: path.join(__dirname, '../res/views'),
  options: {
    noCache: true,
    onConfigure: (env: nunjucks.Environment) => {
      env.addGlobal('Config', Config);
      env.addGlobal('urlFor', urlFor);
      env.addGlobal('slugifyUrl', slugifyUrl);
    },
  },
})
.register(fastifyStatic, {
  root: path.join(__dirname, '../public'),
})
.register(fastifyStatic, {
  root: PATHS.MEDIA_DIR,
  prefix: '/media/',
  decorateReply: false,
})
.addHook('onRequest', async (req, reply) => {
  // redirect requests that have trailing slash
  if (req.url.length > 1 && req.url.endsWith('/')) {
    reply.redirect(req.url.slice(0, -1));
  }
});

function slugifyUrl(url: string) {
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, '') // Remove protocol
    .replace(/[/?=&]/g, '-')     // Replace URL symbols with hyphens
    .replace(/[^a-z0-9-.]/g, '') // Remove other special characters
}

function urlFor(route: string, params: Record<string, string|number> = {}) {
  return Object.entries(params).reduce(
    (url, [key, value]) => url.replace(`:${key}`, encodeURIComponent(String(value))),
    route);
}

function getPrefs(req: FastifyRequest, all: boolean = true): typeof Prefs {
  let prefs = { ...(all ? Prefs : null) } as typeof Prefs;
  const cookie = req.cookies['Prefs'];
  if (cookie) {
    try {
      prefs = { ...prefs, ...JSON.parse(cookie) };
    } catch(e) {
      log(LogLevel.ERROR, e);
    }
  }
  return prefs;
}

const getLinksPrefix = (req: FastifyRequest) => Config.LinksPrefix || `${req.protocol}://${req.hostname}:${req.port}`;

type PaginatableRequest = FastifyRequest<{ Querystring: { page: string, limit: string } }>;
type SearchableRequest = FastifyRequest<{ Querystring: { search: string } }>;
type PaginatableSearchableRequest = FastifyRequest<{ Querystring: PaginatableRequest['query'] & SearchableRequest['query'] }>;

async function resultize<T extends Model>(
  req: PaginatableSearchableRequest, reply: FastifyReply,
  template: string,
  key: string, items: T[]|((offset?: number, limit?: number) => Promise<T[]>),
  extra?: object,
  type?: string,
) {
  const page = parseInt(req.query.page) || 1;
  const queryLimit = parseInt(req.query.limit);
  const limit = queryLimit || getPrefs(req).ResultLimit;
  const offset = (page - 1) * limit;
  const ceiling = offset + limit;
  const search = req.query.search?.toLowerCase();
  if (typeof items === 'function') {
    items = search ? await items() : await items(offset, ceiling + 1);
  }
  if (search) {
    items = items.filter(item => {
      item = item.toJSON();
      for (const key in item) {
        if (item[key] && (item[key].toString() as string).toLowerCase().search(search) > -1) {
          return true;
        }
      }
      return false;
    });
  }
  const next = items.length > ceiling ? (page + 1) : null;
  items = items.slice(offset, ceiling);
  if (type) {
    reply.type(type);
  }
  return reply.view(template, {
    [key]: items, limit: queryLimit, page, next, search,
    prefs: getPrefs(req), linksPrefix: getLinksPrefix(req), ...extra });
}

function broadcastMessage(message: string, ...info: (string|boolean)[]) {
  info[0]
    ? log(LogLevel.INFO, `Broadcast: ${message}:`, ...info)
    : log(LogLevel.DEBUG, `Broadcast: ${message}`);
  for (const client of activeClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

export enum LogLevel { DEBUG, TRACE, ERROR, INFO };

export function log(level: LogLevel, ...messages: any) {
  if (Config.Development || level > LogLevel.DEBUG) {
    if (Config.LogFile) {
      createWriteStream(PATHS.LOG_FILE, { flags: 'a' }).write(messages.join(' ') + '\n');
    }
    switch (level) {
      case LogLevel.TRACE:
        return console.trace(...messages);
      case LogLevel.ERROR:
        return console.error(...messages);
      default:
        return console.debug(...messages);
    }
  }
}

async function createOrUpdate<T extends Model>(
  model: ModelStatic<T>,
  data: MakeNullishOptional<T['_creationAttributes']>,
): Promise<[T, boolean]> {
  // Detect primary or unique keys
  const keys = Object.entries(model.getAttributes())
    .filter(([_, attr]) => attr.primaryKey || attr.unique)
    .map(([key]) => key);

  if (keys.length === 0) {
    throw new Error(`Model ${model.name} has no primary or unique key defined.`);
  }

  // Build the WHERE clause from the key fields
  const where: WhereOptions<T["_creationAttributes"]> = {};
  for (const key of keys) {
    if (data[key as keyof typeof data] !== undefined) {
      where[key as keyof typeof where] = data[key as keyof typeof data];
    }
  }

  let created = false;
  let record = await model.findOne({ where });

  if (!record) {
    record = await model.create(data);
    created = true;
  } else {
    record = await record.update(data);
  }

  return [record, created];
}

const getMediaPath = (entry: Entry, media: string, filesystem: boolean) => `${filesystem ? PATHS.MEDIA_DIR : '/media'}/${entry.feedId}/${entry.id}${extname(media.split('?')[0])}`;

const getEntriesForView = async ({ feed, feeds, limit, offset }: { feed?: Feed, feeds?: Feed[], limit?: number, offset?: number } = {}) => {
  const feedIds = (feeds ||= await indexFeeds()).map(feed => feed.id);
  const entries = (await Entry.findAll({
    where: { feedId: feed ? feed.id : feedIds },
    order: [['published', 'DESC'], ['id', 'DESC']],
    offset, limit,
  }));
  for (let entry of entries) {
    entry = patchEntryForView(entry);
  }
  return entries;
};

const makeEntriesForView = (data: object = {}) => ((offset?: number, limit?: number) => getEntriesForView({ ...data, offset, limit }));

function patchEntryForView(entry: Entry): Entry {
  if (!entry.link) {
    entry.link = entry.guid;
  }
  if (entry.published) {
    try {
      entry.isoPublished = new Date(entry.published).toISOString();
      entry.relPublished = formatDistanceToNow(entry.published, { addSuffix: true });
    } catch (e) {
      log(LogLevel.ERROR, e);
    }
  }
  if (entry.image && existsSync(getMediaPath(entry, entry.image, true))) {
    entry.image = getMediaPath(entry, entry.image, false);
  }
  // youtube embed
  if (entry.link.startsWith('https://www.youtube.com/')) {
    const tokens = entry.link.split('/').slice(-1)[0].split('=');
    entry.embed = 'https://www.youtube-nocookie.com/embed/' + (tokens[1] || tokens[0]);
  }
  if (entry.content) {
    entry.content = sanitizeHtml(entry.content);
  }
  return entry;
}

function patchViewFeed(feed: FeedType): FeedType {
  const iconPath = `/${feed.id}/icon.png`;
  if (existsSync(PATHS.MEDIA_DIR + iconPath)) {
    feed.icon = '/media' + iconPath;
  }
  return feed;
}

const getTemplateFeeds = async (feeds?: Feed[]): Promise<Record<number, Feed>> => (feeds || await indexFeeds()).reduce((acc: any, feed) => {
  acc[feed.id!] = feed;
  return acc;
}, {});

async function getFeedProfiles(): Promise<Record<string, FeedType>> {
  const profiles: Record<string, FeedType> = {};
  const data = {
    ...(existsSync(PATHS.SYSTEM_PROFILES) && parseIni(await readFile(PATHS.SYSTEM_PROFILES, 'utf8'))),
    ...parseIni(await readFile(PATHS.USER_PROFILES, 'utf8')) };
  for (const name in data) {
    profiles[name] = data[name] as unknown as FeedType;
  }
  return profiles;
}

async function getRawFeeds(ini?: string): Promise<FeedType[]> {
  let profiles: Record<string, FeedType>|null = null;
  const feeds: FeedType[] = [];
  const data = parseIni(ini || await readFile(PATHS.FEEDS, 'utf8'));
  for (let url in data) {
    const props = data[url];
    if (!(url.toLowerCase().startsWith('http://') || url.toLowerCase().startsWith('https://'))) {
      url = 'https://' + url;
    }
    let feed: FeedType = { url, ...(props as object) };
    if (feed.status == 'disabled') {
      continue;
    }
    feed.fake_browser &&= parseBool(feed.fake_browser) ?? false;
    if (feed.profile) {
      if (!profiles) {
        profiles = await getFeedProfiles();
      }
      feed = { ...profiles[feed.profile], ...feed };
    }
    feeds.push(feed);
  }
  return feeds;
}

async function indexFeeds(returnHidden: boolean = false): Promise<Feed[]> {
  const feeds: Feed[] = [];
  for (const feed of await getRawFeeds()) {
    const [dbFeed, createdNow] = await createOrUpdate(Feed, { url: feed.url });
    copyFields(dbFeed.toJSON(), feed);
    if (createdNow) {
      updateFeed(feed as Feed, true);
    }
    if (returnHidden || feed.status !== 'hidden') {
      patchViewFeed(feed);
      feeds.push(feed as Feed);
    }
  }
  return feeds;
}

const copyFields = <T extends object>(src: T, dst: T): T => {
  for (const key in src) {
    dst[key] ||= src[key];
  }
  return src;
}

function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  text.split(/\r?\n/).forEach(line => {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) {
      headers[key.trim()] = rest.join(':').trim();
    }
  });
  return headers;
}

async function fetchAndParseFeed(feed: FeedType, fakeBody?: string|null, force: boolean = true, allowInvalid = false) {
  try {
    const response = !fakeBody ? await axios.get(feed.url, { headers: {
      ...(feed.fake_browser && {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Sec-Fetch-Mode': 'navigate',
      }),
      ...(feed.http_headers && parseHeaders(feed.http_headers)),
      // ...(feed.user_agent && { 'User-Agent': feed.user_agent }),
      ...(!force && feed.etag && { 'If-None-Match': feed.etag }),
      ...(!force && feed.lastModified && { 'If-Modified-Since': new Date(feed.lastModified).toUTCString() }),
    } }) : null;
    const text = !fakeBody ? response?.data: fakeBody;
    const parsed = feed.type === 'html' ? parseHtmlFeed(text, feed, allowInvalid) : await feedParser.parseString(text);
    log(LogLevel.DEBUG, text, parsed);
    return { parsed, response };
  } catch (e: any) {
    const error = `Feed ${feed.url} not refreshed due to: ${e}`;
    log(LogLevel.TRACE, error);
    return { error, errorCode: e.response?.status };
  }
}

async function updateFeed(feed: Feed, single: boolean, force: boolean = false) {
  if (!feed.id || feedUpdateLocks.has(feed.id)) {
    return;
  }
  feedUpdateLocks.add(feed.id);
  if (single) {
    broadcastMessage('FEED_UPDATE_STARTED');
  }
  let success = true;
  const { parsed, response, error, errorCode } = await fetchAndParseFeed(feed, null, force);
  if (parsed) {
    await Feed.upsert({
      url: feed.url,
      name: parsed.title,
      description: parsed.description,
    });
    await storeFavicon(feed);
    for (const item of parsed.items) {
      const { error } = await updateFeedEntry(feed, item);
      if (error) {
        success = false;
      }
    }
    await Feed.upsert({
      url: feed.url,
      lastStatus: null,
      ...(success && { etag: response?.headers['etag'] }),
      ...(success && { lastModified: response?.headers['last-modified'] }),
    });
  } else if (errorCode !== 304) { // HTTP not modified
    await Feed.upsert({
      url: feed.url,
      lastStatus: error,
    });
  }
  if (single) {
    broadcastMessage('FEED_UPDATE_FINISHED');
  }
  feedUpdateLocks.delete(feed.id);
}

async function updateFeedEntry(feed: Feed, item: any) {
  try {
    const guid = item.guid || item.link;
    if (!guid) {
      throw 'Entry has no guid!';
    }
    broadcastMessage('FEED_UPDATE_RUNNING', feed.url, guid);
    let mediaDescription = item['media:description'] || item['media:group']?.['media:description'];
    if (mediaDescription?.length > 0) {
      mediaDescription = mediaDescription[0];
    }
    const entry: EntryType = {
      guid,
      link: item.link,
      title: item.title,
      summary: item.summary || item.contentSnippet || item['content:encodedSnippet'] || mediaDescription,
      content: item['content:encoded'] || item.content,
      published: item.isoDate || item.published,
      author: item.creator || item.author,
      feedId: feed.id,
    };
    let dbEntry = await Entry.findOne({ where: { guid } });
    if (entry.link && (!dbEntry || checkEntryChanged(entry, dbEntry))) {
      const request = await fetch(entry.link);
      if (request.ok) {
        entry.html = (await readerifyWebpage(entry.link)).content;
      }
    }
    const html = entry.html || dbEntry?.html;
    entry.image = item.image || getMedia(feed, item, 'image', html);
    entry.video = item.video || getMedia(feed, item, 'video', entry.image ? null : html);
    if (!dbEntry) {
      dbEntry = await Entry.create(entry);
    } else {
      dbEntry = await dbEntry.update(entry);
    }
    await cacheMedia(dbEntry);
    return { entry };
  } catch (e) {
    log(LogLevel.ERROR, "Entry update failed:", e);
    return { error: `Entry update failed: ${e}` };
  }
}

const checkEntryChanged = (a: EntryType, b: EntryType) => (
  (checkDateValid(a.published) && checkDateValid(b.published) && !compareDates(a.published, b.published)) ||
  a.title != b.title ||
  a.summary != b.summary ||
  a.content != b.content);

const getMedia = (feed: FeedType, item: any, type: string, html?: string|null) => {
  let url = null;
  if (item.enclosure?.type.startsWith(`${type}/`)) {
    url = item.enclosure.url;
  }
  if (!url && type === 'image') {
    let mediaThumb = item['media:thumbnail'] || item['media:group']?.['media:thumbnail'];
    if (mediaThumb?.length > 0) {
      url = mediaThumb[0].$.url;
    }
  }
  if (!url) {
    const html = item['content:encoded'] || item.content;
    if (html) {
      url = getMediaFromHtml(html, type);
    }
  }
  if (!url && html) {
    url = getMediaFromHtml(html, type);
  }
  if (url && !(url.startsWith('//') || url.toLowerCase().startsWith('http://') || url.toLowerCase().startsWith('https://'))) {
    if (url.startsWith('/')) {
      url = feed.url.split('/').slice(0, 3).join('/') + url;
    } else {
      const prefix = item.link || item.guid;
      if (prefix) {
        url = prefix + (prefix.endsWith('/') ? prefix.split('/').slice(0, -1).join('/') + '/' : '') + url;
      }
    }
  }
  return url;
};

async function cacheMedia(entry: Entry) {
  // TODO: update media if it changes in content but url remains the same? (how?)
  if (entry.image) {
    const mediaPath = getMediaPath(entry, entry.image, true);
    if (!existsSync(mediaPath)) {
      const response = await fetch(entry.image);
      if (response.ok) {
        await mkdir(dirname(mediaPath), { recursive: true });
        await finished(Readable.from((await response.blob()).stream()).pipe(createWriteStream(mediaPath, { flags: 'w' })));
      }
    }
  }
}

async function storeFavicon(feed: FeedType) {
  const iconPath = `${PATHS.MEDIA_DIR}/${feed.id}/icon.png`;
  if (!existsSync(iconPath)) {
    const response = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(feed.url.split('/').slice(0, 3).join('/'))}&sz=24`);
    if (response.ok) {
      await mkdir(dirname(iconPath), { recursive: true });
      await writeFile(iconPath, (await response.blob()).stream());
    }
  }
}

async function findFeedById(id: number): Promise<Feed|null> {
  const dbFeed = await Feed.findOne({ where: { id } });
  if (dbFeed) {
    for (const feed of await indexFeeds(true)) {
      if (feed.url === dbFeed.url) {
        return Object.assign({}, dbFeed, feed);
      }
    }
  }
  return null;
}

async function findFeedBySlug(slug: string, feeds?: FeedType[]): Promise<Feed|null> {
  for (const feed of (feeds || await indexFeeds(true))) {
    if (slugifyUrl(feed.url) === slug) {
      return Object.assign({}, await Feed.findOne({ where: { url: feed.url } }), feed);
    }
  }
  return null;
}

async function findEntryForView(slug: string): Promise<Entry|null> {
  for (const entry of await Entry.findAll({ attributes: ['guid', 'link'] })) {
    const { guid, link } = entry;
    if (slugifyUrl(link || guid) === slug) {
      return patchEntryForView((await Entry.findOne({ where: { guid, link } }))!);
    }
  }
  return null;
}

function entryToMarkdown(entry: Entry) {
  const data = patchEntryForView(entry.toJSON());
  return `---
${Object.entries(data).filter(([key, value]) => (value && !['content', 'html'].includes(key))).map(([key, value]) => `${key}: ${value}\n`).join('').trim()}
---

${data.content || data.html}`;
}

async function updateAllFeeds(force: boolean = false) {
  broadcastMessage('FEEDS_UPDATE_STARTED', true);
  for (const feed of await indexFeeds(true)) {
    broadcastMessage('FEEDS_UPDATE_RUNNING', feed.url);
    try {
      await updateFeed(feed, false, force);
    } catch(e) {
      log(LogLevel.ERROR, e);
    }
  }
  broadcastMessage('FEEDS_UPDATE_FINISHED', true);  
}

app.ready().then(async () => {
  await sequelize.sync();
  const job = new SimpleIntervalJob({ minutes: Config.UpdateInterval }, new AsyncTask(
    'update-feeds',
    async () => updateAllFeeds(),
    (err) => log(LogLevel.ERROR, 'Feeds update failed:', err),
  ));
  job.executeAsync();
  app.scheduler.addSimpleIntervalJob(job);
});

app
.get('/', async (req: PaginatableSearchableRequest, reply) => {
  const feeds = await indexFeeds();
  return resultize(req, reply, 'index.njk', 'entries', makeEntriesForView({ feeds }), {
    feeds, feedsMap: await getTemplateFeeds(feeds as Feed[]),
  });
})
.get('/feed/:feed', async (req: FastifyRequest<{ Params: { feed: string }, Querystring: PaginatableSearchableRequest['query'] }>, reply) => {
  const feeds = await indexFeeds();
  const feed = await findFeedBySlug(req.params.feed);
  if (feed) {
    return resultize(req, reply, 'index.njk', 'entries', makeEntriesForView({ feed, feeds }), {
      feed, feeds, feedsMap: await getTemplateFeeds(feeds as Feed[]),
    });
  } else {
    throw NotFoundError();
  }
})
.get('/entry/:entry', async (req: FastifyRequest<{ Params: { entry: string }, Querystring: { 'external-html': string } }>, reply) => {
  // TODO: this currently returns a positive response for entries that belong to disabled feeds; should the behavior be different?
  const feeds = await indexFeeds();
  const entry = await findEntryForView(req.params.entry);
  if (entry) {
    if (getPrefs(req).ReaderMode) {
      const extHtml = parseBool(req.query['external-html']) ?? getPrefs(req).ExternalHtml;
      if (extHtml && entry.html) {
        entry.html = patchReaderContent(entry.html);
      }
      const feed = patchViewFeed((await Feed.findOne({ where: { id: entry.feedId } }))!);
      return reply.view('entry.njk', { feed, feeds, feedsMap: await getTemplateFeeds(feeds as Feed[]), entry, extHtml });
    } else {
      return reply.redirect(entry.link!);
    }
  } else {
    throw NotFoundError();
  }
});

app
.get('/atom', async (req: PaginatableSearchableRequest, reply) => {
  return resultize(req, reply, 'atom.njk', 'entries', makeEntriesForView(), { req }, ATOM_CONTENT_TYPE);
})
.get('/feed/:feed/atom', async (req: FastifyRequest<{ Params: { feed: string }, Querystring: PaginatableSearchableRequest['query'] }>, reply) => {
  const feed = await findFeedBySlug(req.params.feed);
  if (feed) {
    return resultize(req, reply, 'atom.njk', 'entries', makeEntriesForView({ feed }), { feed, req }, ATOM_CONTENT_TYPE);
  } else {
    throw NotFoundError();
  }
});

if (Config.Development) {
  app
  .get('/debug', async (_req, reply) => {
    return reply.view('debug.njk', { feeds: await indexFeeds(true) });
  })
  .post('/debug', async (req, _reply) => {
    let output;
    const input = JSON.parse(req.body as string);
    if (input.action) {
      let forceUpdateFeed = false;
      switch (input.action) {
        case 'force-update-feed':
          forceUpdateFeed = true;
        case 'update-feed':
          input.data
            ? updateFeed((await findFeedById(input.data))!, true, forceUpdateFeed)
            : updateAllFeeds(forceUpdateFeed);
          return "OK";
      }
    } else if (input.ini) {
      const feed = (await getRawFeeds(input.ini))[0];
      output = feed;
    } else if (input.feed) {
      const { parsed, response, error } = await fetchAndParseFeed(input.feed, input.httpBody, true, true);
      output = { parsed, error, text: response?.data };
    }
    return output;
  })
  .get('/entry/:entry/markdown', async (req: FastifyRequest<{ Params: { entry: string } }>, reply) => {
    const entry = await findEntryForView(req.params.entry);
    if (entry) {
      return reply
        .header('X-Robots-Tag', 'noindex')
        .type('text/markdown')
        .send(entryToMarkdown(entry));
    } else {
      throw NotFoundError();
    }
  });
}

app.post('*', (req, reply) => {
  const { action, dkey, dvalue } = req.body as { action: string; dkey: string; dvalue: string; };
  if (action === 'set-prefs') {
    const prefs = getPrefs(req, false) as any;
    prefs[dkey] = dvalue;
    reply.setCookie('Prefs', JSON.stringify(prefs), { path: '/', maxAge: 60 * 60 * 24 * 365 * 100 });
  }
  reply.redirect(req.url);
})
.setNotFoundHandler((_req, reply) => {
  reply
    .code(404)
    .header('X-Robots-Tag', 'noindex')
    .view('error.njk', { code: 404, message: 'Page Not Found' });
})
.setErrorHandler((err, _req, reply) => {
  const code = err.statusCode || 500;
  reply
    .code(code)
    .header('X-Robots-Tag', 'noindex')
    .view('error.njk', { code, message: code === 500 ? 'Internal Server Error' : err.message });
  if (code !== 404) {
    log(LogLevel.ERROR, err);
  }
})
.listen({ port: Config.Http.Port, host: Config.Http.Host }, () => {
  log(LogLevel.INFO, `${Config.AppName} running at http://${Config.Http.Host}:${Config.Http.Port}`);
});