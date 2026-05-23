# Myra WhatsApp Bot

A production-grade backend service connecting WhatsApp Business API to Myra AI.

## Features

- 📱 WhatsApp Business API integration
- 🤖 Myra AI WebSocket connection
- 🎠 Fake carousel with navigation
- 📋 Multi-step booking flow
- 🛡️ Guardrails for AI responses
- 💾 Session management with TTL
- 🧠 Smart routing: Travel queries → Myra, Non-travel → Gemini
- 🤖 Gemini AI integration for non-travel conversations

## Quick Start

### 1. Install Dependencies

```bash
cd myra-whatsapp-bot
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Run the Server

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `WA_PHONE_NUMBER_ID` | WhatsApp Business phone number ID |
| `WA_ACCESS_TOKEN` | WhatsApp Cloud API access token |
| `WA_VERIFY_TOKEN` | Webhook verification token |
| `MYRA_WS_URL` | Myra WebSocket URL |
| `MYRA_DEVICE_ID` | Myra device ID |
| `MYRA_SESSION_ID` | Myra session ID |
| `GENAI_API_KEY` | Google Gemini API key (for non-travel responses & comparisons) |
| `GENAI_MODEL` | Gemini model (default: gemini-1.5-flash) |
| `GENAI_COMPARISON_ENABLED` | Enable AI comparisons (default: true) |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/webhook` | WhatsApp verification |
| POST | `/webhook` | WhatsApp messages |
| POST | `/test/message` | Test endpoint (dev only) |

## Testing Locally

```bash
# Health check
curl http://localhost:3000/health

# Simulate text message
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"from": "919876543210", "text": "hello myra"}'

# Simulate button click
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"from": "919876543210", "buttonId": "carousel_next"}'
```

## Project Structure

```
src/
├── config/index.js       # Environment config
├── utils/logger.js       # Winston logger
├── session/              # Session management
├── whatsapp/             # WhatsApp integration
├── myra/                 # Myra AI client
├── genai/                # AI comparison layer (Gemini)
├── logic/                # Business logic
├── routes/webhook.js     # Express routes
└── app.js                # Entry point
```

## License

ISC
