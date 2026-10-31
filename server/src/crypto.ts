/**
 * seed.ts — Seed the database with a demo user and demo monitors.
 *
 * Usage:
 *   cd server && npx tsx src/scripts/seed.ts
 *
 * NOTE: Set ALLOW_PRIVATE_TARGETS=true in server/.env so the checker accepts
 *       localhost URLs produced by this seed.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User } from './models/User.js';
import { Monitor } from './models/Monitor.js';

// ── Config ────────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/sannata';

const DEMO_USER = {
  name: 'Demo User',
  email: 'demo@sannata.dev',
  password: 'demo123456',
  plan: 'pro' as const,
};

interface DemoMonitorDef {
  name: string;
  url: string;
  intervalSeconds: number;
  timeoutMs?: number;
  coldStartAware?: boolean;
}

const DEMO_MONITORS: DemoMonitorDef[] = [
  {
    name: 'Demo: OK',
    url: 'http://localhost:3003/ok',
    intervalSeconds: 300,
  },
  {
    name: 'Demo: Flaky',
    url: 'http://localhost:3003/flaky',
    intervalSeconds: 300,
  },
  {
    name: 'Demo: Sleepy (Cold Start)',
    url: 'http://localhost:3003/sleepy',
    intervalSeconds: 600,
    coldStartAware: true,
  },
  {
    name: 'Demo: Down',
    url: 'http://localhost:3003/down',
    intervalSeconds: 300,
  },
  {
    name: 'Demo: Slow',
    url: 'http://localhost:3003/slow',
    intervalSeconds: 600,
    timeoutMs: 10000,
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function seed() {
  console.log('🌱  Connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log(`✅  Connected to ${MONGO_URI}\n`);

  // ── Demo user ──────────────────────────────────────────────────────────────
  let user = await User.findOne({ email: DEMO_USER.email }).select('+passwordHash');

  if (user) {
    console.log(`ℹ️   Demo user already exists (${DEMO_USER.email}). Skipping user creation.`);
  } else {
    const passwordHash = await bcrypt.hash(DEMO_USER.password, 10);
    user = await User.create({
      name: DEMO_USER.name,
      email: DEMO_USER.email,
      passwordHash,
      plan: DEMO_USER.plan,
    });
    console.log(`✅  Created demo user: ${user.email} (plan: ${user.plan})`);
  }

  // ── Demo monitors ──────────────────────────────────────────────────────────
  let created = 0;
  let skipped = 0;

  for (const def of DEMO_MONITORS) {
    const existing = await Monitor.findOne({ userId: user._id, name: def.name });

    if (existing) {
      console.log(`ℹ️   Monitor "${def.name}" already exists. Skipping.`);
      skipped++;
      continue;
    }

    await Monitor.create({
      userId: user._id,
      name: def.name,
      url: def.url,
      method: 'GET',
      intervalSeconds: def.intervalSeconds,
      timeoutMs: def.timeoutMs ?? 30000,
      coldStartAware: def.coldStartAware ?? false,
      expectedStatusCodes: ['200-299'],
      status: 'pending',
      showOnStatusPage: true,
    });

    console.log(`✅  Created monitor: "${def.name}" → ${def.url}`);
    created++;
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────────');
  console.log('🎉  Seed complete!');
  console.log(`   Monitors created : ${created}`);
  console.log(`   Monitors skipped : ${skipped}`);
  console.log('\n📋  Demo credentials:');
  console.log(`   Email    : ${DEMO_USER.email}`);
  console.log(`   Password : ${DEMO_USER.password}`);
  console.log('\n⚠️   Remember: set ALLOW_PRIVATE_TARGETS=true in server/.env');
  console.log('    so the checker accepts localhost monitor URLs.');
  console.log('─────────────────────────────────────────────\n');

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error('❌  Seed failed:', err);
  process.exit(1);
});
