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
import * as cheerio from 'cheerio';
import { formatDistanceToNow } from 'date-fns';
import { WebSocket } from '@fastify/websocket';
import { Model, ModelStatic, WhereOptions } from 'sequelize';
import { MakeNullishOptional } from 'sequelize/types/utils';
import { createWriteStream, existsSync } from 'fs';
import { finished } from 'stream/promises';
import { Readable } from 'stream';
import Defuddle from 'defuddle';
import { JSDOM } from 'jsdom';
import DOMPurify from 'dompurify';
import { Config, Prefs } from './prefs';
import createError from '@fastify/error';
import axios from 'axios';
import { parseHtmlFeed } from './html-scraper';
import { MEDIA_DIR, FEEDS_PATH, prepareFilesystem, parseBool, checkDateValid, compareDates, USER_PROFILES_PATH, parseIni, SYSTEM_PROFILES_PATH } from './util';

prepareFilesystem();

const NotFoundError = createError('NOT_FOUND', 'Page Not Found', 404);

const makeErrorPage = (code: number, message: string) => `<!DOCTYPE html>
  <title>${code} | ${message}</title>
  <div>
    <h2>${code} | ${message}</h2>
    <p>Go back to <a href="${urlFor('/')}">home</a></p>
  </div>
  <style>
    html, body { height: 100%; overflow: hidden; }
    body { display: flex; align-items: center; }
    div { width: 100%; text-align: center; }
  </style>`;

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

