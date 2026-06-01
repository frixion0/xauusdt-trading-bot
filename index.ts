// ================================================================
// XAUUSDT Trading Bot v2.0 — Standalone 24/7 Bot
// Strategy: RSI(1) + SMA(14)
//   BUY LONG  when SMA crosses above 30
//   SELL (close LONG) when SMA crosses below 70
// Data: Bybit WebSocket (works on cloud!) + Binance REST fallback
// Trading: Mudrex Futures API
// ================================================================

import { createServer } from 'http';
import WebSocket from 'ws';

// ==================== CONFIGURATION ====================

const CONFIG = {
  // Strategy
  RSI_PERIOD: 1,
  SMA_PERIOD: 14,
  BUY_THRESHOLD: 30,      // SMA crosses above → BUY LONG
  SELL_THRESHOLD: 70,     // SMA crosses below → CLOSE LONG

  // Data
  SYMBOL: 'XAUUSDT',
  INTERVAL: 3,            // 3-minute candles
  HISTORICAL_LIMIT: 200,

  // Mudrex
  MUDREX_API_KEY: process.env.MUDREX_API_KEY || 'v33dnrb92FKBSMTVUxJ6ufeW7cBBEmmK',
  MUDREX_BASE: 'https://trade.mudrex.com',

  // Bot settings
  LEVERAGE: Number(process.env.LEVERAGE) || 100,
  QUANTITY: Number(process.env.QUANTITY) || 0.002,
  STOP_LOSS_PCT: Number(process.env.STOP_LOSS_PCT) || 0.5,   // % below entry
  TAKE_PROFIT_PCT: Number(process.env.TAKE_PROFIT_PCT) || 1.0, // % above entry

  // Server
  PORT: Number(process.env.PORT) || 3003,

  // Telegram (optional — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env vars)
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
};

// ==================== TYPES ====================

interface CandleData {
  time: number;       // Unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface RSIPoint {
  time: number;
  rsi: number;
  sma: number;
}

interface SignalRecord {
  id: string;
  type: 'BUY' | 'SELL';
  time: number;
  price: number;
  rsi: number;
  sma: number;
  autoTraded: boolean;
  orderId?: string;
  error?: string;
}

interface Position {
  id: string;
  symbol: string;
  order_type: string;
  entry_price: string;
  quantity: string;
  leverage: string;
  liquidation_price: string;
  stoploss: { price: string; order_id: string; order_type: string } | null;
  takeprofit: { price: string; order_id: string; order_type: string } | null;
  status: string;
  created_at: string;
}

// ==================== STATE ====================

const candles: CandleData[] = [];
const rsiHistory: RSIPoint[] = [];
const signalLog: SignalRecord[] = [];       // Last 20 signals
let prevSmaValue: number | null = null;
let currentSmaValue: number | null = null;
let lastProcessedCandleTime = 0;
let botStartTime = Date.now();
let dataStatus: 'connecting' | 'bybit-ws' | 'bybit-rest' | 'binance-rest' | 'error' = 'connecting';
let lastDataTime = 0;
let bybitWs: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let isBotPaused = false;

// ==================== HELPERS ====================

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 11);
}

function log(level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE', msg: string): void {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level}]`;
  if (level === 'TRADE') {
    console.log(`\x1b[33m${prefix} ${msg}\x1b[0m`);
  } else if (level === 'ERROR') {
    console.error(`${prefix} ${msg}`);
  } else if (level === 'WARN') {
    console.warn(`\x1b[35m${prefix} ${msg}\x1b[0m`);
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

// ==================== TELEGRAM NOTIFICATIONS ====================

async function sendTelegram(message: string): Promise<void> {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;

  try {
    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
      }),
    });
  } catch (error: any) {
    log('WARN', `Telegram send failed: ${error.message}`);
  }
}

// ==================== RSI CALCULATION ====================

function calculateRSI(closes: number[], period: number = CONFIG.RSI_PERIOD): number[] {
  const rsiValues: number[] = [];
  if (closes.length < period + 1) return rsiValues;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }

  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) rsiValues.push(100);
  else rsiValues.push(100 - (100 / (1 + avgGain / avgLoss)));

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) rsiValues.push(100);
    else if (avgGain === 0) rsiValues.push(0);
    else rsiValues.push(100 - (100 / (1 + avgGain / avgLoss)));
  }

  return rsiValues;
}

