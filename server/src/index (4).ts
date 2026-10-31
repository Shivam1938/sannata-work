import TelegramBot from 'node-telegram-bot-api';
import nodemailer from 'nodemailer';
import { config } from './config/index.js';
import { logger } from './config/logger.js';
import { User } from './models/User.js';
import { Incident } from './models/Incident.js';
import type { IMonitor } from './models/Monitor.js';
import type { IIncident } from './models/Incident.js';

let bot: TelegramBot | null = null;

export function getTelegramBot(): TelegramBot | null {
  if (!config.telegram.botToken) return null;
  if (!bot) {
    bot = new TelegramBot(config.telegram.botToken, {
      polling: config.telegram.mode === 'polling',
    });
    setupBotCommands(bot);
  }
  return bot;
}

function setupBotCommands(bot: TelegramBot) {
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    if (text.startsWith('/start')) {
      const parts = text.split(' ');
      const code = parts[1];
      if (code) {
        await handleTelegramLink(bot, chatId, code);
      } else {
        await bot.sendMessage(chatId, 'Welcome to Sannata! Use /start <code> to link your account.');
      }
    } else if (text === '/status') {
      await handleStatusCommand(bot, chatId);
    } else if (text.startsWith('/pause ')) {
      const name = text.slice(7).trim();
      await handlePauseCommand(bot, chatId, name);
    } else if (text.startsWith('/resume ')) {
      const name = text.slice(8).trim();
      await handleResumeCommand(bot, chatId, name);
    }
  });

  bot.on('polling_error', (err) => {
    logger.error({ err }, 'Telegram polling error');
  });
}

async function handleTelegramLink(bot: TelegramBot, chatId: number, code: string) {
  const user = await User.findOne({
    telegramLinkCode: code,
    telegramLinkCodeExpiry: { $gt: new Date() },
  }).select('+telegramLinkCode +telegramLinkCodeExpiry');

  if (!user) {
    await bot.sendMessage(chatId, '❌ Invalid or expired link code. Please generate a new one from Sannata settings.');
    return;
  }

  user.telegramChatId = String(chatId);
  user.telegramLinkCode = null;
  user.telegramLinkCodeExpiry = null;
  await user.save();

  await bot.sendMessage(
    chatId,
    `✅ Successfully linked! I'll notify you when your monitors go down.\n\nCommands:\n/status — list your monitors\n/pause <name> — pause a monitor\n/resume <name> — resume a monitor`
  );
}

async function handleStatusCommand(bot: TelegramBot, chatId: number) {
  const user = await User.findOne({ telegramChatId: String(chatId) });
  if (!user) {
    await bot.sendMessage(chatId, '⚠️ Your Telegram account is not linked to Sannata.');
    return;
  }

  const { Monitor } = await import('./models/Monitor.js');
  const monitors = await Monitor.find({ userId: user._id }).select('name status url').lean();

  if (monitors.length === 0) {
    await bot.sendMessage(chatId, '📊 You have no monitors yet. Add one at your Sannata dashboard.');
    return;
  }

  const lines = monitors.map((m) => {
    const icon = m.status === 'up' ? '🟢' : m.status === 'down' ? '🔴' : m.status === 'paused' ? '⏸️' : '⏳';
    return `${icon} ${m.name} (${m.status})`;
  });
  await bot.sendMessage(chatId, `📊 Your monitors:\n${lines.join('\n')}`);
}

async function handlePauseCommand(bot: TelegramBot, chatId: number, name: string) {
  const user = await User.findOne({ telegramChatId: String(chatId) });
  if (!user) return;

  const { Monitor } = await import('./models/Monitor.js');
  const monitor = await Monitor.findOne({ userId: user._id, name: { $regex: new RegExp(name, 'i') } });

  if (!monitor) {
    await bot.sendMessage(chatId, `❌ No monitor found with name "${name}"`);
    return;
  }

  monitor.status = 'paused';
  await monitor.save();

  // Remove BullMQ job
  const { schedulerService } = await import('./queues/scheduler.js');
  await schedulerService.removeMonitorJob(monitor._id.toString());

  await bot.sendMessage(chatId, `⏸️ Monitor "${monitor.name}" paused.`);
}

