import { FeedType } from "./db";
import { JSDOM } from 'jsdom';
import { debugStringHash, Nullable } from "./util";
import { parse as parseJsToXml } from 'js2xmlparser';
import { log, LogLevels } from ".";
import { createHash } from "crypto";

type CssParsedQuery = {
  namespace: string|null,
  filters: (string|CssOperation)[];
  text: boolean;
  html: 'inner'|'outer'|null;
  attr: string|null;
  ops: CssOperation[],
};
type CssOperation = [string, ...CssOperationArgs];
type CssOperationArgs = (string|number)[];

export function parseHtmlFeed(html: string, feed: FeedType) {
  const doc = new JSDOM(html, { url: feed.url }).window.document.documentElement;
  const items: any[] = [];
  const namespaces: Record<string, Element> = {};
  if (feed.css_namespace) {
    const [name, ...parts] = feed.css_namespace.split(' ');
    namespaces[name] = runCssQuery(doc, parts.join(' ')) as Element;
  }
  log(LogLevels.DEBUG, 'Created namespaces for HTML parsing:', namespaces);
  if (feed.css_entries && feed.css_entry_link) {
    for (const el of runCssQuery(doc, feed.css_entries, namespaces, true) as Element[]) {
      log(LogLevels.DEBUG, 'Parsing entry:', debugStringHash(el.outerHTML));
      const link = runCssQuery(el, feed.css_entry_link, namespaces);
      const published = runCssQuery(el, feed.css_entry_published, namespaces) as string;
      if (link) {
        items.push({
          guid: link,
          link,
          title: runCssQuery(el, feed.css_entry_title, namespaces),
          summary: runCssQuery(el, feed.css_entry_summary, namespaces),
          published: published && new Date((published && parseInt(published)) || published),
          image: runCssQuery(el, feed.css_entry_image, namespaces),
        });
      }
    }
  }
  return {
    title: runCssQuery(doc, feed.css_name, namespaces) as string,
    description: runCssQuery(doc, feed.css_description, namespaces) as string,
    items,
  };
}

function parseCssQuery(raw: string): CssParsedQuery {
  const res: CssParsedQuery = { namespace: null, filters: [''], text: false, html: null, attr: null, ops: [] };
  let inString: string|false = false;
  let toSlice: string|null = null;
  if (raw.startsWith('@')) {
    res.namespace = raw.replace('>', ' ').split(' ')[0].slice(1);
    raw = raw.slice(res.namespace.length + 1);
  }
  while (raw) {
    const c = raw[0];
    if (!inString) {
      // TODO: splitting of function's inner values should account for strings that contain ")" characters
      if (c === '"' || c === "'") {
        inString = c;
      } else if (raw.startsWith(':contains(')) {
        const inner = raw.split('(')[1].split(')')[0];
        res.filters.push(['contains', ...parseOperationArgs(inner)]);
        toSlice = ':contains()' + inner;
      } else if (raw.startsWith('::text')) {
        res.text = true;
        toSlice = '::text';
      } else if (raw.startsWith('::inner-html')) {
        res.html = 'inner';
        toSlice = '::inner-html';
      } else if (raw.startsWith('::outer-html')) {
        res.html = 'outer';
        toSlice = '::outer-html';
      } else if (raw.startsWith('::attr(')) {
        res.attr = raw.split('(')[1].split(')')[0];
        toSlice = '::attr()' + res.attr;
      } else if (raw.startsWith('/@append(')) {
        const inner = raw.split('(')[1].split(')')[0];
        res.ops.push(['append', ...parseOperationArgs(inner)]);
        toSlice = '/@append()' + inner;
      } else if (raw.startsWith('/@prepend(')) {
        const inner = raw.split('(')[1].split(')')[0];
        res.ops.push(['prepend', ...parseOperationArgs(inner)]);
        toSlice = '/@prepend()' + inner;
      } else if (raw.startsWith('/@json-load()')) {
        res.ops.push(['json-load']);
        toSlice = '/@json-load()';
      }
    } else if (c === inString) {
      inString = false;
    }
    if (!toSlice) {
      if (typeof res.filters[res.filters.length - 1] !== 'string') {
        res.filters.push('');
      }
      res.filters[res.filters.length - 1] += c;
    }
    raw = raw.slice(toSlice ? toSlice.length : 1);
    toSlice = null;
  }
  return res;
}

