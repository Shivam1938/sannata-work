import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ITelemetryEvent extends Document {
  userId: mongoose.Types.ObjectId;
  service: string;
  method: string;
  path: string;
  statusCode: number;
  latencyMs: number;
  occurredAt: Date;
  correlationId: string | null;
  errorType: string | null;
  errorMessage: string | null;
}

const telemetryEventSchema = new Schema<ITelemetryEvent>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    service: { type: String, required: true, maxlength: 100 },
    method: { type: String, required: true, maxlength: 10 },
    path: { type: String, required: true, maxlength: 500 },
    statusCode: { type: Number, required: true, min: 100, max: 599 },
    latencyMs: { type: Number, required: true, min: 0, max: 600000 },
    occurredAt: { type: Date, required: true, default: Date.now },
    correlationId: { type: String, default: null, maxlength: 128 },
    errorType: { type: String, default: null, maxlength: 100 },
    errorMessage: { type: String, default: null, maxlength: 500 },
  },
  { versionKey: false },
);

telemetryEventSchema.index({ userId: 1, occurredAt: -1 });
telemetryEventSchema.index({ occurredAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const TelemetryEvent: Model<ITelemetryEvent> =
  mongoose.models.TelemetryEvent || mongoose.model<ITelemetryEvent>('TelemetryEvent', telemetryEventSchema);
