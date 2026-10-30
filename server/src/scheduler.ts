import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ILastResponseSummary {
  statusCode: number | null;
  responseTimeMs: number | null;
  responseSizeBytes: number | null;
}

export interface ISavedRequest extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  name: string;
  method: string;
  url: string;
  headers: { key: string; value: string; enabled: boolean }[];
  body: string;
  bodyType: 'none' | 'json' | 'text';
  authType: 'none' | 'bearer' | 'basic';
  authCredentials: string;
  lastResponseSummary: ILastResponseSummary | null;
  createdAt: Date;
}

const savedRequestSchema = new Schema<ISavedRequest>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, default: '' },
    method: { type: String, default: 'GET' },
    url: { type: String, required: true },
    headers: [
      {
        key: String,
        value: String,
        enabled: { type: Boolean, default: true },
      },
    ],
    body: { type: String, default: '' },
    bodyType: { type: String, enum: ['none', 'json', 'text'], default: 'none' },
    authType: { type: String, enum: ['none', 'bearer', 'basic'], default: 'none' },
    authCredentials: { type: String, default: '' },
    lastResponseSummary: {
      statusCode: { type: Number, default: null },
      responseTimeMs: { type: Number, default: null },
      responseSizeBytes: { type: Number, default: null },
    },
  },
  { timestamps: true }
);

export const SavedRequest: Model<ISavedRequest> = mongoose.model<ISavedRequest>('SavedRequest', savedRequestSchema);
