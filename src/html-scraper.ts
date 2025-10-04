import { Feed, FeedType } from "./db";
import { JSDOM } from 'jsdom';
import { Nullable } from "./util";

type CssParsedQuery = {
  query: string;
  text: boolean;
  html: 'inner'|'outer'|null;
  attr: string|null;
  ops: CssOperation[], // string[][],
};
type CssOperation = [string, ...CssOperationArgs];
type CssOperationArgs = (string|number)[];

export function parseHtmlFeed(html: string, feed: FeedType) {
  const doc = new JSDOM(html, { url: feed.url }).window.document;
  const items: any[] = [];
  if (feed.css_entries && feed.css_entry_link) {
    // const query = parseCssQuery(feed.css_entries);
    for (const el of doc.querySelectorAll(feed.css_entries /* query.query */)) {
      const link = runCssQuery(el, feed.css_entry_link);
      const published = runCssQuery(el, feed.css_entry_published);
      const publishedInt = published && parseInt(published);
      if (link) {
        items.push({
          guid: link,
          link,
          title: runCssQuery(el, feed.css_entry_title),
          summary: runCssQuery(el, feed.css_entry_summary),
          published: published && new Date(publishedInt || published),
          image: runCssQuery(el, feed.css_entry_image),
        });
      }
    }
  }
  return {
    title: runCssQuery(doc, feed.css_name),
    description: null,
    items,
  };
}

function parseCssQuery(raw: string): CssParsedQuery {
  // const length = raw.length;
  const res: CssParsedQuery = { query: '', text: false, html: null, attr: null, ops: [] };
  let inString: string|false = false;
  let toSlice: string|null = null;
  // for (let i=0; i<length; i++) {
  while (raw) {
    const c = raw[0]; // raw[i];
    if (!inString) {
      if (c === '"' || c === "'") {
        inString = c;
      } else if (raw.startsWith('::text')) {
        res.text = true;
        toSlice = '::text';
        // return res;
      } else if (raw.startsWith('::inner-html')) {
        res.html = 'inner';
        toSlice = '::inner-html';
        // return res;
      } else if (raw.startsWith('::outer-html')) {
        res.html = 'outer';
        toSlice = '::outer-html';
        // return res;
      } else if (raw.startsWith('::attr(')) {
        res.attr = raw.split('(')[1].split(')')[0];
        toSlice = '::attr()' + res.attr;
        // return res;
      } else if (raw.startsWith('/@append(')) {
        const name = raw.split('@')[1].split('(')[0];
        const inner = raw.split('(')[1].split(')')[0];
        // const args = inner.split(',');
        const pargs: CssOperationArgs = [];
        // for (let i=0; i<args.length; i++) {
          // args[i] = JSON.parse(args[i]);
          // pargs.push(JSON.parse(args[i].replace().replace()));
        // }
        for (let raw of inner.split(',')) {
          raw = raw.trim();
          if (/^'(.*)'$/.test(raw)) {
            const inner = raw.slice(1, -1).replace(/\\'/g, "'"); // unescape inner apostrophes
            pargs.push(JSON.parse(`"${inner}"`));
          } else {
            pargs.push(JSON.parse(raw));
          }
        }
        res.ops.push([name, ...pargs]);
        toSlice = '/@append()' + name + inner;
      }
    } else if (c === inString) {
      inString = false;
    }
    if (!toSlice) {
      res.query += c;
    }
    raw = raw.slice(toSlice ? toSlice.length : 1);
    toSlice = null;
  }
  // res.text = true;
  return res;
}

function runCssQuery(node: Element|Document, query: Nullable<CssParsedQuery|string>): string|null {
  let val = null;
  if (typeof query === 'string') {
    query = parseCssQuery(query);
  }
  if (query) {
    // const el = node.querySelector(query.query);
    const el = !query.query && node instanceof Element ? node : node.querySelector(query.query);
    if (el) {
      if (query.text) {
        val = el.textContent;
      } else if (query.html === 'inner') {
        val = el.innerHTML;
      } else if (query.html === 'outer') {
        val = el.outerHTML;
      } else if (query.attr) {
        const attr = query.attr;
        (el as any)[attr] = (el as any)[attr]; // force rewrite attributes when useful, eg. for URLs
        val = el.getAttribute(attr);
      }
      if (val) {
        for (const [op, ...args] of query.ops) {
          switch (op) {
            case 'append':
              val += args[0];
              break;
          }
        }
      }
    }
  }
  return val;
}

// function getWhitespaced(raw: string, ...values: string[]) {

// }