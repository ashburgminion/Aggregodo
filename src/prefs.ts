import { readFileSync } from "fs";
import { parseBool, prepareFilesystem } from "./util";
import { PATHS } from "./data";
import { parseIni } from "./ini-support";

export const Config = (() => {
  prepareFilesystem();
  const base = parseIni(readFileSync(PATHS.TEMPLATE_CONFIG, 'utf8')) as Record<string, string>;
  const user = parseIni(readFileSync(PATHS.CONFIG, 'utf8')) as Record<string, string>;
  const httpPort = parseInt(user.HTTP_Port);
  const updateInterval = parseInt(user.Update_Interval);
  return {
    Development: parseBool(user.Development) ?? parseBool(base.Development) ?? false,
    LogFile: user.Log_File || base.Log_File,
    Http: {
      Port: !isNaN(httpPort) ? httpPort : parseInt(base.HTTP_Port),
      Host: user.HTTP_Host || base.HTTP_Host,
    },
    LinksPrefix: user.Links_Prefix,
    AppName: user.App_Name || "Aggregodo",
    UpdateInterval: !isNaN(updateInterval) ? updateInterval : parseInt(base.Update_Interval),
  };
})();

type PrefsType = {
  ReaderMode: boolean,
  ExternalHtml: boolean,
  ResultLimit: number,
  DefaultView: 'grid'|'list'|'flow',
};

export const Prefs: PrefsType = {
  ReaderMode: false,
  ExternalHtml: true,
  ResultLimit: 30,
  DefaultView: "grid",
};