import mongoose, { Schema, Document, Model } from 'mongoose';

export type CheckClassification = 'ok' | 'slow' | 'cold_start' | 'failed';
export type ErrorType =
  | 'timeout'
  | 'dns'
  | 'connection_refused'
  | 'tls'
  | 'bad_status'
  | 'assertion_failed'
  | 'redirect_loop'
  | 'too_large'
  | 'ssrf'
  | 'unknown';

export interface ICheckResult extends Document {
  _id: mongoose.Types.ObjectId;
  monitorId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  checkedAt: Date;
  success: boolean;
  classification: CheckClassification;
  statusCode: number | null;
  responseTimeMs: number | null;
  attempts: number;
  errorType: ErrorType | null;
  errorMessage: string | null;
  responseSizeBytes: number | null;
}

const checkResultSchema = new Schema<ICheckResult>(
  {
    monitorId: { type: Schema.Types.ObjectId, ref: 'Monitor', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    checkedAt: { type: Date, required: true, default: Date.now },
    success: { type: Boolean, required: true },
    classification: { type: String, enum: ['ok', 'slow', 'cold_start', 'failed'], required: true },
    statusCode: { type: Number, default: null },
    responseTimeMs: { type: Number, default: null },
    attempts: { type: Number, default: 1 },
    errorType: {
      type: String,
      enum: ['timeout', 'dns', 'connection_refused', 'tls', 'bad_status', 'assertion_failed', 'redirect_loop', 'too_large', 'ssrf', 'unknown'],
      default: null,
    },
    errorMessage: { type: String, default: null },
    responseSizeBytes: { type: Number, default: null },
  },
  { timestamps: false }
);

// Primary access pattern: by monitorId, newest first
checkResultSchema.index({ monitorId: 1, checkedAt: -1 });
checkResultSchema.index({ userId: 1, checkedAt: -1 });

export const CheckResult: Model<ICheckResult> = mongoose.model<ICheckResult>('CheckResult', checkResultSchema);
