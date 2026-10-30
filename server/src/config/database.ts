import mongoose from 'mongoose';
import { config } from './index.js';
import { logger } from './logger.js';

export async function connectDatabase() {
  try {
    await mongoose.connect(config.mongoUri);
    logger.info('MongoDB connected');
  } catch (err) {
    logger.error({ err }, 'MongoDB connection failed');
    throw err;
  }
}

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected');
});

mongoose.connection.on('error', (err) => {
  logger.error({ err }, 'MongoDB error');
});
