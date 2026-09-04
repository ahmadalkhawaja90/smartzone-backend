import mongoose, { Document, Schema } from 'mongoose';

export interface IOpportunity extends Document {
  symbol: string;
  baseAsset: string;
  market: 'crypto' | 'forex';
  timeframe: string;
  type: 'SPOT_BUY';
  currentPrice: number;
  entryZone: {
    min: number;
    max: number;
  };
  stopLoss: number;
  targets: {
    tp1: number;
    tp2: number;
    tp3: number;
  };
  riskRewardRatio: string;
  confluenceScore: number;
  fulfilledConditions: Array<{
    title: string;
    description: string;
  }>;
  analysisReasons: {
    entryReason: string;
    stopLossReason: string;
    takeProfitReason: string;
  };
  // الحالات المحدثة لتشمل دورة حياة الأمر والتأمين
  status:
    | 'PENDING_ENTRY'
    | 'ACTIVE'
    | 'BREAK_EVEN'
    | 'HIT_TP1'
    | 'HIT_TP2'
    | 'HIT_TP3'
    | 'HIT_SL'
    | 'CLOSED_BE'
    | 'EXPIRED'
    | 'CANCELLED'
    | 'TP2_SECURED'
    | 'CLOSED_TRAILING_TP1';

  // حقول التتبع الخاصة بمنصة باينانس
  orderId?: string;
  entryOrderType?: 'LIMIT' | 'MARKET';
  currentStopLoss?: number;
  profitPercentage?: number;
  closedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const OpportunitySchema = new Schema<IOpportunity>(
  {
    symbol: { type: String, required: true, uppercase: true, index: true },
    baseAsset: { type: String, required: true, uppercase: true },
    market: { type: String, enum: ['crypto', 'forex'], default: 'crypto' },
    timeframe: { type: String, default: '15m' },
    type: { type: String, default: 'SPOT_BUY' },
    currentPrice: { type: Number, required: true },
    entryZone: {
      min: { type: Number, required: true },
      max: { type: Number, required: true },
    },
    stopLoss: { type: Number, required: true },
    targets: {
      tp1: { type: Number, required: true },
      tp2: { type: Number, required: true },
      tp3: { type: Number, required: true },
    },
    riskRewardRatio: { type: String, default: '1:2.5' },
    confluenceScore: { type: Number, required: true },
    fulfilledConditions: [
      {
        title: { type: String, required: true },
        description: { type: String, required: true },
      },
    ],
    analysisReasons: {
      entryReason: { type: String, required: true },
      stopLossReason: { type: String, required: true },
      takeProfitReason: { type: String, required: true },
    },
    status: {
      type: String,
      enum: [
        'PENDING_ENTRY',
        'ACTIVE',
        'BREAK_EVEN',
        'HIT_TP1',
        'HIT_TP2',
        'HIT_TP3',
        'HIT_SL',
        'CLOSED_BE',
        'EXPIRED',
        'CANCELLED',
        'TP2_SECURED',
        'CLOSED_TRAILING_TP1',
      ],
      default: 'PENDING_ENTRY',
    },
    orderId: { type: String, default: null },
    entryOrderType: { type: String, enum: ['LIMIT', 'MARKET'], default: 'LIMIT' },
    currentStopLoss: { type: Number, default: null },
    profitPercentage: { type: Number, default: 0 },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const Opportunity = mongoose.model<IOpportunity>('Opportunity', OpportunitySchema);
