import mongoose, { Schema, Document, Model } from 'mongoose';

export type MonitorMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
export type MonitorStatus = 'up' | 'down' | 'paused' | 'pending';
export type BodyType = 'none' | 'json' | 'text';
export type AuthType = 'none' | 'bearer' | 'basic';

export interface IMonitorHeader {
  key: string;
  value: string; // AES-256-GCM encrypted
  enabled: boolean;
}

export interface IMonitorAssertion {
  type: 'body_contains' | 'json_path_equals';
  path?: string; // for json_path_equals
  value: string;
}

export interface IMonitor extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  name: string;
  url: string;
  method: MonitorMethod;
  headers: IMonitorHeader[];
  body: string;
  bodyType: BodyType;
  authType: AuthType;
  authCredentials: string; // encrypted: "token" for bearer, "user:pass" for basic
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatusCodes: (number | string)[]; // numbers or ranges like "200-299"
  assertions: IMonitorAssertion[];
  coldStartAware: boolean;
  keepAliveEnabled: boolean;
  failureThreshold: number;
  status: MonitorStatus;
  lastCheckedAt: Date | null;
  lastResponseTimeMs: number | null;
  currentIncidentId: mongoose.Types.ObjectId | null;
  showOnStatusPage: boolean;
  consecutiveFailures: number; // internal counter, not exposed
  createdAt: Date;
  updatedAt: Date;
}

const monitorSchema = new Schema<IMonitor>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    method: { type: String, enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], default: 'GET' },
    headers: [
      {
        key: { type: String, required: true },
        value: { type: String, required: true }, // stored encrypted
        enabled: { type: Boolean, default: true },
      },
    ],
    body: { type: String, default: '' },
    bodyType: { type: String, enum: ['none', 'json', 'text'], default: 'none' },
    authType: { type: String, enum: ['none', 'bearer', 'basic'], default: 'none' },
    authCredentials: { type: String, default: '' }, // stored encrypted
    intervalSeconds: {
      type: Number,
      enum: [60, 300, 600, 1800, 3600],
      default: 300,
    },
    timeoutMs: { type: Number, default: 30000, max: 60000 },
    expectedStatusCodes: { type: [Schema.Types.Mixed], default: ['200-299'] },
    assertions: [
      {
        type: { type: String, enum: ['body_contains', 'json_path_equals'] },
        path: { type: String },
        value: { type: String, required: true },
      },
    ],
    coldStartAware: { type: Boolean, default: true },
    keepAliveEnabled: { type: Boolean, default: false },
    failureThreshold: { type: Number, default: 2, min: 1, max: 10 },
    status: { type: String, enum: ['up', 'down', 'paused', 'pending'], default: 'pending' },
    lastCheckedAt: { type: Date, default: null },
    lastResponseTimeMs: { type: Number, default: null },
    currentIncidentId: { type: Schema.Types.ObjectId, ref: 'Incident', default: null },
    showOnStatusPage: { type: Boolean, default: true },
    consecutiveFailures: { type: Number, default: 0, select: false },
  },
  { timestamps: true }
);

export const Monitor: Model<IMonitor> = mongoose.model<IMonitor>('Monitor', monitorSchema);