function calculateSMA(values: number[], period: number = CONFIG.SMA_PERIOD): { smaValues: number[]; alignedValues: number[] } {
  const smaValues: number[] = [];
  const alignedRsi: number[] = [];
  if (values.length < period) return { smaValues, alignedValues: alignedRsi };

  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    smaValues.push(sum / period);
    alignedRsi.push(values[i]);
  }

  return { smaValues, alignedValues: alignedRsi };
}

function recalculateIndicators(): void {
  if (candles.length < CONFIG.RSI_PERIOD + CONFIG.SMA_PERIOD + 1) return;

  const closes = candles.map(c => c.close);
  const rsiVals = calculateRSI(closes, CONFIG.RSI_PERIOD);
  const { smaValues, alignedValues } = calculateSMA(rsiVals, CONFIG.SMA_PERIOD);

  rsiHistory.length = 0;

  const rsiStartIndex = CONFIG.RSI_PERIOD;
  const smaStartInRsi = CONFIG.SMA_PERIOD - 1;

  for (let i = 0; i < smaValues.length; i++) {
    const rsiIndex = smaStartInRsi + i;
    const candleIndex = rsiStartIndex + rsiIndex;
    if (candleIndex < candles.length) {
      rsiHistory.push({
        time: candles[candleIndex].time,
        rsi: alignedValues[i],
        sma: smaValues[i],
      });
    }
  }

  if (smaValues.length >= 2) {
    prevSmaValue = smaValues[smaValues.length - 2];
    currentSmaValue = smaValues[smaValues.length - 1];
  } else if (smaValues.length === 1) {
    prevSmaValue = null;
    currentSmaValue = smaValues[0];
  }
}

// ==================== BYBIT REST — HISTORICAL DATA ====================

async function fetchHistoricalFromBybit(): Promise<CandleData[] | null> {
  try {
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${CONFIG.SYMBOL}&interval=${CONFIG.INTERVAL}&limit=${CONFIG.HISTORICAL_LIMIT}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;

    const json: any = await res.json();
    const list = json?.result?.list;
    if (!Array.isArray(list) || list.length === 0) return null;

    return list.reverse().map((item: any[]) => ({
      time: Math.floor(Number(item[0]) / 1000),
      open: parseFloat(String(item[1])),
      high: parseFloat(String(item[2])),
      low: parseFloat(String(item[3])),
      close: parseFloat(String(item[4])),
      volume: parseFloat(String(item[5])),
    }));
  } catch (error: any) {
    log('WARN', `Bybit REST failed: ${error.message}`);
    return null;
  }
}

async function fetchHistoricalFromBinance(): Promise<CandleData[] | null> {
  // Try futures first, then spot
  const urls = [
    `https://fapi.binance.com/fapi/v1/klines?symbol=${CONFIG.SYMBOL}&interval=3m&limit=${CONFIG.HISTORICAL_LIMIT}`,
    `https://api.binance.com/api/v3/klines?symbol=${CONFIG.SYMBOL}&interval=3m&limit=${CONFIG.HISTORICAL_LIMIT}`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;

      const data: any[][] = await res.json();
      if (!Array.isArray(data) || data.length === 0) continue;

      return data.map(item => ({
        time: Math.floor(Number(item[0]) / 1000),
        open: parseFloat(String(item[1])),
        high: parseFloat(String(item[2])),
        low: parseFloat(String(item[3])),
        close: parseFloat(String(item[4])),
        volume: parseFloat(String(item[5])),
      }));
    } catch {
      continue;
    }
  }
  return null;
}

async function loadHistoricalCandles(): Promise<void> {
  log('INFO', 'Loading historical candles...');

  // Try Bybit first (works on cloud!), then Binance fallback
  let data = await fetchHistoricalFromBybit();
  if (data) {
    dataStatus = 'bybit-rest';
    log('INFO', `Bybit REST: loaded ${data.length} candles`);
  } else {
    data = await fetchHistoricalFromBinance();
    if (data) {
      dataStatus = 'binance-rest';
      log('INFO', `Binance REST: loaded ${data.length} candles`);
    }
  }

  if (data && data.length > 0) {
    candles.length = 0;
    candles.push(...data);
    lastProcessedCandleTime = candles[candles.length - 1].time;
    recalculateIndicators();
    log('INFO', `Historical: ${candles.length} candles, ${rsiHistory.length} RSI points, current SMA=${currentSmaValue?.toFixed(2) || 'N/A'}`);
    lastDataTime = Date.now();
  } else {
    log('ERROR', 'All historical sources failed — will retry when WS connects');
  }
}

