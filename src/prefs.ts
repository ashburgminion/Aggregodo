export const Config = {
  Development: true,
  Http: {
    Port: 3000,
    Host: "0.0.0.0",
  },
  AppName: "Aggregodo",
};

type PrefsType = {
  ReaderMode: boolean,
  ExternalHtml: boolean,
  ResultLimit: number,
  DefaultView: 'grid'|'list',
};

export const Prefs: PrefsType = {
  ReaderMode: true,
  ExternalHtml: true,
  ResultLimit: 30,
  DefaultView: "grid",
};