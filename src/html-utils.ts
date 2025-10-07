import Defuddle from 'defuddle';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import * as cheerio from 'cheerio';
import { Config } from './prefs';

export function sanitizeHtml(html: string) {
  return DOMPurify(new JSDOM().window).sanitize(html, { ADD_TAGS: ['iframe'] });
}

export async function readerifyWebpage(url: string, html?: string) {
  const doc = (html ? new JSDOM(html, { url }) : await JSDOM.fromURL(url)).window.document;
  doc.querySelectorAll('a[href]').forEach(el => (el as HTMLAnchorElement).href = (el as HTMLAnchorElement).href);
  doc.querySelectorAll('img[src], video[src], audio[src], iframe[src]').forEach(el => (el as HTMLSourceElement).src = (el as HTMLSourceElement).src);
  const article = new Defuddle(doc, { debug: Config.Development }).parse();
  article.content = sanitizeHtml(article.content);
  return article;
}

export function patchReaderContent(html: string): string {
  const $ = cheerio.load(html);
  $('a[href]').each((_i, el) => {
    $(el).attr('target', '_blank');
    $(el).attr('rel', 'nofollow noopener');
  });
  return $.html();
}

export function getMediaFromHtml(html: string, type: string): string|null {
  const $ = cheerio.load(html);
  const media = $(type === 'image' ? 'img' : type).map((_i, el) => $(el).attr('src')).get();
  if (media.length > 0) {
    return media[0];
  }
  return null;
}