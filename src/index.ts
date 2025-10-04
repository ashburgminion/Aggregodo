import { readFile, writeFile, mkdir } from 'fs/promises';
import Fastify, { FastifyReply } from 'fastify';
import { FastifyRequest } from 'fastify';
import view from '@fastify/view';
import nunjucks from 'nunjucks';
// import { User } from './models/user';
import { sequelize, Feed, FeedType, Entry, EntryType } from './db';
import { fastifySchedule } from '@fastify/schedule';
import { SimpleIntervalJob, AsyncTask } from 'toad-scheduler';
import Parser from 'rss-parser';
// import slugify from 'slugify';
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
// import { isProbablyReaderable, Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import DOMPurify from 'dompurify';
import { Config, Prefs } from './prefs';
// import { Events } from '../public/events.js';
// import Zip7 from '../lib/node-7z/lib';
import createError from '@fastify/error';
import axios from 'axios';
import { parse as parseIni } from 'js-ini';
import { parseHtmlFeed } from './html-scraper';
import { MEDIA_DIR, FEEDS_PATH, Nullable } from './util';

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

// const nunjucksEnv = nunjucks.configure('src/views', {
  // autoescape: true,
  // noCache: true,
// });

// nunjucksEnv.addGlobal('urlFor', urlFor);

// const zip7 = new Zip7();

const activeClients = new Set<WebSocket>();

