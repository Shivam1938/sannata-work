import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { config, validateConfig, isRealTelegramConfig } from './config/index.js';
import { logger } from './config/logger.js';
import { connectDatabase } from './config/database.js';
import { getRedisClient } from './config/redis.js';
import { getTelegramBot } from './services/alert.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';

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
  try {
    await connectDatabase();
    getRedisClient(); // Initialize Redis connection

    // Start Telegram bot (if configured)
    if (isRealTelegramConfig()) {
      getTelegramBot({ polling: true });
      logger.info({ mode: config.telegram.mode }, 'Telegram bot initialized');
    } else {
      logger.warn('Telegram bot token not configured — alerts disabled');
    }

    const server = app.listen(config.port, () => {
      logger.info({ port: config.port, env: config.nodeEnv }, 'Server started');
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutting down...');
      server.close(async () => {
        const mongoose = await import('mongoose');
        await mongoose.default.disconnect();
        const { closeRedis } = await import('./config/redis.js');
        await closeRedis();
        logger.info('Server stopped gracefully');
        process.exit(0);
      });
      // Force exit after 10s
      setTimeout(() => process.exit(1), 10_000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }
}

start();

export { app };
