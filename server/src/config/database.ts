import mongoose from 'mongoose';
import { config } from './index.js';
import { logger } from './logger.js';

export async function connectDatabase() {
  try {
    await mongoose.connect(config.mongoUri);
    await ensureTelemetryKeyHashIndex();
    logger.info('MongoDB connected');
  } catch (err) {
    logger.error({ err }, 'MongoDB connection failed');
    throw err;
  }
}

async function ensureTelemetryKeyHashIndex() {
  const users = mongoose.connection.collection('users');
  let indexes;
  try {
    indexes = await users.indexes();
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 26) throw error;

    await users.createIndex(
      { telemetryKeyHash: 1 },
      {
        name: 'telemetry_key_hash_unique',
        unique: true,
        partialFilterExpression: { telemetryKeyHash: { $type: 'string' } },
      },
    );
    return;
  }
  const telemetryIndexes = indexes.filter(
    (index) => Object.keys(index.key).length === 1 && index.key.telemetryKeyHash === 1,
  );
  const validIndex = telemetryIndexes.find(
    (index) =>
      index.unique === true &&
      index.partialFilterExpression?.telemetryKeyHash?.$type === 'string',
  );
  if (validIndex) {
    for (const index of telemetryIndexes) {
      if (index.name && index.name !== validIndex.name) await users.dropIndex(index.name);
    }
    return;
  }

  const duplicateHash = await users
    .aggregate([
      { $match: { telemetryKeyHash: { $type: 'string' } } },
      { $group: { _id: '$telemetryKeyHash', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ])
    .hasNext();
  if (duplicateHash) {
    throw new Error('Cannot create the telemetry key index because duplicate key hashes exist.');
  }

  try {
    await users.createIndex(
      { telemetryKeyHash: 1 },
      {
        name: 'telemetry_key_hash_unique',
        unique: true,
        partialFilterExpression: { telemetryKeyHash: { $type: 'string' } },
      },
    );
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 85 && code !== 86) throw error;

    for (const index of telemetryIndexes) {
      if (!index.name) throw new Error('Cannot safely replace an unnamed telemetry key index.');
      await users.dropIndex(index.name);
    }
    await users.createIndex(
      { telemetryKeyHash: 1 },
      {
        name: 'telemetry_key_hash_unique',
        unique: true,
        partialFilterExpression: { telemetryKeyHash: { $type: 'string' } },
      },
    );
    return;
  }

  for (const index of telemetryIndexes) {
    if (!index.name) throw new Error('Cannot safely replace an unnamed telemetry key index.');
    await users.dropIndex(index.name);
  }
}

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected');
});

mongoose.connection.on('error', (err) => {
  logger.error({ err }, 'MongoDB error');
});
