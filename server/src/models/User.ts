import mongoose, { Schema, Document, Model } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;
  passwordHash: string;
  plan: 'free' | 'pro';
  subscriptionStartedAt: Date | null;
  proExpiresAt: Date | null;
  telegramChatId: string | null;
  telegramLinkCode: string | null;
  telegramLinkCodeExpiry: Date | null;
  alertEmail: string;
  alertPreferences: {
    telegram: boolean;
    email: boolean;
  };
  statusPageSlug: string;
  statusPageEnabled: boolean;
  statusPageTitle: string;
  aiAnalysesUsed: number;
  telemetryKeyHash: string | null;
  createdAt: Date;
  comparePassword(candidate: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    plan: { type: String, enum: ['free', 'pro'], default: 'free' },
    subscriptionStartedAt: { type: Date, default: null },
    proExpiresAt: { type: Date, default: null },
    telegramChatId: { type: String, default: null },
    telegramLinkCode: { type: String, default: null, select: false },
    telegramLinkCodeExpiry: { type: Date, default: null, select: false },
    alertEmail: { type: String, default: '' },
    alertPreferences: {
      telegram: { type: Boolean, default: true },
      email: { type: Boolean, default: true },
    },
    statusPageSlug: { type: String, unique: true, sparse: true },
    statusPageEnabled: { type: Boolean, default: false },
    statusPageTitle: { type: String, default: 'Status Page' },
    aiAnalysesUsed: { type: Number, default: 0, min: 0 },
    telemetryKeyHash: { type: String, default: null, select: false },
  },
  { timestamps: true }
);

// Generate a unique slug before saving new users
userSchema.pre('save', async function (next) {
  if (this.isNew && !this.statusPageSlug) {
    // Generate slug from name + random suffix
    const base = this.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20);
    const suffix = Math.random().toString(36).slice(2, 7);
    this.statusPageSlug = `${base}-${suffix}`;
  }
  if (!this.alertEmail && this.email) {
    this.alertEmail = this.email;
  }
  next();
});

userSchema.methods.comparePassword = async function (candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.passwordHash);
};

userSchema.set('toJSON', {
  transform(_doc, ret) {
    const safeRet = ret as unknown as Record<string, unknown>;

    delete safeRet.passwordHash;
    delete safeRet.telegramLinkCode;
    delete safeRet.telegramLinkCodeExpiry;

    return ret;
  },
});

export const User: Model<IUser> = mongoose.model<IUser>('User', userSchema);