async function handleResumeCommand(bot: TelegramBot, chatId: number, name: string) {
  const user = await User.findOne({ telegramChatId: String(chatId) });
  if (!user) return;

  const { Monitor } = await import('./models/Monitor.js');
  const monitor = await Monitor.findOne({ userId: user._id, name: { $regex: new RegExp(name, 'i') } });

  if (!monitor) {
    await bot.sendMessage(chatId, `❌ No monitor found with name "${name}"`);
    return;
  }

  monitor.status = 'pending';
  await monitor.save();

  const { schedulerService } = await import('./queues/scheduler.js');
  await schedulerService.scheduleMonitor(monitor);

  await bot.sendMessage(chatId, `▶️ Monitor "${monitor.name}" resumed.`);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function buildAlertMessage(
  monitor: IMonitor,
  incident: IIncident,
  type: 'down' | 'reminder' | 'recovery'
): string {
  const baseUrl = config.clientUrl;
  const monitorUrl = `${baseUrl}/monitors/${monitor._id}`;

  if (type === 'recovery') {
    return (
      `✅ *${monitor.name}* is back up!\n\n` +
      `🔗 ${monitor.url}\n` +
      `⏱️ Downtime: ${formatDuration(incident.durationSeconds || 0)}\n` +
      `${incident.aiSummaryResolved ? `\n📝 ${incident.aiSummaryResolved}\n` : ''}` +
      `\n[View monitor](${monitorUrl})`
    );
  }

  const prefix = type === 'reminder' ? '⚠️ *REMINDER:*' : '🚨';
  return (
    `${prefix} *${monitor.name}* is down!\n\n` +
    `🔗 ${monitor.url}\n` +
    `❌ Error: ${incident.firstErrorType || 'unknown'}\n` +
    `${incident.lastErrorMessage ? `💬 ${incident.lastErrorMessage}\n` : ''}` +
    `🕐 Started: ${incident.startedAt.toISOString()}\n` +
    `${incident.aiSummary ? `\n📝 ${incident.aiSummary}\n` : ''}` +
    `\n[View monitor](${monitorUrl})`
  );
}

function buildEmailHtml(
  monitor: IMonitor,
  incident: IIncident,
  type: 'down' | 'reminder' | 'recovery'
): { subject: string; html: string } {
  const isDown = type !== 'recovery';
  const subject = isDown
    ? `🚨 ${monitor.name} is down — Sannata Alert`
    : `✅ ${monitor.name} recovered — Sannata`;

  const color = isDown ? '#ef4444' : '#22c55e';
  const title = isDown
    ? type === 'reminder'
      ? `⚠️ ${monitor.name} is still down`
      : `🚨 ${monitor.name} is down`
    : `✅ ${monitor.name} has recovered`;

  const details = isDown
    ? `
      <p><strong>URL:</strong> ${monitor.url}</p>
      <p><strong>Error:</strong> ${incident.firstErrorType || 'unknown'}</p>
      ${incident.lastErrorMessage ? `<p><strong>Message:</strong> ${incident.lastErrorMessage}</p>` : ''}
      <p><strong>Started:</strong> ${incident.startedAt.toISOString()}</p>
      ${incident.aiSummary ? `<blockquote style="border-left:3px solid #999;padding-left:1em;color:#666">${incident.aiSummary}</blockquote>` : ''}
    `
    : `
      <p><strong>URL:</strong> ${monitor.url}</p>
      <p><strong>Downtime:</strong> ${formatDuration(incident.durationSeconds || 0)}</p>
      ${incident.aiSummaryResolved ? `<blockquote style="border-left:3px solid #999;padding-left:1em;color:#666">${incident.aiSummaryResolved}</blockquote>` : ''}
    `;

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <div style="background:${color};color:white;padding:20px;border-radius:8px 8px 0 0">
        <h1 style="margin:0;font-size:20px">${title}</h1>
      </div>
      <div style="background:#f9f9f9;padding:20px;border-radius:0 0 8px 8px">
        ${details}
        <p><a href="${config.clientUrl}/monitors/${monitor._id}" style="background:#3b82f6;color:white;padding:8px 16px;border-radius:4px;text-decoration:none">View Monitor</a></p>
      </div>
      <p style="color:#999;font-size:12px;text-align:center">Sannata — Chup hai, matlab sab theek hai.</p>
    </div>
  `;

  return { subject, html };
}

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!config.smtp.host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
  }
  return transporter;
}

export async function sendAlerts(
  monitor: IMonitor,
  incident: IIncident,
  type: 'down' | 'reminder' | 'recovery'
): Promise<void> {
  const user = await User.findById(monitor.userId).select(
    'telegramChatId alertEmail alertPreferences plan'
  );
  if (!user) return;

  const promises: Promise<void>[] = [];

  // Telegram
  if (user.alertPreferences.telegram && user.telegramChatId) {
    const telegramBot = getTelegramBot();
    if (telegramBot) {
      const message = buildAlertMessage(monitor, incident, type);
      promises.push(
        telegramBot
          .sendMessage(user.telegramChatId, message, { parse_mode: 'Markdown' })
          .then(async () => {
            await Incident.findByIdAndUpdate(incident._id, {
              $push: { alertsSent: { channel: 'telegram', type, sentAt: new Date() } },
            });
          })
          .catch((err) => {
            logger.error({ err }, 'Failed to send Telegram alert');
          })
      );
    }
  }

  // Email
  if (user.alertPreferences.email && user.alertEmail) {
    const mail = getTransporter();
    if (mail) {
      const { subject, html } = buildEmailHtml(monitor, incident, type);
      promises.push(
        mail
          .sendMail({ from: config.smtp.from, to: user.alertEmail, subject, html })
          .then(async () => {
            await Incident.findByIdAndUpdate(incident._id, {
              $push: { alertsSent: { channel: 'email', type, sentAt: new Date() } },
            });
          })
          .catch((err) => {
            logger.error({ err }, 'Failed to send email alert');
          })
      );
    }
  }

  await Promise.allSettled(promises);
}

export async function sendTestAlert(userId: string, channel: 'telegram' | 'email'): Promise<void> {
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  if (channel === 'telegram') {
    if (!user.telegramChatId) throw new Error('Telegram not connected');
    const telegramBot = getTelegramBot();
    if (!telegramBot) throw new Error('Telegram bot not configured');
    await telegramBot.sendMessage(
      user.telegramChatId,
      '🧪 This is a test alert from Sannata. Your Telegram alerts are working correctly!'
    );
  } else {
    if (!user.alertEmail) throw new Error('No alert email configured');
    const mail = getTransporter();
    if (!mail) throw new Error('Email not configured');
    await mail.sendMail({
      from: config.smtp.from,
      to: user.alertEmail,
      subject: '🧪 Sannata Test Alert',
      html: '<p>This is a test alert from Sannata. Your email alerts are working correctly!</p><p style="color:#999;font-size:12px">Sannata — Chup hai, matlab sab theek hai.</p>',
    });
  }
}
