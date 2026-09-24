# 🚀 RelationFlow & Logicc to VS Code / Codex Proxy (Claude Opus 5.5)

Универсальный локальный прокси-сервер, превращающий ваши аккаунты в корпоративных AI-платформах **RelationFlow** и **Logicc.com** в стандартный **OpenAI-совместимый API** (`http://localhost:3000/v1`).

Позволяет использовать флагманские модели **Claude Opus 5.5** (с поддержкой до **1 000 000 токенов**) в **VS Code (Continue)**, **Codex / ChatGPT Desktop**, Cursor и любых других инструментах разработчика **без расхода платных лимитов OpenAI**.

---

## 🌟 Ключевые возможности

1. **Два мощных провайдера в одном прокси**:
   - **RelationFlow**: `managed:claude-opus-5.5` с поддержкой шифрованных вложений.
   - **Logicc.com**: `claude-5.5-opus` с Vercel AI SDK v6 стримингом.
2. **Полная совместимость с OpenAI API**:
   - Эндпоинты `/v1/chat/completions` (со стримингом SSE и без него) и `/v1/models`.
3. **Память и непрерывность диалога (Thread Persistence)**:
   - Модель **не забывает контекст** между сообщениями. Запросы привязываются к постоянному треду.
   - Хотите чистый лист? Одно нажатие сбрасывает тред (`/v1/thread/new`).
4. **Поддержка файлов до 1 000 000 токенов**:
   - В вебе RelationFlow стоит ограничение 10 000 символов на текстовое сообщение.
   - Прокси автоматически определяет большие файлы/запросы (>7 500 символов), шифрует их на лету (AES-GCM Framing `CLM1`), загружает в хранилище вложений и передает модели целиком.
5. **Вечные сессии и авто-рефреш**:
   - **Supabase Auth (RelationFlow)**: автоматическая ротация `refresh_token` и пересборка сессионных кук.
   - **Clerk Auth (Logicc.com)**: фоновый вызов `/touch` с долгоживущим токеном `__client` (обновляет 60-секундный JWT каждые 50 секунд).

---

## 📋 Требования

- **Node.js** версии **20.x, 22.x или выше** (проверить: `node -v`).
- Аккаунт в [RelationFlow](https://app.relationflow.io) и/или [Logicc.com](https://app.logicc.com).
- **VS Code** с расширением **Continue** (или любой другой клиент с поддержкой OpenAI API).

---

## 🛠️ Быстрый старт

### 1. Клонирование и установка

```bash
git clone git@github.com:kemel222/relationflow-to-codex.git
cd relationflow-to-codex
npm install
```

### 2. Настройка `.env`

Скопируйте пример:
```bash
cp .env.example .env
```

Заполните учетные данные:
* **Для RelationFlow:**
  - `ACCOUNT_SLUG`: слаг из адреса чата (`/dashboard/<accountSlug>/chat`).
  - `INITIAL_REFRESH_TOKEN`: токен из куки `sb-auth-auth-token.0`.
* **Для Logicc.com:**
  - `LOGICC_SESSION_ID`: из запроса `/touch` в DevTools (`sess_...`).
  - `LOGICC_ORG_ID`: из формы запроса `/touch` (`org_...`).
  - `LOGICC_CLIENT_COOKIE`: куки `__client=...; __client_uat=...`.
  - `LOGICC_CHAT_ID`: ID чата из URL.

### 3. Запуск сервера

```bash
npm start
```

Вы увидите:
```text
[Proxy] Logicc provider enabled with Clerk session touch auto-renewal.
[RelationFlow & Logicc Proxy] Listening on http://localhost:3000
OpenAI API compatible endpoint: http://localhost:3000/v1/chat/completions
```

---

## 💻 Настройка в VS Code (Continue)

В файле конфигурации Continue (`~/.continue/config.yaml`):

```yaml
models:
  - name: RelationFlow (Opus 5.5)
    provider: openai
    model: claude-opus-5.5
    apiBase: http://localhost:3000/v1
    apiKey: dummy
    contextLength: 1000000

  - name: Logicc (Opus 5.5)
    provider: openai
    model: logicc-opus
    apiBase: http://localhost:3000/v1
    apiKey: dummy
    contextLength: 1000000
```

Теперь в списке моделей Continue у вас доступны **обе платформы**:
* Выбираете **`RelationFlow (Opus 5.5)`** ➡️ запросы идут через RelationFlow.
* Выбираете **`Logicc (Opus 5.5)`** ➡️ запросы идут через Logicc.

---

## 📄 Лицензия
MIT
