/# Настройка синхронизации: CouchDB + Obsidian LiveSync

Пошаговая инструкция для синхронизации Obsidian vault между устройствами (MacBook, iPhone) через self-hosted CouchDB.

**Стоимость**: бесплатно (LiveSync — open-source плагин)
**Что нужно**: CouchDB (уже в docker-compose), плагин LiveSync в Obsidian

---

## Архитектура

```
iPhone Obsidian ←LiveSync→ CouchDB (Docker :5984) ←LiveSync→ MacBook Obsidian
                                     ↑
                            ./vault (volume mount)
                                     ↑
                            Telegram Bot пишет .md файлы
```

- Бот пишет .md файлы в `./vault` → LiveSync на MacBook подхватывает → CouchDB → iPhone видит заметки
- CouchDB хранит **копию** для синхронизации, оригинал — .md файлы

---

## Шаг 1: Поменять пароль CouchDB

1. Открыть файл `.env` в проекте
2. Добавить/изменить:
   ```
   COUCHDB_USER=admin
   COUCHDB_PASSWORD=<твой_надёжный_пароль>
   ```
3. Пересоздать контейнеры:
   ```bash
   cd nomad-brain
   docker compose down
   docker compose up -d
   ```

---

## Шаг 2: Настроить CouchDB (выполнить в терминале)

Заменить `ПАРОЛЬ` на свой пароль из `.env`.

### 2.1 Проверить что CouchDB работает
```bash
curl http://admin:ПАРОЛЬ@localhost:5984/
```
Ответ должен быть JSON с `"couchdb":"Welcome"`.

### 2.2 Создать базу данных
```bash
curl -X PUT http://admin:ПАРОЛЬ@localhost:5984/obsidian-livesync
```
Ответ: `{"ok":true}`

### 2.3 Включить CORS
```bash
curl -X PUT http://admin:ПАРОЛЬ@localhost:5984/_node/_local/_config/httpd/enable_cors \
  -d '"true"'

curl -X PUT http://admin:ПАРОЛЬ@localhost:5984/_node/_local/_config/cors/origins \
  -d '"app://obsidian.md,capacitor://localhost,http://localhost"'

curl -X PUT http://admin:ПАРОЛЬ@localhost:5984/_node/_local/_config/cors/credentials \
  -d '"true"'

curl -X PUT http://admin:ПАРОЛЬ@localhost:5984/_node/_local/_config/cors/headers \
  -d '"accept, authorization, content-type, origin, referer"'

curl -X PUT http://admin:ПАРОЛЬ@localhost:5984/_node/_local/_config/cors/methods \
  -d '"GET, PUT, POST, HEAD, DELETE"'
```

### 2.4 Увеличить лимиты (для больших заметок и вложений)
```bash
curl -X PUT http://admin:ПАРОЛЬ@localhost:5984/_node/_local/_config/couchdb/max_document_size \
  -d '"50000000"'

curl -X PUT http://admin:ПАРОЛЬ@localhost:5984/_node/_local/_config/httpd/max_http_request_size \
  -d '"4294967296"'
```

### 2.5 Проверить что всё настроено
```bash
curl http://admin:ПАРОЛЬ@localhost:5984/obsidian-livesync
```
Ответ должен содержать `"db_name":"obsidian-livesync"`.

---

## Шаг 3: Установить LiveSync плагин в Obsidian (MacBook)

1. Открыть Obsidian
2. **Settings** (⚙️) → **Community plugins**
3. Нажать **Browse**
4. В поиске набрать: `Self-hosted LiveSync`
5. Нажать **Install**, затем **Enable**
6. Вернуться в Settings → в левом меню появится **Self-hosted LiveSync**

---

## Шаг 4: Подключить LiveSync к CouchDB (MacBook)

1. Settings → **Self-hosted LiveSync**
2. Вкладка **Remote Database Configuration**:
   - **URI**: `http://localhost:5984`
   - **Username**: `admin`
   - **Password**: твой пароль
   - **Database name**: `obsidian-livesync`