const app = Fastify({
  maxParamLength: 1000,
  logger: Config.Development,
})
.register(fastifySchedule)
.register(require('@fastify/websocket'))
// .register(require('fastify-pagination'))
.register(async function (fastify) {
  fastify.get('/ws', { websocket: true }, (socket, req) => {
    activeClients.add(socket);
    broadcastMessage('CONNECTED');

    // socket.on('message', (message: Buffer) => {
    //   if (message.toString() === 'hi from client')
    //     socket.send('hi from server')
    // });

    socket.on('close', () => {
      activeClients.delete(socket);
      // console.log('Client disconnected');
    });
  })
})
.register(view, {
  engine: { nunjucks /* : nunjucksEnv */ },
  templates: 'src/views',
  options: {
    noCache: true,
    onConfigure: (env: nunjucks.Environment) => {
      env.addGlobal('Config', Config);
      env.addGlobal('Prefs', Prefs);
      env.addGlobal('urlFor', urlFor);
      env.addGlobal('slugifyUrl', slugifyUrl);
      // env.addGlobal('encodeURIComponent', encodeURIComponent);
    },
  },
})
.register(fastifyStatic, {
  root: path.join(__dirname, '../public'),
  // prefix: '/public/', // Optional: URL prefix for accessing files
})
.register(fastifyStatic, {
  root: MEDIA_DIR, // path.join(__dirname, '../media'),
  prefix: '/media/',
  decorateReply: false,
})
.addHook('onRequest', async (req, reply) => {
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

function parseBool(v: boolean|string|number|null) {
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

type PaginatableRequest = FastifyRequest<{ Querystring: { page: string, limit: string } }>;
type SearchableRequest = FastifyRequest<{ Querystring: { search: string } }>;
type PaginatableSearchableRequest = FastifyRequest<{ Querystring: PaginatableRequest['query'] & SearchableRequest['query'] }>;

function resultize<T extends Model>(
  req: PaginatableSearchableRequest, reply: FastifyReply,
  template: string,
  key: string, items: T[],
  extra?: object,
) {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || Prefs.ResultLimit;
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
  return reply.view(template, { [key]: items, page, next, search, ...extra });
}

function broadcastMessage(message: string) {
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
    // if (data[key as keyof typeof data] === undefined) {
    //   throw new Error(`Missing value for key field "${key}" in data.`);
    // }
    // where[key as keyof typeof where] = data[key as keyof typeof data];
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

// function cleanHtmlForStorage(html: string) {
//   const dom = new JSDOM(html);
//   const doc = dom.window.document;
//   Array.from(doc.getElementsByTagName('style')).forEach(el => el.remove());
//   doc.querySelectorAll('script:not([src]), [src^="data:"]').forEach(el => el.remove());
//   return dom.serialize();
// }

function sanitizeHtml(html: string) {
  return DOMPurify(new JSDOM().window).sanitize(html, { ADD_TAGS: ['iframe'] });
}

async function readerifyWebpage(url: string, html?: string) {
  /* const request = await fetch(url);
  if (request.ok) {
    const html = await request.text();
    const doc = new JSDOM(html, { url }).window.document;
    // if (isProbablyReaderable(doc)) {
      const article = new Readability(doc).parse();
      if (article && article.content) {
        article.content = sanitizeHtml(article.content);
      }
      return article;
    // }
  } */
  const doc = (html ? new JSDOM(html, { url }) : await JSDOM.fromURL(url)).window.document;
  doc.querySelectorAll('a[href]').forEach(el => (el as HTMLAnchorElement).href = (el as HTMLAnchorElement).href);
  doc.querySelectorAll('img[src], video[src], audio[src], iframe[src]').forEach(el => (el as HTMLSourceElement).src = (el as HTMLSourceElement).src);
  const article = new Defuddle(doc, { debug: Config.Development }).parse();
  // console.log(article);
  article.content = sanitizeHtml(article.content);
  return article;
}

const getMediaPath = (entry: Entry, media: string, filesystem: boolean) => `${filesystem ? MEDIA_DIR : '/media'}/${entry.feedId}/${entry.id}${extname(media)}`;
// const getMediaPath = (parent: Entry|Feed, media: string) => `media/${(parent as any).feedId || parent.id}/${entry.id}${extname(media)}`;

const getViewEntries = async (feed?: Feed|null) => {
  // const feeds = await indexFeeds();
  const entries = (await Entry.findAll({ ...(feed ? { where: { feedId: feed.id } } : null) }))
    .sort((a, b) => (checkDateValid(a.published) && checkDateValid(b.published) ? new Date(a.published).getTime() - new Date(b.published).getTime() : b.id - a.id))
    .reverse();
  for (const entry of entries) {
    if (!entry.link) {
      entry.link = entry.guid;
    }
    if (entry.published) {
      try {
        entry.published = formatDistanceToNow(entry.published, { addSuffix: true });
      } catch (e) {
        console.error(e);
      }
    }
    if (entry.image) {
      // const mediaPath = getMediaPath(entry, entry.image);
      // if (existsSync(mediaPath)) {
      //   entry.image = `/${mediaPath}`;
      // }
      if (existsSync(getMediaPath(entry, entry.image, true))) {
        entry.image = getMediaPath(entry, entry.image, false);
      }
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
}

function patchViewFeed(feed: FeedType): FeedType {
  const iconPath = `/${feed.id}/icon.png`;
  if (existsSync(MEDIA_DIR + iconPath)) {
    feed.icon = '/media' + iconPath;
  }
  return feed;
};

const getTemplateFeeds = async (feeds?: Feed[]) => (feeds || await indexFeeds()).reduce((acc: any, feed) => {
  acc[feed.id!] = feed;
  return acc;
}, {});

async function getRawFeeds(): Promise<FeedType[]> {
  const feeds: FeedType[] = [];
  const feedsRaw = (await readFile(FEEDS_PATH, 'utf8')).trim().replaceAll('\r', '');
  for (const feedRaw of feedsRaw.split('\n\n')) {
    const parts = feedRaw.trim().split('\n');
    const props = parseIni(parts.slice(1).join('\n'));
    let url = parts[0];

    if (url.startsWith('#')) {
      continue;
    }
    if (!(url.toLowerCase().startsWith('http://') || url.toLowerCase().startsWith('https://'))) {
      url = 'https://' + url;
    }

    const feed: FeedType = { url, ...props };
    feeds.push(feed);
  }
  return feeds;
}

async function indexFeeds(): Promise<FeedType[]> {
  const feeds = await getRawFeeds();
  // const feeds: FeedType[] = [];
  // const feedsRaw = (await readFile('feeds.txt', 'utf8')).trim().replaceAll('\r', '');
  // for (const feedRaw of feedsRaw.split('\n\n')) {
  //   const parts = feedRaw.trim().split('\n');
  //   const props = parseIni(parts.slice(1).join('\n'));
  //   let url = parts[0];

  //   if (url.startsWith('#')) {
  //     continue;
  //   }
  //   if (!(url.toLowerCase().startsWith('http://') || url.toLowerCase().startsWith('https://'))) {
  //     url = 'https://' + url;
  //   }

  //   const feed: FeedType = { url, ...props };
  //   // if (feed.type === 'html' || feed.type) { // TODO remove after finish implementing
  //   //   continue;
  //   // }
  //   feeds.push(feed);

  //   // let dbFeed = await Feed.findOne({ where: { url } });
  //   // await Feed.upsert({ url });

  //   // if (!dbFeed) {
  //   //   dbFeed = await Feed.findOne({ where: { url } });
  //   //   updateFeed(dbFeed!);
  //   // }
  for (const feed of feeds) {
    const [dbFeed, created] = await createOrUpdate(Feed, { url: feed.url });
    if (created) {
      updateFeed(feed, dbFeed, true);
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
  // const parsed = await feedParser.parseURL(feed.url);
  // const response = await fetch(feed.url, { headers: {
  //   // ...(feed.user_agent && { 'User-Agent': feed.user_agent }),
  //   ...(feed.etag && { 'If-None-Match': feed.etag }),
  //   ...(feed.lastModified && { 'If-Modified-Since': new Date(feed.lastModified).toUTCString() }),
  // } });
  // if (response.ok) {
  //   const text = await response.text();
  try {
    const response = await axios.get(feed.url, { headers: {
      ...(feed.etag && { 'If-None-Match': feed.etag }),
      ...(feed.lastModified && { 'If-Modified-Since': new Date(feed.lastModified).toUTCString() }),
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
      etag: response.headers['etag'], // .get('etag'),
      lastModified: response.headers['last-modified'], // .get('last-modified'),
    });
    await storeFavicon(feed);
    return parsed;
  // } else {
  //   console.error(`Feed ${feed.url} not refreshed due to ${response.status} ${response.statusText}`);
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
        // await Entry.upsert(entry);
        // const [dbEntry, created] = await createOrUpdate(Entry, entry);
        // if (entry.link && (true || created || checkEntryChanged(entry, dbEntry))) {
        //   const request = await fetch(entry.link);
        //   if (request.ok) {
        //     await zip7.addOne(`media/${entry.feedId}/exthtml.7z`, dbEntry.id.toString(), await request.text(), { ms: '=on' });
        //   }
        // }
        let dbEntry = await Entry.findOne({ where: { guid } });
        if (entry.link && (!dbEntry || checkEntryChanged(entry, dbEntry))) {
          const request = await fetch(entry.link);
          if (request.ok) {
            entry.html = (await readerifyWebpage(entry.link)).content;
            // entry.extContent = cleanHtmlForStorage(await request.text());
            // storeEntryHtml(dbEntry, cleanHtmlForStorage(await request.text()));
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

// const storeEntryHtml = async (entry: Entry, html: string) => await zip7.addOne(`media/${entry.feedId}/exthtml.7z`, entry.id.toString(), html, { ms: '=on' });

// const checkDateValid = (date: Nullable<Date|string>) => date && !isNaN(new Date(date).getTime());

const checkDateValid = (date: Nullable<Date|string>): date is Date => date ? !isNaN(new Date(date).getTime()) : false;

// function checkDateValid(date: Nullable<Date|string>): date is Date {
//   return date ? !isNaN(new Date(date).getTime()) : false;
// }

function compareDates(a: Nullable<Date|string>, b: Nullable<Date|string>) {
  if (!a || !b) {
    throw new Error('Invalid date input');
  }
  const [timeA, timeB] = [new Date(a).getTime(), new Date(b).getTime()];
  if (isNaN(timeA) || isNaN(timeB)) {
    throw new Error('Invalid date input');
  }
  return timeA === timeB;
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
}

const updateFeedsTask = new AsyncTask(
  'update-feeds',
  async () => {
    // console.log('Updating feeds...');
    broadcastMessage('FEEDS_UPDATE_STARTED');
    for (const feed of await indexFeeds()) {
      broadcastMessage('FEEDS_UPDATE_RUNNING');
      try {
        await updateFeed(feed, (await Feed.findOne({ where: { url: feed.url } }))!, false);
      } catch(e) {
        console.error(e);
      }
    }
    broadcastMessage('FEEDS_UPDATE_FINISHED');
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
        await mkdir(/* `media/${entry.feedId}` */ dirname(mediaPath), { recursive: true });
        const fileStream = createWriteStream(mediaPath, { flags: 'w' });
        await finished(Readable.from((await response.blob()).stream()).pipe(fileStream));
        // await writeFile(`media/${entry.feedId}/${entry.id}${extname(entry.image)}`, await response.arrayBuffer());
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

async function findFeedBySlug(slug: string) {
  for (const feed of await indexFeeds()) {
    if (slugifyUrl(feed.url) === slug) {
      return await Feed.findOne({ where: { url: feed.url } });
    }
  }
}

app.ready().then(async () => {
  await sequelize.sync({
    // force: true,
    // alter: true,
  });

  const job = new SimpleIntervalJob({ minutes: 10 }, updateFeedsTask);
  job.executeAsync();
  app.scheduler.addSimpleIntervalJob(job);
});

// (async () => {
  // await sequelize.sync();
// })();

app.get('/', async (req: PaginatableSearchableRequest, reply) => {
  // const users = await User.findAll();
  const feeds = await getTemplateFeeds();
  const entries = await getViewEntries();
  // return reply.view('index.njk', { feeds, entries });
  return /*paginate*/resultize(req, reply, 'index.njk', 'entries', entries, { feeds });
});

app.get('/feed/:feed', async (req: FastifyRequest<{ Params: { feed: string }, Querystring: PaginatableSearchableRequest['query'] }>, reply) => {
  // let feed;
  // let url = /* decodeURIComponent */(req.params.feed);
  const feeds = await indexFeeds();
  for (const feed of feeds) {
    // if (feed.url !== url) {
    if (slugifyUrl(feed.url) !== req.params.feed) {
      continue;
    }

    const dbFeed = await Feed.findOne({ where: { url: feed.url } });
    if (!dbFeed) {
      continue;
    }

    const entries = await getViewEntries(dbFeed);
    // return reply.view('index.njk', { feed, feeds: { [dbFeed.id]: feed }, entries });
    return /*paginate*/resultize(req, reply, 'index.njk', 'entries', entries, { feed, feeds: await getTemplateFeeds() /* : { [dbFeed.id]: feed } */ });
  }
  // const feedUrls = (await indexFeeds()).map(feed => feed.url);
  // const url = req.params.feed;
  // if (feedUrls.includes(url)) {
  //   const dbFeed = await Feed.findOne({ where: { url } })!;
  //   const entries = await getViewEntries(dbFeed);
  //   return reply.view('home.njk', { feeds, entries });
  // }
  throw NotFoundError();
});

// app.get('/feed/:feed/atom', async (req: FastifyRequest<{ Params: { feed: string }, Querystring: PaginatableRequest['query'] }>, reply) => {
//   const feed = await findFeedBySlug(req.params.feed);
//   if (feed) {
//     return feed.url; // TODO
//   }
// });

app.get('/entry/:entry', async (req: FastifyRequest<{ Params: { entry: string }, Querystring: { 'external-html': string } }>, reply) => {
  // const feed = unslugifyObject(req.params.feed, await indexFeeds(), 'url');
  // if (feed) {
  //   const dbFeed = await Feed.findOne({ where: { url: feed.url } });
  //   if (!dbFeed) {
  //     return;
  //   }
  //   const entry = await unslugifyObject(req.params.entry, await getViewEntries(dbFeed), 'link');
  //   return reply.view('entry.njk', { feeds: { [dbFeed.id]: feed }, entry });
  // }
  const entry = unslugifyObject(req.params.entry, await getViewEntries(), 'link');
  if (entry) {
    // entry.extContent = (await readerifyWebpage(entry.link!)).content;
    // if (Prefs.ExternalHtml) {
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
    // if (extHtml) {
    //   entry.extContent &&= (await readerifyWebpage(entry.link!, entry.extContent)).content;
    // } else {
    //   entry.extContent = null;
    // }
    const feed = patchViewFeed((await Feed.findOne({ where: { id: entry.feedId } }))!);
    return reply.view('entry.njk', { feed, feeds: await getTemplateFeeds() /* : { [entry.feedId]: feed } */, entry, extHtml });
  }
});

if (Config.Development) {
  // app.post('/api/refresh/:feed', (req: FastifyRequest<{ Params: { feed: number } }>, reply) => {
  //   await updateFeed(feed, (await Feed.findOne({ where: { url: feed.url } }))!, false);
  // });
}

// app.get('/thumb/:thumb', async (req, reply) => {

// });

// app.get('/events', (req, reply) => {
//   reply.header('Content-Type', 'text/event-stream');
//   reply.header('Cache-Control', 'no-cache');
//   // reply.header('Connection', 'keep-alive');
//   reply.raw.flushHeaders();

//   // Send an initial ping to establish the stream
//   reply.raw.write(`data: ${JSON.stringify({ connected: true })}\n\n`);

//   // Example: send updates every 5 seconds
//   const interval = setInterval(() => {
//     reply.raw.write(`data: ${JSON.stringify({ updated: true })}\n\n`);
//   }, 5000);

//   // Clean up when client disconnects
//   req.raw.on('close', () => {
//     clearInterval(interval);
//   });
// });

// app.get('/ws', { websocket: true }, (socket, req) => {
//   console.log('Client connected');

//   console.log(socket)

//   // Handle incoming messages
//   socket.on('message', (message: any) => {
//     console.log('Received:', message);
//     socket.send('Echo: ' + message); // Send response back
//   });

//   // Handle disconnect
//   socket.on('close', () => {
//     console.log('Client disconnected');
//   });
// });

app.setNotFoundHandler((req, reply) => {
  reply
    .code(404)
    .header('X-Robots-Tag', 'noindex')
    .type('text/html')
    .send(makeErrorPage(404, 'Page Not Found'));
})
.setErrorHandler((err, req, reply) => {
  // return err;
  const code = err.statusCode || 500;
  reply
    .code(code)
    .header('X-Robots-Tag', 'noindex')
    .type('text/html')
    .send(makeErrorPage(code, err.message));
  if (code !== 404) {
    console.error(err);
  }
})
.listen({ port: Config.Http.Port, host: Config.Http.Host }, () => {
  console.log('Server running at http://localhost:3000');
});
