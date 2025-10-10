import { FeedType } from "./models/feed";
import { JSDOM } from 'jsdom';
import { debugStringHash, Nullable } from "./util";
import { parse as parseJsToXml } from 'js2xmlparser';
import { log, LogLevel } from ".";

const QUERY_SEPARATOR = ',';

type CssValueQuery = {
  text?: boolean;
  html?: 'inner'|'outer'|null;
  attr?: string|null;
}
type CssParsedQuery = CssValueQuery & {
  namespace: string|null,
  filters: (string|CssOperation)[];
  ops: CssOperation[],
};
type CssOperation = [string, ...CssOperationArgs];
type CssOperationArgs = (string|number)[];

export function parseHtmlFeed(html: string, feed: FeedType, allowInvalid: boolean = false) {
  const doc = new JSDOM(html, { url: feed.url }).window.document.documentElement;
  const items: any[] = [];
  const namespaces: Record<string, HTMLElement> = {};
  if (feed.css_namespace) {
    const [name, ...parts] = feed.css_namespace.split(' ');
    namespaces[name] = runCssQuery(doc, parts.join(' ')) as HTMLElement;
  }
  log(LogLevel.DEBUG, 'Created namespaces for HTML parsing:', namespaces);
  if (allowInvalid || (feed.css_entries && feed.css_entry_link)) {
    for (const el of runCssQuery(doc, feed.css_entries, namespaces, null, true) as HTMLElement[]) {
      log(LogLevel.DEBUG, 'Parsing entry:', debugStringHash(el.outerHTML));
      const link = runCssQuery(el, feed.css_entry_link, namespaces, [{ attr: 'href' }]);
      const published = runCssQuery(el, feed.css_entry_published, namespaces) as string;
      if (allowInvalid || link) {
        items.push({
          guid: link,
          link,
          title: runCssQuery(el, feed.css_entry_title, namespaces, [{ text: true }]),
          summary: runCssQuery(el, feed.css_entry_summary, namespaces, [{ text: true }]),
          content: runCssQuery(el, feed.css_entry_content, namespaces, [{ html: 'inner' }]),
          published: published && new Date((published && Number(published)) || published),
          author: runCssQuery(el, feed.css_entry_author, namespaces, [{ text: true }]),
          image: runCssQuery(el, feed.css_entry_image, namespaces, [{ attr: 'src' }]),
          video: runCssQuery(el, feed.css_entry_video, namespaces, [{ attr: 'src' }]),
        });
      }
    }
  }
  return {
    title: runCssQuery(doc, feed.css_name, namespaces, [{ text: true }]) as string,
    description: runCssQuery(doc, feed.css_description, namespaces, [{ text: true }]) as string,
    items,
  };
}

