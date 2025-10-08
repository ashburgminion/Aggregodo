class IniError extends Error {}

// TODO: support logging errors and returning them, without throwing?
export function parseIni(ini: string, strict: boolean = false): Record<string, string|Record<string, string>> {
  const main: Record<string, string> = {};
  const extra: Record<string, Record<string, string>> = {};
  let section = null;
  let lineIndex = 0;
  let key: string|null = null;
  let value: string|null = null;
  for (const line of ini.split(/\r?\n/)) {
    lineIndex++;
    if (line == line.trimStart()) {
      // no indentation: new property
      if (key && value) {
        // save accumulated property before a new one
        (section ? extra[section] : main)[key] = value;
        key = value = null;
      }
      if ([';', '#'].includes(line[0])) {
        // line is a comment, do nothing
      } else if (line[0] === '[' && line.trimEnd().slice(-1)[0] === ']') {
        // line is a section, (re?)create it
        section = line.trimEnd().slice(1, -1).trim();
        if (section) {
          extra[section] = {};
        } else if (strict) {
          throw new IniError('Declared section with no name @ line' + lineIndex);
        }
      } else {
        // line is a property, parse it
        let parts = line.split('=');
        key = parts[0].trim();
        value = parts.slice(1).join('=').trim();
      }
    } else {
      // indented: continue multiline property if exists
      if (key && value) {
        value = value + '\n' + line.trim();
      } else if (strict) {
        throw new IniError('Indented line follows no property @ line' + lineIndex);
      }
    }
  }
  if (key && value) {
    // save accumulated property before ending
    (section ? extra[section] : main)[key] = value;
  }
  return { ...main, ...extra }; // [main, extra];
}

// export function castParsedIni<T>(ini: any, schema: T) {}

// export function parseIniTyped(ini: string, strict: boolean) {}

// export function dumpIni(data: any, reference: string) {}

export function dumpIni(data: Record<string, string|Record<string, string>>): string {
  // TODO: sort unsectioned props to be handled before sections
  // TODO: handle multiline values properly
  let out = '';
  for (const key in data) {
    const value = data[key];
    if (typeof value === 'object') {
      out += `\n[${key}]\n`
      for (const key in value) {
        out += `${key} = ${value[key]}\n`;
      }
    } else {
      out += `${key} = ${value}\n`;
    }
  }
  return out;
}