const app = Fastify({
  maxParamLength: 1000, // by default request with very long paths are rejected
  logger: Config.Development,
})
.register(fastifySchedule)
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
      env.addGlobal('Prefs', Prefs);
      env.addGlobal('urlFor', urlFor);
      env.addGlobal('slugifyUrl', slugifyUrl);
      env.addGlobal('getLinksPrefix', (req: FastifyRequest) => Config.LinksPrefix || `${req.protocol}://${req.hostname}:${req.port}`);
    },
  },
})
.register(fastifyStatic, {
  root: path.join(__dirname, '../public'),
})
.register(fastifyStatic, {
  root: MEDIA_DIR,
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

function unslugifyObject<T>(slug: string, objects: T[], key: string) {
  for (const obj of objects) {
    if (slugifyUrl((obj as any)[key]) === slug) {
      return obj;
    }
  }
}

function urlFor(route: string, params: Record<string, string|number> = {}) {
  return Object.entries(params).reduce(
    (url, [key, value]) => url.replace(`:${key}`, encodeURIComponent(String(value))),
    route);
}

type PaginatableRequest = FastifyRequest<{ Querystring: { page: string, limit: string } }>;
type SearchableRequest = FastifyRequest<{ Querystring: { search: string } }>;
type PaginatableSearchableRequest = FastifyRequest<{ Querystring: PaginatableRequest['query'] & SearchableRequest['query'] }>;

function resultize<T extends Model>(
  req: PaginatableSearchableRequest, reply: FastifyReply,
  template: string,
  key: string, items: T[],
  extra?: object,
  type?: string,
) {
  const page = parseInt(req.query.page) || 1;
  const queryLimit = parseInt(req.query.limit);
  const limit = queryLimit || Prefs.ResultLimit;
  const offset = (page - 1) * limit;
  const ceiling = offset + limit;
  let search = req.query.search;
  if (search) {
    search = search.toLowerCase();
    items = items.filter((item: any) => {
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
  return reply.view(template, { [key]: items, limit: queryLimit, page, next, search, ...extra });
}

function broadcastMessage(message: string, info?: string|boolean) {
  if (info) {
    console.log(`Broadcast: ${message}: ${info}`);
  } else if (Config.Development) {
    console.log('Broadcast: ' + message);
  }
  for (const client of activeClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// function mergeFeed(a: Feed|FeedType, b/*?*/: Feed|FeedType): Partial<Feed> {
//   let feed, dbFeed;
//   if (a instanceof Feed) {
//     feed = b;
//     dbFeed = a;
//   } else if (b instanceof Feed) {
//     feed = a;
//     dbFeed = b;
//   }
//   // if (!b) {
//   //   if (a instanceof Feed) {
//   //     feed = null;
//   //   } else {
//   //     dbFeed = null;
//   //   }
//   // }
//   return { ...dbFeed, ...feed };
// }

async function createOrUpdate<T extends Model>(
  model: ModelStatic<T>,
  data: MakeNullishOptional<T['_creationAttributes']>,
  // where: WhereOptions<T['_creationAttributes']> = data,
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

function sanitizeHtml(html: string) {
  return DOMPurify(new JSDOM().window).sanitize(html, { ADD_TAGS: ['iframe'] });
}

async function readerifyWebpage(url: string, html?: string) {
  const doc = (html ? new JSDOM(html, { url }) : await JSDOM.fromURL(url)).window.document;
  doc.querySelectorAll('a[href]').forEach(el => (el as HTMLAnchorElement).href = (el as HTMLAnchorElement).href);
  doc.querySelectorAll('img[src], video[src], audio[src], iframe[src]').forEach(el => (el as HTMLSourceElement).src = (el as HTMLSourceElement).src);
  const article = new Defuddle(doc, { debug: Config.Development }).parse();
  article.content = sanitizeHtml(article.content);
  return article;
}

const getMediaPath = (entry: Entry, media: string, filesystem: boolean) => `${filesystem ? MEDIA_DIR : '/media'}/${entry.feedId}/${entry.id}${extname(media)}`;

const getEntriesForView = async (feed?: Feed|null) => {
  const entries = (await Entry.findAll({ ...(feed ? { where: { feedId: feed.id } } : null) }))
    .sort((a, b) => (checkDateValid(a.published) && checkDateValid(b.published) ? new Date(a.published).getTime() - new Date(b.published).getTime() : b.id - a.id))
    .reverse();
  for (const entry of entries) {
    if (!entry.link) {
      entry.link = entry.guid;
    }
    if (entry.published) {
      try {
        entry.relPublished = formatDistanceToNow(entry.published, { addSuffix: true });
      } catch (e) {
        console.error(e);
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
  }
  return entries;
};

function patchViewFeed(feed: FeedType): FeedType {
  const iconPath = `/${feed.id}/icon.png`;
  if (existsSync(MEDIA_DIR + iconPath)) {
    feed.icon = '/media' + iconPath;
  }
  return feed;
}

const getTemplateFeeds = async (feeds?: Feed[]) => (feeds || await indexFeeds()).reduce((acc: any, feed) => {
  acc[feed.id!] = feed;
  return acc;
}, {});

async function getFeedProfiles(): Promise<Record<string, FeedType>> {
  const profiles: Record<string, FeedType> = {};
  const data = {
    ...(existsSync(SYSTEM_PROFILES_PATH) && parseIni(await readFile(SYSTEM_PROFILES_PATH, 'utf8'))),
    ...parseIni(await readFile(USER_PROFILES_PATH, 'utf8')) };
  for (const name in data) {
    profiles[name] = data[name] as FeedType;
  }
  return profiles;
}

async function getRawFeeds(): Promise<FeedType[]> {
  const feeds: FeedType[] = [];
  const data = parseIni(await readFile(FEEDS_PATH, 'utf8'));
  for (let url in data) {
    const props = data[url];
    if (!(url.toLowerCase().startsWith('http://') || url.toLowerCase().startsWith('https://'))) {
      url = 'https://' + url;
    }
    feeds.push({ url, ...(props as object) });
  }
  return feeds;
}

async function indexFeeds(): Promise<FeedType[]> {
  let profiles: Record<string, FeedType>|null = null;
  const feeds = await getRawFeeds();
  for (const feed of feeds) {
    const [dbFeed, created] = await createOrUpdate(Feed, { url: feed.url });
    if (created) {
      updateFeed(feed, dbFeed, true);
    }
    if (feed.profile) {
      if (!profiles) {
        profiles = await getFeedProfiles();
      }
      Object.assign(feed, profiles[feed.profile], feed);
    }
    feed.id = dbFeed!.id;
    feed.description = dbFeed.description;
    if (dbFeed?.name) {
      feed.name ||= dbFeed.name;
    }
    patchViewFeed(feed);
  }
  return feeds;
}

async function refreshAndStoreFeed(feed: FeedType, dbFeed: Feed) {
  try {
    const response = await axios.get(feed.url, { headers: {
      ...(dbFeed.etag && { 'If-None-Match': dbFeed.etag }),
      ...(dbFeed.lastModified && { 'If-Modified-Since': new Date(dbFeed.lastModified).toUTCString() }),
    } });
    const text = response.data;
    const parsed = feed.type === 'html' ? parseHtmlFeed(text, feed) : await feedParser.parseString(text);
    if (Config.Development) {
      console.log(parsed);
    }
    await Feed.upsert({
      url: feed.url,
      name: parsed.title,
      description: parsed.description,
      etag: response.headers['etag'],
      lastModified: response.headers['last-modified'],
    });
    await storeFavicon(feed);
    return parsed;
  } catch (e: any) {
    console.error(`Feed ${feed.url} not refreshed due to ${e}`);
  }
}

async function updateFeed(feed: FeedType, dbFeed: Feed, single: boolean) {
  if (single) {
    broadcastMessage('FEED_UPDATE_STARTED');
  }
  const parsed = await refreshAndStoreFeed(feed, dbFeed);
  if (parsed) {
    for (const item of parsed.items) {
      const guid = item.guid || item.link;
      if (guid) {
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
          // image: getMedia(feed, item, 'image'),
          // video: getMedia(feed, item, 'video'),
          published: item.isoDate || item.published,
          feedId: dbFeed.id,
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
        entry.video = getMedia(feed, item, 'video', entry.image ? null : html);
        if (!dbEntry) {
          dbEntry = await Entry.create(entry);
        } else {
          dbEntry = await dbEntry.update(entry);
        }
        await storeMedia(dbEntry);
      }
    }
  }
  if (single) {
    broadcastMessage('FEED_UPDATE_FINISHED');
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

const getMediaFromHtml = (html: string, type: string) => {
  const $ = cheerio.load(html);
  const media = $(type === 'image' ? 'img' : type).map((_i, el) => $(el).attr('src')).get();
  if (media.length > 0) {
    return media[0];
  }
};

const updateFeedsTask = new AsyncTask(
  'update-feeds',
  async () => {
    broadcastMessage('FEEDS_UPDATE_STARTED', true);
    for (const feed of await indexFeeds()) {
      broadcastMessage('FEEDS_UPDATE_RUNNING', feed.url);
      try {
        await updateFeed(feed, (await Feed.findOne({ where: { url: feed.url } }))!, false);
      } catch(e) {
        console.error(e);
      }
    }
    broadcastMessage('FEEDS_UPDATE_FINISHED', true);
  },
  (err) => {
    console.error('Feed update failed:', err);
  }
);

async function storeMedia(entry: Entry) {
  // TODO: update media if it changes
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
  const iconPath = `${MEDIA_DIR}/${feed.id}/icon.png`;
  if (!existsSync(iconPath)) {
    const response = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(feed.url.split('/').slice(0, 3).join('/'))}&sz=24`);
    if (response.ok) {
      await mkdir(dirname(iconPath), { recursive: true });
      await writeFile(iconPath, (await response.blob()).stream());
    }
  }
}

async function findFeedBySlug(slug: string, feeds?: FeedType[]): Promise<Feed|null> {
  feeds ||= await indexFeeds();
  for (const feed of feeds) {
    if (slugifyUrl(feed.url) === slug) {
      return Object.assign({}, await Feed.findOne({ where: { url: feed.url } }), feed);
    }
  }
  return null;
}

app.ready().then(async () => {
  await sequelize.sync();
  const job = new SimpleIntervalJob({ minutes: 10 }, updateFeedsTask);
  job.executeAsync();
  app.scheduler.addSimpleIntervalJob(job);
});

app.get('/', async (req: PaginatableSearchableRequest, reply) => {
  const feeds = await getTemplateFeeds();
  return resultize(req, reply, 'index.njk', 'entries', await getEntriesForView(), { feeds });
})
.get('/atom', async (req: PaginatableSearchableRequest, reply) => {
  const feeds = await getTemplateFeeds();
  return resultize(req, reply, 'atom.njk', 'entries', await getEntriesForView(), { feeds, req }, 'application/atom+xml; charset=UTF-8');
})
.get('/feed/:feed', async (req: FastifyRequest<{ Params: { feed: string }, Querystring: PaginatableSearchableRequest['query'] }>, reply) => {
  const feeds = await indexFeeds();
  const feed = await findFeedBySlug(req.params.feed, feeds);
  if (feed) {
    return resultize(req, reply, 'index.njk', 'entries', await getEntriesForView(feed), { feed, feeds: await getTemplateFeeds() });
  } else {
    throw NotFoundError();
  }
})
.get('/feed/:feed/atom', async (req: FastifyRequest<{ Params: { feed: string }, Querystring: PaginatableSearchableRequest['query'] }>, reply) => {
  const feed = await findFeedBySlug(req.params.feed);
  if (feed) {
    return resultize(req, reply, 'atom.njk', 'entries', await getEntriesForView(feed), { feed, req }, 'application/atom+xml; charset=UTF-8');
  } else {
    throw NotFoundError();
  }
})
.get('/entry/:entry', async (req: FastifyRequest<{ Params: { entry: string }, Querystring: { 'external-html': string } }>, reply) => {
  const entry = unslugifyObject(req.params.entry, await getEntriesForView(), 'link');
  if (entry) {
    let extHtml = parseBool(req.query['external-html']);
    if (extHtml === null) {
      extHtml = Prefs.ExternalHtml;
    }
    if (extHtml && entry.html) {
      const $ = cheerio.load(entry.html);
      $('a[href]').each((_i, el) => {
        $(el).attr('target', '_blank');
        $(el).attr('rel', 'nofollow noopener');
      });
      entry.html = $.html();
    }
    const feed = patchViewFeed((await Feed.findOne({ where: { id: entry.feedId } }))!);
    return reply.view('entry.njk', { feed, feeds: await getTemplateFeeds(), entry, extHtml });
  } else {
    throw NotFoundError();
  }
});

// if (Config.Development) {
//   app.post('/api/refresh/:feed', (req: FastifyRequest<{ Params: { feed: number } }>, reply) => {
//     await updateFeed(feed, (await Feed.findOne({ where: { url: feed.url } }))!, false);
//   });
// }

app.setNotFoundHandler((_req, reply) => {
  reply
    .code(404)
    .header('X-Robots-Tag', 'noindex')
    .type('text/html')
    .send(makeErrorPage(404, 'Page Not Found'));
})
.setErrorHandler((err, _req, reply) => {
  const code = err.statusCode || 500;
  reply
    .code(code)
    .header('X-Robots-Tag', 'noindex')
    .type('text/html')
    .send(makeErrorPage(code, code === 500 ? 'Internal Server Error' : err.message));
  if (code !== 404) {
    console.error(err);
  }
})
.listen({ port: Config.Http.Port, host: Config.Http.Host }, () => {
  console.log(`${Config.AppName} running at http://${Config.Http.Host}:${Config.Http.Port}`);
});