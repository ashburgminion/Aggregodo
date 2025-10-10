import { Attributes, Model, InferAttributes, InferCreationAttributes, CreationOptional, DataTypes } from "sequelize";
import { sequelize, MakeOptional } from "../db";
import { Feed } from "./feed";

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
  // declare updated?: Date|string|null;
  // declare relUpdated?: string|null;
  // declare isoUpdated?: string|null;
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