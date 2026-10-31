import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { config, validateConfig, isRealTelegramConfig } from './config/index.js';
import { logger } from './config/logger.js';
import { connectDatabase } from './config/database.js';
import { closeRedis, getRedisClient } from './config/redis.js';
import { closeSchedulerQueues } from './queues/scheduler.js';
import { getTelegramBot } from './services/alert.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { startWorkers } from './worker/runtime.js';
import mongoose from 'mongoose';

// Validate config before anything else
validateConfig();

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", config.clientUrl],
    },
  },
}));

// CORS
app.use(cors({
  origin: (origin, callback) => {
    // Vite may be opened with either localhost or 127.0.0.1 during local development.
    const localDevOrigins = config.nodeEnv === 'production'
      ? []
      : ['http://localhost:5173', 'http://127.0.0.1:5173'];
    if (!origin || origin === config.clientUrl || localDevOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// Global rate limit
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' } },
});
app.use(globalLimiter);

// Health check (before routes)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// Routes are registered before the server starts.
import routes from './routes/index.js';
app.use(routes);
app.use(notFound);
app.use(errorHandler);

async function start() {
  let workers: Awaited<ReturnType<typeof startWorkers>> | undefined;
  let telegramBot: ReturnType<typeof getTelegramBot> = null;
  try {
    await connectDatabase();
    getRedisClient(); // Initialize Redis connection

    if (config.runWorker) {
      workers = await startWorkers();
      logger.info('BullMQ worker enabled in API process');
    }

    // Start Telegram bot (if configured)
    if (isRealTelegramConfig()) {
      telegramBot = getTelegramBot({ polling: true });
      logger.info({ mode: config.telegram.mode }, 'Telegram bot initialized');
    } else {
      logger.warn('Telegram bot token not configured — alerts disabled');
    }

    const server = app.listen(config.port);
    server.on('listening', () => logger.info({ port: config.port, env: config.nodeEnv }, 'Server started'));

    // Graceful shutdown
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = async (signal: string) => {
      if (shutdownPromise) return shutdownPromise;
      logger.info({ signal }, 'Shutting down...');
      shutdownPromise = (async () => {
        const forceExit = setTimeout(() => {
          logger.warn('Closing remaining HTTP connections after shutdown timeout');
          server.closeAllConnections();
        }, 10_000);
        const hardExit = setTimeout(() => process.exit(1), 20_000);
        forceExit.unref();
        hardExit.unref();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
        await workers?.close();
        if (telegramBot && config.telegram.mode === 'polling') await telegramBot.stopPolling();
        await closeSchedulerQueues();
        await closeRedis();
        await mongoose.disconnect();
        logger.info('Server stopped gracefully');
        clearTimeout(forceExit);
        clearTimeout(hardExit);
        process.exitCode = 0;
      })();
      return shutdownPromise;
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM').catch((err) => {
      logger.error({ err }, 'Server shutdown failed');
      process.exitCode = 1;
    }));
    process.on('SIGINT', () => void shutdown('SIGINT').catch((err) => {
      logger.error({ err }, 'Server shutdown failed');
      process.exitCode = 1;
    }));
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    await workers?.close().catch((closeError) => logger.error({ err: closeError }, 'Failed to close workers'));
    await closeSchedulerQueues().catch((closeError) => logger.error({ err: closeError }, 'Failed to close queues'));
    await closeRedis().catch((closeError) => logger.error({ err: closeError }, 'Failed to close Redis'));
    await mongoose.disconnect().catch((closeError) => logger.error({ err: closeError }, 'Failed to close MongoDB'));
    process.exit(1);
  }
}

start();

export { app };
