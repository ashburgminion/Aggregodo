import { Attributes, Model, InferAttributes, InferCreationAttributes, CreationOptional, DataTypes } from "sequelize";
import { sequelize, MakeOptional } from "../db";

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