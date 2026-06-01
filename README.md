# XAUUSDT Trading Bot v2.0

**Standalone 24/7 auto-trading bot** — No dashboard, just trades.

## Strategy
- **RSI(1) + SMA(14)** on 3-minute candles
- **BUY LONG** when SMA crosses above 30
- **SELL (close LONG)** when SMA crosses below 70

## Data Source
- **Primary**: Bybit WebSocket (works on cloud servers!)
- **Fallback**: Bybit REST → Binance REST for historical data

## Trading
- **Mudrex Futures API** for order execution
- Leverage: 100x | Quantity: 0.002 | SL: 0.5% | TP: 1.0%

## Notifications
- **Telegram** alerts for signals and trades (optional)

## Endpoints
| Path | Description |
|------|-------------|
| `/health` | JSON health check (for UptimeRobot) |
| `/status` | HTML status page |
| `/pause` | Pause auto-trading |
| `/resume` | Resume auto-trading |

## Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3003 | Server port |
| `MUDREX_API_KEY` | (set) | Mudrex API key |
| `LEVERAGE` | 100 | Trade leverage |
| `QUANTITY` | 0.002 | Trade quantity |
| `STOP_LOSS_PCT` | 0.5 | Stop loss % |
| `TAKE_PROFIT_PCT` | 1.0 | Take profit % |
| `TELEGRAM_BOT_TOKEN` | (empty) | Telegram bot token |
| `TELEGRAM_CHAT_ID` | (empty) | Telegram chat ID |

## Deploy on Render
1. Push this repo to GitHub
2. Create a new **Web Service** on Render
3. Set build command: `npm install`
4. Set start command: `npx bun index.ts`
5. Add environment variables
6. Set up UptimeRobot to ping `/health` every 5 minutes (keeps free tier alive)

## Telegram Setup (Optional)
1. Message @BotFather on Telegram → Create a bot → Get token
2. Message @userinfobot → Get your chat ID
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` env vars on Render