function parseCssQuery(raw: string): CssParsedQuery[] {
  const res: CssParsedQuery[] = [{ namespace: null, filters: [''], text: false, html: null, attr: null, ops: [] }];
  let iRes = 0; // res.length - 1;
  let inString: string|false = false;
  let toSlice: string|null = null;
  if (raw.startsWith('@')) {
    res[0].namespace = raw.replace('>', ' ').split(' ')[0].slice(1);
    raw = raw.slice(res[0].namespace.length + 1);
  }
  while (raw) {
    const c = raw[0];
    if (!inString) {
      // TODO: splitting of function's inner values should account for strings that contain ")" characters
      if (c === '"' || c === "'") {
        inString = c;
      } else if (c === QUERY_SEPARATOR) {
        res.push({ namespace: null, filters: [''], text: false, html: null, attr: null, ops: [] });
        iRes++;
        toSlice = QUERY_SEPARATOR;
      } else if (raw.startsWith(':contains(')) {
        const inner = raw.split('(')[1].split(')')[0];
        res[iRes].filters.push(['contains', ...parseOperationArgs(inner)]);
        toSlice = ':contains()' + inner;
      } else if (raw.startsWith('::text')) {
        res[iRes].text = true;
        toSlice = '::text';
      } else if (raw.startsWith('::inner-html')) {
        res[iRes].html = 'inner';
        toSlice = '::inner-html';
      } else if (raw.startsWith('::outer-html')) {
        res[iRes].html = 'outer';
        toSlice = '::outer-html';
      } else if (raw.startsWith('::attr(')) {
        res[iRes].attr = raw.split('(')[1].split(')')[0];
        toSlice = '::attr()' + res[iRes].attr;
      } else if (raw.startsWith('/@json-load()')) {
        res[iRes].ops.push(['json-load']);
        toSlice = '/@json-load()';
      } else if (raw.startsWith('/@')) {
        const name = raw.split('(')[0].split('@')[1];
        if (name) {
          const inner = raw.split('(')[1].split(')')[0];
          res[iRes].ops.push([name, ...parseOperationArgs(inner)]);
          toSlice = '/@()' + name + inner;
        }
      }
    } else if (c === inString) {
      inString = false;
    }
    if (!toSlice) {
      if (typeof res[iRes].filters[res[iRes].filters.length - 1] !== 'string') {
        res[iRes].filters.push('');
      }
      res[iRes].filters[res[iRes].filters.length - 1] += c;
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

const jsonToDom = (json: string): HTMLElement|null => new JSDOM(parseJsToXml('root', JSON.parse(json)), { contentType: "text/xml" }).window.document.documentElement;

function runCssQuery(
  node: HTMLElement,
  query: Nullable<CssParsedQuery[] | string>,
  namespaces?: Record<string, HTMLElement>,
  valueFallbacks?: CssValueQuery[]|null,
  multiple?: false,
): HTMLElement|string|null;

function runCssQuery(
  node: HTMLElement,
  query: Nullable<CssParsedQuery[] | string>,
  namespaces?: Record<string, HTMLElement>,
  valueFallbacks?: CssValueQuery[]|null,
  multiple?: true,
): HTMLElement[];

function runCssQuery(
  node: HTMLElement,
  queries: Nullable<CssParsedQuery[]|string>,
  namespaces: Record<string, HTMLElement> = {},
  valueFallbacks?: CssValueQuery[]|null,
  multiple: boolean = false,
): HTMLElement[]|HTMLElement|string|null {
  let lastEls: HTMLElement[] = [];
  let res: HTMLElement|string|string[]|null = null;
  if (typeof queries === 'string') {
    queries = parseCssQuery(queries);
  }
  for (const query of queries || []) {
    if (res) {
      break;
    }
    log(LogLevel.DEBUG, 'Running CSS query:', query);
    if (query) {
      for (const filter of query.filters) {
        if (typeof filter === 'string') {
          const el = query.namespace ? namespaces[query.namespace] : (lastEls[0] || node);
          log(LogLevel.DEBUG, `Running CSS filter: ${filter}, on: ${debugStringHash(el?.outerHTML)}`);
          lastEls = el ? Array.from(el.querySelectorAll(`:scope ${filter}`)) : [];
          log(LogLevel.DEBUG, `Found ${lastEls.length} elements`);
        } else {
          const [op, ...args] = filter;
          log(LogLevel.DEBUG, 'Running CSS operation:', op);
          switch (op) {
            case 'contains':
              const els: HTMLElement[] = [];
              for (const el of lastEls) {
                if (el.textContent.search(args[0] as string) > -1) {
                  els.push(el);
                }
              }
              log(LogLevel.DEBUG, `Found ${els.length} elements`);
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
        log(LogLevel.DEBUG, 'Acting on element:', debugStringHash(el.outerHTML));
        let handled;
        [res, handled] = getCssValue(query, el);
        if (!handled && valueFallbacks) {
          for (const fallback of valueFallbacks) {
            [res] = getCssValue(fallback, el);
            if (res) {
              break;
            }
          }
        }
        log(LogLevel.DEBUG, 'Result data is:', res);
        if (res && typeof res === 'string') {
          for (const [op, ...args] of query.ops) {
            log(LogLevel.DEBUG, 'Running CSS operation:', op);
            // TODO: proper type checks
            switch (op) {
              case 'append':
                res += args[0].toString();
                break;
              case 'prepend':
                res = args[0].toString() + res;
                break;
              case 'split':
                res = (res as string).split(args[0].toString());
                break;
              case 'join':
                res = (res as string[]).join(args[0].toString());
                break;
              case 'slice':
                res = (res as string[]).slice(args[0] as number, args[1] as number);
                break;
              case 'get':
                res = (res as string[]).slice(args[0] as number)[0];
                break;
              /* case 'map':
                res = (res as string[]).map(item => {
                  switch (args[0]) {
                    case 'lowercase':
                      return item.toLowerCase();
                    case 'uppercase':
                      return item.toUpperCase();
                  }
                  return item;
                });
                break; */
              case 'filter':
                res = (res as string[]).filter(item => {
                  switch (args[0]) {
                    case 'starts-with':
                      return item.startsWith(args[1].toString());
                    case 'ends-with':
                      return item.endsWith(args[1].toString());
                  }
                  return null;
                });
                break;
              case 'json-load':
                res = jsonToDom(res as string);
                break;
            }
          }
        }
      }
    }
  }
  const out = multiple ? [] : (res !== undefined && !Array.isArray(res) ? res : null);
  log(LogLevel.DEBUG, 'Output is:', out);
  return out;
}

function getCssValue(query: CssValueQuery, el: HTMLElement): [string|null|HTMLElement, boolean] {
  let value: string|null = null;
  let handled = false;
  if (query.text) {
    const temp = el.cloneNode() as HTMLElement;
    temp.innerHTML = el.innerHTML;
    temp.querySelectorAll('br').forEach(el => el.outerHTML = '\n');
    value = temp.textContent;
    handled = true;
  } else if (query.html === 'inner') {
    value = el.innerHTML;
    handled = true;
  } else if (query.html === 'outer') {
    value = el.outerHTML;
    handled = true;
  } else if (query.attr) {
    const attr = query.attr;
    if (attr !== 'style') {
      (el as any)[attr] = (el as any)[attr]; // force rewrite attributes when useful, eg. for URLs
      // for some reason styles are emptied if doing this, so we skip it just for them
    }
    value = el.getAttribute(attr);
    handled = true;
  }
  return [value, handled];
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