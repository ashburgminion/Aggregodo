import { readFileSync } from "fs";
import { CONFIG_PATH, parseBool, parseIni, prepareFilesystem, TEMPLATE_CONFIG_PATH } from "./util";

export const Config = (() => {
  prepareFilesystem();
  const base = parseIni(readFileSync(TEMPLATE_CONFIG_PATH, 'utf8')) as Record<string, string>;
  const user = parseIni(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, string>;
  const httpPort = parseInt(user.HTTP_Port);
  const updateInterval = parseInt(user.Update_Interval);
  return {
    Development: parseBool(user.Development) ?? parseBool(base.Development) ?? false,
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