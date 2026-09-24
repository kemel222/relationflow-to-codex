# RelationFlow OpenAI-Compatible Proxy

Прокси-сервер, реализующий спецификацию OpenAI API (`/v1/chat/completions`) поверх сервиса RelationFlow с автоматическим управлением жизненным циклом сессии Supabase Auth.

## Возможности

- **OpenAI-совместимость**: Поддержка эндпоинта `/v1/chat/completions` для использования с официальными SDK OpenAI, LangChain, curl и другими клиентами.
- **Два режима ответа**:
  - `stream: true`: Поток Server-Sent Events (SSE) с чанками `chat.completion.chunk` и финальным `data: [DONE]`.
  - `stream: false`: Агрегация всего потока ответа в единый JSON-объект `chat.completion`.
- **Автоматический рефреш Supabase Auth**:
  - Автоматическое обновление токена перед истечением срока жизни (`POST /auth/v1/token?grant_type=refresh_token`).
  - Сохранение и ротация `refresh_token` на диске (`tokens.json`).
  - Передача сессионных `Cookie` и `Authorization: Bearer <access_token>` в RelationFlow.
  - Защита от состояния гонки (in-flight promise mutex) при параллельных запросах.

## Структура проекта

- `src/proxy.ts` — HTTP-сервер Express, роутинг OpenAI API и адаптер потока.
- `src/token-manager.ts` — Менеджер токенов Supabase с ротацией и файловым сохранением.
- `src/mock-upstream.ts` — Mock-серверы Supabase Auth и RelationFlow для автономного тестирования.
- `test/proxy.test.ts` — End-to-end тесты всех сценариев схемы.

## Запуск тестов

```bash
npm test
```

## Запуск сервиса

```bash
npm start
```
