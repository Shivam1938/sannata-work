import mongoose, { Schema, Document, Model } from 'mongoose';
import { ErrorType } from './CheckResult.js';

export interface IAlertSent {
  channel: 'telegram' | 'email';
  type: 'down' | 'reminder' | 'recovery';
  sentAt: Date;
}

export interface IIncident extends Document {
  _id: mongoose.Types.ObjectId;
  monitorId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  startedAt: Date;
  resolvedAt: Date | null;
  durationSeconds: number | null;
  status: 'open' | 'resolved';
  firstErrorType: ErrorType | null;
  failedChecksCount: number;
  lastErrorMessage: string | null;
  aiSummary: string | null;
  aiSummaryResolved: string | null;
  alertsSent: IAlertSent[];
  reminderSentAt: Date | null;
}

const incidentSchema = new Schema<IIncident>(
  {
    monitorId: { type: Schema.Types.ObjectId, ref: 'Monitor', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    startedAt: { type: Date, required: true, default: Date.now },
    resolvedAt: { type: Date, default: null },
    durationSeconds: { type: Number, default: null },
    status: { type: String, enum: ['open', 'resolved'], default: 'open' },
    firstErrorType: { type: String, default: null },
    failedChecksCount: { type: Number, default: 1 },
    lastErrorMessage: { type: String, default: null },
    aiSummary: { type: String, default: null },
    aiSummaryResolved: { type: String, default: null },
    alertsSent: [
      {
        channel: { type: String, enum: ['telegram', 'email'] },
        type: { type: String, enum: ['down', 'reminder', 'recovery'] },
        sentAt: { type: Date, default: Date.now },
      },
    ],
    reminderSentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const Incident: Model<IIncident> = mongoose.model<IIncident>('Incident', incidentSchema);