// ==================== BYBIT WEBSOCKET — REAL-TIME DATA ====================

function connectBybitWS(): void {
  if (bybitWs) {
    bybitWs.removeAllListeners();
    bybitWs.close();
    bybitWs = null;
  }

  log('INFO', 'Connecting to Bybit WebSocket...');
  const wsUrl = 'wss://stream.bybit.com/v5/public/linear';
  bybitWs = new WebSocket(wsUrl);

  bybitWs.on('open', () => {
    log('INFO', 'Bybit WS: Connected!');
    reconnectAttempts = 0;
    dataStatus = 'bybit-ws';
    lastDataTime = Date.now();

    // Subscribe to 3-minute kline for XAUUSDT
    const subscribeMsg = {
      op: 'subscribe',
      args: [`kline.${CONFIG.INTERVAL}.${CONFIG.SYMBOL}`],
    };
    bybitWs!.send(JSON.stringify(subscribeMsg));
    log('INFO', `Subscribed to kline.${CONFIG.INTERVAL}.${CONFIG.SYMBOL}`);
  });

  bybitWs.on('message', (raw: WebSocket.Data) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Bybit sends: { topic: "kline.3.XAUUSDT", data: { ... } }
      if (msg.topic && msg.topic.startsWith('kline.') && msg.data) {
        const d = msg.data;
        const candleTime = Math.floor(Number(d.start) / 1000);

        const candleData: CandleData = {
          time: candleTime,
          open: parseFloat(d.open),
          high: parseFloat(d.high),
          low: parseFloat(d.low),
          close: parseFloat(d.close),
          volume: parseFloat(d.volume),
        };

        const closed = d.confirm === true;
        lastDataTime = Date.now();

        // Update or add candle
        const existingIndex = candles.findIndex(c => c.time === candleTime);
        if (existingIndex >= 0) {
          candles[existingIndex] = candleData;
        } else {
          candles.push(candleData);
        }

        // On candle close, recalculate and check signals
        if (closed && candleTime !== lastProcessedCandleTime) {
          lastProcessedCandleTime = candleTime;
          onCandleClosed(candleData);
        }
      }

      // Handle ping/pong for connection keep-alive
      if (msg.op === 'ping') {
        bybitWs?.send(JSON.stringify({ op: 'pong' }));
      }
    } catch (error: any) {
      // Silently ignore parse errors for non-kline messages
    }
  });

  bybitWs.on('close', () => {
    log('WARN', 'Bybit WS: Disconnected');
    if (dataStatus === 'bybit-ws') dataStatus = 'connecting';
    scheduleReconnect();
  });

  bybitWs.on('error', (error: Error) => {
    log('ERROR', `Bybit WS: ${error.message}`);
    if (dataStatus === 'bybit-ws') dataStatus = 'connecting';
    scheduleReconnect();
  });

  // Bybit requires pong responses — also send periodic pings
  const pingInterval = setInterval(() => {
    if (bybitWs && bybitWs.readyState === WebSocket.OPEN) {
      bybitWs.send(JSON.stringify({ op: 'ping' }));
    } else {
      clearInterval(pingInterval);
    }
  }, 20000);
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectAttempts++;
  const delay = Math.min(3000 * Math.pow(1.5, reconnectAttempts - 1), 60000);

  log('INFO', `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);

  reconnectTimer = setTimeout(() => {
    connectBybitWS();
  }, delay);
}

// ==================== SIGNAL DETECTION ====================

function onCandleClosed(candle: CandleData): void {
  log('INFO', `Candle closed @ ${candle.close} | time: ${candle.time}`);

  recalculateIndicators();

  if (rsiHistory.length === 0) {
    log('WARN', 'Not enough data for RSI calculation yet');
    return;
  }

  const latestRSI = rsiHistory[rsiHistory.length - 1];
  log('INFO', `RSI=${latestRSI.rsi.toFixed(2)} SMA=${latestRSI.sma.toFixed(2)} | prevSMA=${prevSmaValue?.toFixed(2) || 'N/A'} currSMA=${currentSmaValue?.toFixed(2) || 'N/A'}`);

  if (prevSmaValue === null || currentSmaValue === null) return;

  // BUY SIGNAL: SMA crosses above 30
  if (prevSmaValue < CONFIG.BUY_THRESHOLD && currentSmaValue >= CONFIG.BUY_THRESHOLD) {
    log('TRADE', `*** BUY SIGNAL! SMA crossed above ${CONFIG.BUY_THRESHOLD}: ${prevSmaValue.toFixed(2)} → ${currentSmaValue.toFixed(2)} ***`);
    handleSignal('BUY', candle.close, latestRSI.rsi, currentSmaValue);
  }

  // SELL SIGNAL: SMA crosses below 70
  if (prevSmaValue > CONFIG.SELL_THRESHOLD && currentSmaValue <= CONFIG.SELL_THRESHOLD) {
    log('TRADE', `*** SELL SIGNAL! SMA crossed below ${CONFIG.SELL_THRESHOLD}: ${prevSmaValue.toFixed(2)} → ${currentSmaValue.toFixed(2)} ***`);
    handleSignal('SELL', candle.close, latestRSI.rsi, currentSmaValue);
  }
}

async function handleSignal(type: 'BUY' | 'SELL', price: number, rsi: number, sma: number): Promise<void> {
  const signal: SignalRecord = {
    id: generateId(),
    type,
    time: Math.floor(Date.now() / 1000),
    price,
    rsi: Math.round(rsi * 100) / 100,
    sma: Math.round(sma * 100) / 100,
    autoTraded: false,
  };

  // Send Telegram notification immediately (signal detected)
  const emoji = type === 'BUY' ? '🟢' : '🔴';
  sendTelegram(
    `${emoji} <b>${type} SIGNAL</b>\n` +
    `Price: $${price.toFixed(2)}\n` +
    `RSI(1): ${rsi.toFixed(2)}\n` +
    `SMA(14): ${sma.toFixed(2)}\n` +
    `${isBotPaused ? '⚠️ Bot is PAUSED — no auto-trade' : '🔄 Auto-trading...'}`
  ).catch(() => {});

  // Auto-trade if not paused
  if (!isBotPaused) {
    try {
      if (type === 'BUY') {
        const result = await autoBuy(price);
        signal.autoTraded = true;
        signal.orderId = result?.order_id;
      } else if (type === 'SELL') {
        const result = await autoSell(price);
        signal.autoTraded = true;
        signal.orderId = result?.order_id;
      }
    } catch (error: any) {
      signal.autoTraded = false;
      signal.error = error.message;
      log('ERROR', `Auto-trade ${type} failed: ${error.message}`);
      sendTelegram(`❌ Auto-trade ${type} FAILED: ${error.message}`).catch(() => {});
    }
  }

  // Log signal
  signalLog.push(signal);
  if (signalLog.length > 20) signalLog.splice(0, signalLog.length - 20);

  // Send trade result notification
  if (signal.autoTraded) {
    const tradeEmoji = type === 'BUY' ? '✅' : '✅';
    sendTelegram(
      `${tradeEmoji} <b>${type} ORDER PLACED</b>\n` +
      `Order ID: ${signal.orderId || 'N/A'}\n` +
      `Price: $${price.toFixed(2)}\n` +
      `Leverage: ${CONFIG.LEVERAGE}x | Qty: ${CONFIG.QUANTITY}`
    ).catch(() => {});
  }
}

// ==================== MUDREX API ====================

async function mudrexRequest(endpoint: string, method: string = 'GET', body?: any): Promise<any> {
  if (!CONFIG.MUDREX_API_KEY) throw new Error('Mudrex API key not set');

  const url = `${CONFIG.MUDREX_BASE}${endpoint}`;
  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Authentication': CONFIG.MUDREX_API_KEY,
    },
  };

  if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);
  const data = await response.json();

  if (!data.success) {
    throw new Error(data.message || data.error || 'Mudrex API error');
  }

  return data.data;
}

async function mudrexGetPositions(): Promise<Position[]> {
  try {
    const data = await mudrexRequest('/fapi/v1/futures/positions');
    return data || [];
  } catch (error: any) {
    log('ERROR', `Get positions failed: ${error.message}`);
    return [];
  }
}

async function mudrexGetFunds(): Promise<{ balance: string; locked_amount: string }> {
  return await mudrexRequest('/fapi/v1/futures/funds');
}

async function mudrexPlaceOrder(params: {
  symbol: string;
  leverage: number;
  quantity: number;
  order_price: number;
  order_type: 'LONG' | 'SHORT';
  trigger_type: 'MARKET' | 'LIMIT';
  is_stoploss?: boolean;
  stoploss_price?: number;
  is_takeprofit?: boolean;
  takeprofit_price?: number;
  reduce_only?: boolean;
}): Promise<any> {
  const { symbol, ...body } = params;
  const endpoint = `/fapi/v1/futures/${symbol}/order`;
  return await mudrexRequest(endpoint, 'POST', body);
}

// ==================== AUTO-TRADE LOGIC ====================

async function autoBuy(price: number): Promise<any> {
  // Check if already in a LONG position
  const positions = await mudrexGetPositions();
  const existingLong = positions.find(
    (p: Position) => p.symbol === CONFIG.SYMBOL && p.order_type === 'LONG' && p.status === 'OPEN'
  );

  if (existingLong) {
    log('WARN', 'Already in LONG position — skipping BUY');
    return null;
  }

  const quantity = CONFIG.QUANTITY;
  const slPrice = Math.round(price * (1 - CONFIG.STOP_LOSS_PCT / 100) * 100) / 100;
  const tpPrice = Math.round(price * (1 + CONFIG.TAKE_PROFIT_PCT / 100) * 100) / 100;

  log('TRADE', `Placing LONG: qty=${quantity}, price=${price}, SL=${slPrice}, TP=${tpPrice}`);

  const result = await mudrexPlaceOrder({
    symbol: CONFIG.SYMBOL,
    leverage: CONFIG.LEVERAGE,
    quantity,
    order_price: price,
    order_type: 'LONG',
    trigger_type: 'MARKET',
    is_stoploss: true,
    stoploss_price: slPrice,
    is_takeprofit: true,
    takeprofit_price: tpPrice,
    reduce_only: false,
  });

  log('TRADE', `LONG order placed: ${result?.order_id}`);
  return result;
}

async function autoSell(price: number): Promise<any> {
  // Check for existing LONG position to close
  const positions = await mudrexGetPositions();
  const existingLong = positions.find(
    (p: Position) => p.symbol === CONFIG.SYMBOL && p.order_type === 'LONG' && p.status === 'OPEN'
  );

  if (!existingLong) {
    log('WARN', 'No LONG position to close — skipping SELL');
    return null;
  }

  const quantity = parseFloat(existingLong.quantity);
  const leverage = parseFloat(existingLong.leverage);

  log('TRADE', `Closing LONG: qty=${quantity}, price=${price}`);

  const result = await mudrexPlaceOrder({
    symbol: CONFIG.SYMBOL,
    leverage,
    quantity,
    order_price: price,
    order_type: 'SHORT',
    trigger_type: 'MARKET',
    reduce_only: true,
  });

  log('TRADE', `LONG closed: ${result?.order_id}`);
  return result;
}

// ==================== HTTP SERVER (HEALTH + STATUS) ====================

const httpServer = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${CONFIG.PORT}`);

  // Health check — for UptimeRobot
  if (url.pathname === '/health' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'alive',
      uptime: Math.floor((Date.now() - botStartTime) / 1000),
      dataSource: dataStatus,
      lastDataAgo: lastDataTime ? Math.floor((Date.now() - lastDataTime) / 1000) : -1,
      candles: candles.length,
      rsiPoints: rsiHistory.length,
      currentSMA: currentSmaValue?.toFixed(2) || null,
      currentRSI: rsiHistory.length > 0 ? rsiHistory[rsiHistory.length - 1].rsi.toFixed(2) : null,
      latestPrice: candles.length > 0 ? candles[candles.length - 1].close : null,
      botPaused: isBotPaused,
      signals: signalLog.length,
    }));
    return;
  }

  // Status page — simple HTML
  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const latestPrice = candles.length > 0 ? candles[candles.length - 1].close : 'N/A';
    const latestRSI = rsiHistory.length > 0 ? rsiHistory[rsiHistory.length - 1] : null;
    const lastDataAgo = lastDataTime ? Math.floor((Date.now() - lastDataTime) / 1000) : -1;

    res.end(`<!DOCTYPE html>
<html><head><title>XAUUSDT Trading Bot</title>
<style>
  body { font-family: monospace; background: #0a0e17; color: #e2e8f0; padding: 20px; max-width: 800px; margin: 0 auto; }
  h1 { color: #f59e0b; border-bottom: 1px solid #1e293b; padding-bottom: 10px; }
  .card { background: #111827; border: 1px solid #1e293b; border-radius: 8px; padding: 16px; margin: 12px 0; }
  .label { color: #9ca3af; font-size: 12px; text-transform: uppercase; }
  .value { color: #f1f5f9; font-size: 18px; font-weight: bold; }
  .green { color: #22c55e; } .red { color: #ef4444; } .yellow { color: #f59e0b; } .purple { color: #a855f7; }
  .signal { padding: 8px 12px; margin: 4px 0; border-radius: 4px; font-size: 13px; }
  .signal.buy { background: #052e16; border-left: 3px solid #22c55e; }
  .signal.sell { background: #2e0505; border-left: 3px solid #ef4444; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; }
  .badge.live { background: #052e16; color: #22c55e; }
  .badge.error { background: #2e0505; color: #ef4444; }
  .badge.paused { background: #422006; color: #f59e0b; }
</style>
<meta http-equiv="refresh" content="15">
</head><body>
<h1>XAUUSDT Trading Bot v2.0</h1>
<div class="card">
  <div class="label">Status</div>
  <div class="value">
    <span class="badge ${dataStatus === 'bybit-ws' ? 'live' : dataStatus === 'error' ? 'error' : 'paused'}">${dataStatus.toUpperCase()}</span>
    ${isBotPaused ? '<span class="badge paused">PAUSED</span>' : '<span class="badge live">TRADING</span>'}
  </div>
  <div style="margin-top:8px">
    <span class="label">Uptime:</span> ${Math.floor((Date.now() - botStartTime) / 3600000)}h ${Math.floor(((Date.now() - botStartTime) % 3600000) / 60000)}m |
    <span class="label">Last data:</span> ${lastDataAgo >= 0 ? lastDataAgo + 's ago' : 'N/A'} |
    <span class="label">Candles:</span> ${candles.length} |
    <span class="label">RSI points:</span> ${rsiHistory.length}
  </div>
</div>
<div class="card">
  <div class="label">Current Price</div>
  <div class="value yellow">$${latestPrice}</div>
  <div style="margin-top:8px">
    <span class="label">RSI(1):</span> <span class="purple">${latestRSI?.rsi.toFixed(2) || 'N/A'}</span> |
    <span class="label">SMA(14):</span> <span class="yellow">${latestRSI?.sma.toFixed(2) || 'N/A'}</span>
  </div>
  <div style="margin-top:4px">
    <span class="label">Strategy:</span> Buy when SMA crosses above ${CONFIG.BUY_THRESHOLD} | Sell when SMA crosses below ${CONFIG.SELL_THRESHOLD}
  </div>
</div>
<div class="card">
  <div class="label">Config</div>
  <div>Leverage: ${CONFIG.LEVERAGE}x | Quantity: ${CONFIG.QUANTITY} | SL: ${CONFIG.STOP_LOSS_PCT}% | TP: ${CONFIG.TAKE_PROFIT_PCT}%</div>
</div>
<div class="card">
  <div class="label">Recent Signals</div>
  ${signalLog.slice(-5).reverse().map(s => `
    <div class="signal ${s.type.toLowerCase()}">
      <strong>${s.type}</strong> @ $${s.price.toFixed(2)} | RSI: ${s.rsi.toFixed(1)} | SMA: ${s.sma.toFixed(1)}
      ${s.autoTraded ? '✅ Auto-traded' : '⏸ Not traded'} ${s.orderId ? `(Order: ${s.orderId})` : ''}
      ${s.error ? `❌ ${s.error}` : ''}
      <span style="color:#6b7280;float:right">${new Date(s.time * 1000).toISOString().slice(11, 19)}</span>
    </div>
  `).join('') || '<div style="color:#6b7280">No signals yet</div>'}
</div>
</body></html>`);
    return;
  }

  // Pause/resume bot
  if (url.pathname === '/pause') {
    isBotPaused = true;
    log('TRADE', 'Bot PAUSED');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ paused: true }));
    return;
  }

  if (url.pathname === '/resume') {
    isBotPaused = false;
    log('TRADE', 'Bot RESUMED');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ paused: false }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// ==================== STARTUP ====================