function parseOperationArgs(inner: string): CssOperationArgs {
  const args: CssOperationArgs = [];
  for (let raw of inner.split(',')) {
    raw = raw.trim();
    if (/^'(.*)'$/.test(raw)) {
      const inner = raw.slice(1, -1).replace(/\\'/g, "'"); // unescape inner apostrophes
      args.push(JSON.parse(`"${inner}"`));
    } else {
      args.push(JSON.parse(raw));
    }
  }
  return args;
}

function prepareObjectToXml(obj: object): object {
  if (Array.isArray(obj)) {
    return obj.map(item /* (item, index) */ => ({ ['aggregodo-xml-json-array-item' /* `item${index}` */]: prepareObjectToXml(item) }));
  } else if (typeof obj === 'object' && obj !== null) {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const safeKey = /^[0-9]/.test(key) ? `key${key}` : key;
      result[safeKey] = prepareObjectToXml(value);
    }
    return result;
  }
  return obj;
}

const jsonToDom = (json: string): Element|null => new JSDOM(parseJsToXml('root', /*prepareObjectToXml*/(JSON.parse(json))), { contentType: "text/xml" }).window.document.documentElement;//.querySelector('root');

function runCssQuery(
  node: Element,
  query: Nullable<CssParsedQuery | string>,
  namespaces?: Record<string, Element>,
  multiple?: false,
): Element|string|null;

function runCssQuery(
  node: Element,
  query: Nullable<CssParsedQuery | string>,
  namespaces?: Record<string, Element>,
  multiple?: true,
): Array<Element|string|null>;

function runCssQuery(
  node: Element,
  query: Nullable<CssParsedQuery|string>,
  namespaces: Record<string, Element> = {},
  multiple: boolean = false,
): Element|string|null|Array<Element|string|null> {
  let lastEls: Element[] = [];
  let res: Element|string|null = null;
  if (typeof query === 'string') {
    query = parseCssQuery(query);
  }
  log(LogLevels.DEBUG, 'Running CSS query:', query);
  if (query) {
    for (const filter of query.filters) {
      if (typeof filter === 'string') {
        const el = query.namespace ? namespaces[query.namespace] : (lastEls[0] || node);
        // log(LogLevels.DEBUG, `lastEls: ${lastEls.length}, lastEls[0]: ${lastEls[0]}, node: ${node ? debugStringHash(node.outerHTML): 'null'}`);
        log(LogLevels.DEBUG, `Running CSS filter: ${filter}, on: ${debugStringHash(el?.outerHTML)}`);
        lastEls = el ? Array.from(el.querySelectorAll(`:scope ${filter}`)) : [];
        log(LogLevels.DEBUG, `Found ${lastEls.length} elements`);
      } else {
        const [op, ...args] = filter;
        log(LogLevels.DEBUG, 'Running CSS operation:', op);
        switch (op) {
          case 'contains':
            const els: Element[] = [];
            for (const el of lastEls) {
              if (el.textContent.search(args[0] as string) > -1) {
                els.push(el);
              }
            }
            log(LogLevels.DEBUG, `Found ${els.length} elements`);
            lastEls = els;
            break;
        }
      }
    }
    if (multiple) {
      return lastEls;
    }
    const el = lastEls[0];
    if (el) {
      log(LogLevels.DEBUG, 'Acting on element:', debugStringHash(el.outerHTML));
      if (query.text) {
        res = el.textContent;
      } else if (query.html === 'inner') {
        res = el.innerHTML;
      } else if (query.html === 'outer') {
        res = el.outerHTML;
      } else if (query.attr) {
        const attr = query.attr;
        (el as any)[attr] = (el as any)[attr]; // force rewrite attributes when useful, eg. for URLs
        res = el.getAttribute(attr);
      }
      log(LogLevels.DEBUG, 'Result data is:', res);
      if (res && typeof res === 'string') {
        for (const [op, ...args] of query.ops) {
          log(LogLevels.DEBUG, 'Running CSS operation:', op);
          switch (op) {
            case 'append':
              res += args[0].toString();
              break;
            case 'prepend':
              res = args[0].toString() + res;
              break;
            case 'json-load':
              res = jsonToDom(res as string);
              break;
          }
        }
      }
    }
  }
  const out = multiple ? [] : res;
  log(LogLevels.DEBUG, 'Output is:', out);
  return out;
}

// function getWhitespaced(raw: string, ...values: string[]): number|null {
//   let count = 0;
//   for (const value of values) {
//     const sub = raw.trim();
//     count += raw.length - sub.length;
//     if (sub.startsWith(value)) {
//       raw = sub.slice(value.length);
//       count += value.length;
//     } else {
//       return null;
//     }
//   }
//   return count;
// }