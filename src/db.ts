import { Model, ModelStatic, Sequelize, WhereOptions } from 'sequelize';

import { Config } from './prefs';
import { PATHS } from './data';
import { MakeNullishOptional } from 'sequelize/types/utils';

export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: PATHS.SQLITE,
  logging: Config.Development,
});

export type MakeOptional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export async function createOrUpdate<T extends Model>(
  model: ModelStatic<T>,
  data: MakeNullishOptional<T['_creationAttributes']>,
): Promise<[T, boolean]> {
  // Detect primary or unique keys
  const keys = Object.entries(model.getAttributes())
    .filter(([_, attr]) => attr.primaryKey || attr.unique)
    .map(([key]) => key);

  if (keys.length === 0) {
    throw new Error(`Model ${model.name} has no primary or unique key defined.`);
  }

  // Build the WHERE clause from the key fields
  const where: WhereOptions<T["_creationAttributes"]> = {};
  for (const key of keys) {
    if (data[key as keyof typeof data] !== undefined) {
      where[key as keyof typeof where] = data[key as keyof typeof data];
    }
  }

  let created = false;
  let record = await model.findOne({ where });

  if (!record) {
    record = await model.create(data);
    created = true;
  } else {
    record = await record.update(data);
  }

  return [record, created];
}