async function start(): Promise<void> {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   XAUUSDT Trading Bot v2.0 — Standalone     ║');
  console.log('║   Strategy: RSI(1) + SMA(14)                ║');
  console.log(`║   BUY:  SMA crosses above ${CONFIG.BUY_THRESHOLD}              ║`);
  console.log(`║   SELL: SMA crosses below ${CONFIG.SELL_THRESHOLD}             ║`);
  console.log('║   Data: Bybit WS (cloud-friendly!)          ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  // Load historical data
  await loadHistoricalCandles();

  // Connect to Bybit WS for real-time data
  connectBybitWS();

  // Start HTTP server
  httpServer.listen(CONFIG.PORT, '0.0.0.0', () => {
    log('INFO', `Server running on port ${CONFIG.PORT}`);
    log('INFO', `Health: http://localhost:${CONFIG.PORT}/health`);
    log('INFO', `Status: http://localhost:${CONFIG.PORT}/status`);
    log('INFO', `Pause:  http://localhost:${CONFIG.PORT}/pause`);
    log('INFO', `Resume: http://localhost:${CONFIG.PORT}/resume`);
  });

  // Startup notification
  sendTelegram(
    '🤖 <b>XAUUSDT Trading Bot Started</b>\n' +
    `Strategy: RSI(1) + SMA(14)\n` +
    `Buy above SMA ${CONFIG.BUY_THRESHOLD} | Sell below SMA ${CONFIG.SELL_THRESHOLD}\n` +
    `Leverage: ${CONFIG.LEVERAGE}x | Qty: ${CONFIG.QUANTITY}\n` +
    `SL: ${CONFIG.STOP_LOSS_PCT}% | TP: ${CONFIG.TAKE_PROFIT_PCT}%`
  ).catch(() => {});

  // Periodic status log every 5 minutes
  setInterval(() => {
    const latestRSI = rsiHistory.length > 0 ? rsiHistory[rsiHistory.length - 1] : null;
    const latestPrice = candles.length > 0 ? candles[candles.length - 1].close : 'N/A';
    const lastDataAgo = lastDataTime ? Math.floor((Date.now() - lastDataTime) / 1000) : -1;

    log('INFO',
      `Status: data=${dataStatus} | price=${latestPrice} | RSI=${latestRSI?.rsi.toFixed(2) || 'N/A'} | SMA=${latestRSI?.sma.toFixed(2) || 'N/A'} | lastData=${lastDataAgo}s ago | signals=${signalLog.length}`
    );

    // If no data for 2 minutes, try to reconnect
    if (lastDataAgo > 120) {
      log('WARN', 'No data for 2+ minutes — reconnecting Bybit WS...');
      connectBybitWS();
    }
  }, 300000);

  // Refresh historical candles every 30 minutes
  setInterval(() => {
    log('INFO', 'Refreshing historical candles...');
    loadHistoricalCandles().catch(e => log('ERROR', `Historical refresh failed: ${e.message}`));
  }, 1800000);

  // Verify Mudrex connection on startup
  setTimeout(async () => {
    try {
      const funds = await mudrexGetFunds();
      log('INFO', `Mudrex connected — Balance: $${funds.balance} | Locked: $${funds.locked_amount}`);
    } catch (e: any) {
      log('WARN', `Mudrex connection issue: ${e.message}`);
    }

    try {
      const positions = await mudrexGetPositions();
      if (positions.length > 0) {
        log('INFO', `Open positions: ${positions.length}`);
        for (const p of positions) {
          log('INFO', `  ${p.order_type} ${p.symbol} qty=${p.quantity} entry=${p.entry_price} SL=${p.stoploss?.price || 'none'} TP=${p.takeprofit?.price || 'none'}`);
        }
      } else {
        log('INFO', 'No open positions');
      }
    } catch (e: any) {
      log('WARN', `Could not check positions: ${e.message}`);
    }
  }, 2000);
}

start().catch((error) => {
  log('ERROR', `Fatal startup error: ${error.message}`);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('INFO', 'SIGTERM received — shutting down');
  if (bybitWs) bybitWs.close();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  httpServer.close(() => process.exit(0));
  sendTelegram('⚠️ Trading Bot shutting down (SIGTERM)').catch(() => {});
});

process.on('SIGINT', () => {
  log('INFO', 'SIGINT received — shutting down');
  if (bybitWs) bybitWs.close();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  httpServer.close(() => process.exit(0));
  sendTelegram('⚠️ Trading Bot shutting down (SIGINT)').catch(() => {});
});