3. Нажать **Test Database Connection**
   - Должно показать зелёную галочку ✓
   - Если ошибка — проверь что CouchDB запущен (`docker compose ps`)
4. Если предложит **Check and Fix** — нажми, плагин автоматически починит конфигурацию БД

---

## Шаг 5: Выбрать режим синхронизации

В настройках LiveSync → **Sync Settings**:

| Режим | Описание | Рекомендация |
|-------|----------|-------------|
| **LiveSync** | Real-time, изменения видны через 1-2 сек | Рекомендую |
| Periodic | Каждые N секунд | Экономит батарею на телефоне |
| On Startup/Close | Только при открытии/закрытии | Минимум трафика |

Выбери **LiveSync** для максимальной актуальности.

---

## Шаг 6: Первая синхронизация (MacBook → CouchDB)

1. Settings → Self-hosted LiveSync → **Hatch** (или **Setup**)
2. Нажать **Rebuild Everything**
3. Выбрать **Send** — это отправит весь vault в CouchDB
4. Подождать пока завершится (прогресс в статусбаре)

---

## Шаг 7: Установить на iPhone

### 7.1 Установить Obsidian на iPhone
App Store → Obsidian → Install

### 7.2 Создать пустой vault
Открыть Obsidian → Create new vault (назвать "Nomad Brain" или как угодно)

### 7.3 Установить LiveSync плагин
Settings → Community plugins → Browse → "Self-hosted LiveSync" → Install → Enable

### 7.4 Подключить к CouchDB
Settings → Self-hosted LiveSync → Remote Database Configuration:
- **URI**: `http://<IP_ТВОЕГО_МАКА>:5984`
  - Узнать IP мака: System Settings → Wi-Fi → Details → IP Address
  - Пример: `http://192.168.1.42:5984`
- **Username**: `admin`
- **Password**: твой пароль
- **Database name**: `obsidian-livesync`

### 7.5 Получить данные из CouchDB
1. Rebuild Everything → **Receive**
2. Подождать — vault синхронизируется с MacBook

---

## Шаг 8: Проверить синхронизацию

1. На MacBook создай заметку в Obsidian
2. Через 1-2 секунды она должна появиться на iPhone
3. Отправь сообщение боту в Telegram
4. Бот создаст .md файл → LiveSync подхватит → появится на iPhone

---

## Доступ с iPhone вне домашней сети

Если MacBook и iPhone в **одной Wi-Fi сети** — всё работает через локальный IP.

Для доступа **извне** (из кафе, коворкинга, другой страны):

### Вариант A: Tailscale (проще всего)
1. Установить [Tailscale](https://tailscale.com) на MacBook и iPhone (бесплатно для личного использования)
2. Оба устройства получат адреса вида `100.x.x.x`
3. В LiveSync на iPhone указать `http://100.x.x.x:5984`

### Вариант B: Reverse proxy + домен
1. Бесплатный домен: [duckdns.org](https://duckdns.org)
2. Установить Caddy как reverse proxy:
   ```
   nomad-brain.duckdns.org {
     reverse_proxy localhost:5984
   }
   ```
3. В LiveSync указать `https://nomad-brain.duckdns.org`

### Вариант C: Развернуть на VPS
Перенести docker-compose на VPS ($5-10/мес), CouchDB доступен по публичному IP.

---

## Troubleshooting

| Проблема | Решение |
|----------|---------|
| Test Connection fails | Проверь `docker compose ps`, CouchDB должен быть Running |
| CORS error | Перевыполни команды из шага 2.3 |
| Sync медленный | Проверь сеть, или переключись на Periodic sync |
| Конфликт файлов | LiveSync покажет diff — выбери нужную версию |
| iPhone не видит сервер | Проверь что оба устройства в одной сети, или используй Tailscale |
