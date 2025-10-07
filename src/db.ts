import { CreationOptional, Sequelize } from 'sequelize';
import { DataTypes, Model, InferAttributes, InferCreationAttributes, Attributes } from 'sequelize';
import { Config } from './prefs';
import { PATHS } from './data';

export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: PATHS.SQLITE,
  logging: Config.Development,
});

type MakeOptional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export type FeedType = MakeOptional<Attributes<Feed>, 'id'>;

export class Feed extends Model<InferAttributes<Feed>, InferCreationAttributes<Feed>> {
  declare id: CreationOptional<number>;
  declare url: string;
  declare name?: string|null;
  declare description?: string|null;
  declare icon?: string|null;
  declare etag?: string|null;
  declare lastModified?: Date|string|null;
  declare lastStatus?: string|null;
  // declare cache_images?: boolean;
  declare status?: 'hidden'|'disabled'|null;
  declare type?: string|null;
  // declare user_agent?: string|null;
  declare http_headers?: string|null;
  declare fake_browser?: boolean;
  declare css_namespace?: string|null;
  declare css_name?: string|null;
  declare css_description?: string|null;
  declare css_entries?: string|null;
  declare css_entry_link?: string|null;
  declare css_entry_image?: string|null;
  declare css_entry_video?: string|null;
  declare css_entry_title?: string|null;
  declare css_entry_summary?: string|null;
  declare css_entry_content?: string|null;
  declare css_entry_published?: string|null;
  declare css_entry_author?: string|null;
  declare profile?: string|null;
}

Feed.init(
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    url: {
      type: DataTypes.TEXT,
      allowNull: false,
      unique: true,
    },
    name: DataTypes.TEXT,
    description: DataTypes.TEXT,
    etag: DataTypes.TEXT,
    lastModified: DataTypes.DATE,
    lastStatus: DataTypes.TEXT,
  },
  { sequelize }
);

export type EntryType = MakeOptional<Attributes<Entry>, 'id'>;

export class Entry extends Model<InferAttributes<Entry>, InferCreationAttributes<Entry>> {
  declare id: CreationOptional<number>;
  declare guid: string;
  declare link?: string|null;
  declare title?: string|null;
  declare summary?: string|null;
  declare content?: string|null;
  declare html?: string|null;
  declare image?: string|null;
  declare video?: string|null;
  declare embed?: string|null;
  declare author?: string|null;
  declare published?: Date|string|null;
  declare relPublished?: string|null;
  declare isoPublished?: string|null;
  // declare present?: boolean|null;
  declare feedId: number;
}

Entry.init(
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    guid: {
      type: DataTypes.TEXT,
      allowNull: false,
      unique: true,
    },
    link: DataTypes.TEXT,
    title: DataTypes.TEXT,
    summary: DataTypes.TEXT,
    content: DataTypes.TEXT,
    html: DataTypes.TEXT,
    image: DataTypes.TEXT,
    video: DataTypes.TEXT,
    author: DataTypes.TEXT,
    published: {
      type: DataTypes.DATE,
      set(value: any) {
        if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}T/)) {
          this.setDataValue('published', new Date(value)); // auto-convert only if it's a valid ISO string
        } else {
          this.setDataValue('published', value); // leave it as-is
        }
      }
    },
    // present: DataTypes.BOOLEAN,
    feedId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      references: {
        model: Feed,
        key: 'id',
      },
    },
  },
  { sequelize }
);

Feed.hasMany(Entry, { foreignKey: 'feedId' });
Entry.belongsTo(Feed, { foreignKey: 'feedId' });