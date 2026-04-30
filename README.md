# 🧠 Nomad Brain

**Персональный Telegram-бот для PKM (Personal Knowledge Management) с интеграцией Obsidian.**

Отправь сообщение в Telegram — бот классифицирует его с помощью AI, предложит теги и сохранит как структурированную Markdown-заметку в Obsidian vault. Текст, голос, фото, ссылки, контакты, задачи — все в одном месте.

---

## 📋 Возможности

### Типы входящих сообщений

| Вход | Что делает бот |
|---|---|
| **Текст** | AI определяет тип (заметка, задача, контакт, событие, ссылка), предлагает теги и сферу жизни |
| **Голосовое сообщение** | Транскрипция через OpenAI Whisper → обработка как текст |
| **Голосовая команда** | Распознает команды вида "добавить заметку философия ..." — тип и сфера задаются голосом |
| **Ссылка** | Создает заметку типа `link`, автоматически получает заголовок страницы |
| **Несколько ссылок** | Batch-обработка: каждая ссылка сохраняется отдельным файлом |
| **Фото** | Сохраняет изображение в `attachments/` с embed-ссылкой `![[image]]` |
| **Фото + подпись** | Фото сохраняется, подпись проходит AI-классификацию |
| **Пересланное сообщение** | Сохраняется с атрибуцией источника (канал, пользователь, группа) |
| **Контакт** (`/contact`) | Интерактивный wizard: имя → телефон → соцсети → контекст знакомства |

### AI-классификация

Каждое сообщение обрабатывается через GPT/Claude, который возвращает:

- **Тип** — `note`, `link`, `task`, `task_list`, `contact`, `event`
- **Заголовок** — короткий русскоязычный заголовок (3-8 слов)
- **Теги** — 2-5 тегов из существующей таксономии vault + новые при необходимости
- **Сфера жизни** — одна из 8 предопределенных областей
- **Дополнительные данные** — дедлайн, приоритет, рекуррентность (для задач), контактные данные, информация о событиях

AI учитывает контекст: читает существующие теги из последних 30 заметок и заголовки файлов для предложения `[[wikilinks]]`.

### Интерактивная работа с тегами

Для заметок, ссылок и событий бот показывает inline-клавиатуру:

- Переключение тегов (выбрать/убрать)
- Добавление пользовательского тега
- **Quick Save** — сохранить с текущими тегами
- **Save** — сохранить после редактирования

Задачи, списки задач и контакты сохраняются автоматически без клавиатуры.

### Дополнительные функции

- **Reply-append** — ответ на подтверждение бота дописывает текст в последнюю сохраненную заметку (в течение 10 минут)
- **Undo** — отмена последнего сохранения в течение 60 секунд (удаляет файл + ссылку из MOC)
- **MOC-интеграция** — каждая заметка автоматически добавляется в `MOC-{lifeArea}.md` как `[[wikilink]]`
- **Коллизии имен** — автоматический суффикс при совпадении имен файлов
- **Авторизация** — бот работает только для одного `AUTHORIZED_CHAT_ID`

---

## 🌐 Сферы жизни

| Сфера | Описание | Примеры тегов |
|---|---|---|
| `dance` | Танцы, хореография, перформансы | ecstatic-dance, contact-improv, choreography, workshop |
| `movement` | Телесные практики | thai-chi, somatic, bodywork, flow, practice |
| `philosophy` | Идеи, размышления, чтение | reflection, reading, stoicism, mindfulness, meditation |
| `travel` | Путешествия, места, логистика | city, place, experience, logistics, accommodation |
| `content` | Блог, Instagram, видео | blog, instagram, video-idea, post-idea, collaboration |
| `tech` | Разработка, инструменты | project, tool, automation, code, ai |
| `people` | Нетворкинг, сообщества | friend, collaborator, mentor, community |
| `health` | Здоровье, питание, спорт | nutrition, sport, wellbeing, routine, recovery |

---

## 💡 Примеры использования

### Текстовая заметка

```
Пользователь: Медитация перед танцем помогает лучше чувствовать тело и партнера

Бот: note | dance
     Title: Медитация перед танцем и чувствование
     [✓ meditation] [✓ ecstatic-dance] [○ practice]
     [+ Add tag] [Quick Save] [Save]
```

### Голосовое сообщение

```
Пользователь: 🎤 (голосовое сообщение)

Бот: Transcribing...
Бот: Transcribed: "Интересная мысль про связь стоицизма и движения..."
Бот: note | philosophy
     Title: Связь стоицизма и движения
     [✓ stoicism] [✓ movement] [+ Add tag] [Quick Save] [Save]
```

### Голосовая команда

Бот распознает команды в начале транскрипции:

```
Пользователь: 🎤 "Добавить заметку философия медитация помогает сосредоточиться"

→ entityType: note, lifeArea: philosophy
→ Текст для классификации: "медитация помогает сосредоточиться"
```

Поддерживаемые команды:
- `добавить/создать заметку [сфера] ...`
- `добавить/создать задачу [сфера] ...`
- `добавить/создать контакт [сфера] ...`
- `добавить/создать событие [сфера] ...`
- `добавить/создать ссылку [сфера] ...`

Сферы можно называть по-русски: *танцы, философия, путешествия, контент, технологии, здоровье, движение, люди*.

### Ссылка

```
Пользователь: https://youtube.com/watch?v=abc123 крутое видео про flow state

Бот: link | movement
     Title: Видео про flow state
     [✓ flow] [✓ video-idea] [+ Add tag] [Quick Save] [Save]
```

Бот автоматически получает заголовок через YouTube oEmbed API или `<title>` страницы.

### Batch-ссылки

```
Пользователь: Полезные ресурсы:
https://example.com/tool1
https://example.com/tool2
https://example.com/tool3

Бот: Saved 3 links:
     - 2026-04-26-tool1
     - 2026-04-26-tool2
     - 2026-04-26-tool3
```

### Контакт (автоматический)

```
Пользователь: Познакомился с Марией на ecstatic dance в Убуде, у нее инста @maria.moves

Бот: Contact saved: 2026-04-26-мария
```

AI извлекает: имя, контекст, платформы, город.

### Контакт (wizard)

```
Пользователь: /contact Maria Gonzalez

Бот: Contact: Maria Gonzalez
     Phone number? [Skip]

Пользователь: +34612345678

Бот: Contact: Maria Gonzalez
     Phone: +34612345678
     [TG = phone] [TG @] [Instagram] [WA = phone]

Пользователь: → нажимает Instagram

Бот: Instagram @username:

Пользователь: @maria.moves

Бот: Contact: Maria Gonzalez
     Phone: +34612345678
     instagram: @maria.moves
     [TG = phone] [TG @] [WA = phone] [Done >]

Пользователь: → нажимает Done >

Бот: Where/how met? (e.g. "Bali, ecstatic dance") [Skip]

Пользователь: Ubud, ecstatic dance workshop

Бот: Contact saved: 2026-04-26-maria-gonzalez
```

### Задача

```
Пользователь: Купить билеты в Лиссабон до пятницы, срочно

Бот: Saved: 2026-04-26-купить-билеты-в-лиссабон
     Type: task
```

Создается файл с Obsidian Tasks-совместимым форматом:

```markdown
---
type: task
tags: [travel, logistics]
life_area: travel
status: todo
created: 2026-04-26
---

- [ ] Купить билеты в Лиссабон до пятницы, срочно ⏫ 📅 2026-05-02
```

### Список задач

```
Пользователь: Список на сегодня: сходить в аптеку, написать пост, позвонить маме, купить продукты

Бот: Saved: 2026-04-26-список-на-сегодня
     Type: task_list (4 items)
```

```markdown
---
type: task_list
tags: [routine]
life_area: health
status: todo
created: 2026-04-26
---

- [ ] сходить в аптеку
- [ ] написать пост
- [ ] позвонить маме
- [ ] купить продукты
```

### Событие

```
Пользователь: Воркшоп по контактной импровизации 15 мая в Лиссабоне, ведет Maria Gonzalez

Бот: event | dance
     Title: Воркшоп контактной импровизации
     [✓ contact-improv] [✓ workshop] [+ Add tag] [Quick Save] [Save]
```

```markdown
---
type: event
event_name: Contact Improv Workshop
date: 2026-05-15
location: Lisbon
organizer: Maria Gonzalez
tags: [contact-improv, workshop]
life_area: dance
status: upcoming
created: 2026-04-26
---
```

### Пересланное сообщение

```
Пользователь: → пересылает сообщение из канала @dance_community

Бот: note | dance
     Title: ...
     [теги] [Quick Save] [Save]
```

В заметку добавляется атрибуция:

```markdown
---
type: note
source: Dance Community
source_type: channel
source_username: "@dance_community"
forward_date: 2026-04-25
---

> Forwarded from **Dance Community (@dance_community)**

Текст сообщения...
```

### Фото

```
Пользователь: 📷 (фото без подписи)
Бот: Photo saved: 2026-04-26-photo

Пользователь: 📷 + "Красивый закат в Убуде"
Бот: note | travel
     Title: Закат в Убуде
     [✓ place] [✓ experience] [+ Add tag] [Quick Save] [Save]
```

---

## ⌨️ Команды

| Команда | Описание |
|---|---|
| `/start` | Приветствие и описание возможностей |
| `/help` | Инструкция по использованию |
| `/contact Имя` | Запуск интерактивного wizard создания контакта |

---

## 🏗 Архитектура

```
src/
├── main.ts                          # Точка входа, NestJS bootstrap
├── app.module.ts                    # Корневой модуль
├── config/
│   └── configuration.ts             # Конфигурация из .env
├── ai/
│   ├── ai.module.ts
│   ├── ai.service.ts                # Классификация через OpenAI/Anthropic
│   ├── dto/
│   │   └── classification-result.dto.ts  # Типы результата классификации
│   └── prompts/
│       └── classify.prompt.ts       # Системный промпт для AI
├── telegram/
│   ├── telegram.module.ts
│   ├── guards/
│   │   └── auth.guard.ts            # Авторизация по CHAT_ID
│   ├── services/
│   │   ├── message-processor.service.ts  # Центральная логика обработки
│   │   └── voice.service.ts         # Транскрипция (Whisper + FFmpeg)
│   ├── updates/
│   │   ├── command.update.ts        # /start, /help, /contact
│   │   ├── text.update.ts           # Текстовые сообщения
│   │   ├── voice.update.ts          # Голосовые + аудио
│   │   ├── photo.update.ts          # Фото с/без подписи
│   │   └── action.update.ts         # Inline-кнопки (теги, save, undo, контакт-wizard)
│   └── utils/
│       └── voice-command.util.ts    # Парсинг голосовых команд
├── vault/
│   ├── vault.module.ts
│   ├── vault.service.ts             # Создание заметок по классификации
│   ├── vault-writer.service.ts      # Файловые операции, MOC, аттачменты
│   ├── templates/
│   │   ├── note.template.ts         # Шаблон заметки
│   │   ├── link.template.ts         # Шаблон ссылки
│   │   ├── task.template.ts         # Шаблон задачи (Obsidian Tasks)
│   │   ├── task-list.template.ts    # Шаблон списка задач
│   │   ├── contact.template.ts      # Шаблон контакта
│   │   ├── event.template.ts        # Шаблон события
│   │   └── photo-note.template.ts   # Шаблон фото-заметки
│   └── utils/
│       ├── slug.util.ts             # Генерация имен файлов (Unicode-safe)
│       └── url-detector.util.ts     # Извлечение URL, определение источника, получение заголовков
└── shared/
    ├── constants/
    │   ├── life-areas.constant.ts   # 8 сфер жизни
    │   └── tags.constant.ts         # Дефолтные теги по сферам
    └── interfaces/
        ├── session.interface.ts     # BotSession, PendingNote, PendingContact
        └── forward-metadata.interface.ts
```

### Поток обработки сообщения

```
Telegram Message
       │
       ▼
  AuthGuard (AUTHORIZED_CHAT_ID)
       │
       ▼
  Update Handler (text/voice/photo)
       │
       ├─ voice → VoiceService.transcribe() → FFmpeg → Whisper API → текст
       ├─ photo → скачивание → attachments/ → текст подписи (если есть)
       │
       ▼
  MessageProcessorService.processMessage()
       │
       ├─ extractUrls() → batch links? → создать по файлу на ссылку
       │
       ▼
  AiService.classify() ← контекст vault (теги + заголовки)
       │
       ├─ task/task_list → auto-save → vault
       ├─ contact → auto-save → contacts/
       │
       ▼
  showTagKeyboard() → пользователь выбирает теги
       │
       ▼
  ActionUpdate.onSave() → VaultService.createFromClassification()
       │
       ├─ template rendering (YAML frontmatter + Markdown body)
       ├─ VaultWriterService.writeFile() → inbox/{date}-{slug}.md
       └─ VaultWriterService.appendToMoc() → MOC-{lifeArea}.md
```

---

## 🗂 Структура Vault

```
vault/
├── inbox/                    # Все заметки, задачи, ссылки, события
│   ├── 2026-04-26-медитация-перед-танцем.md
│   ├── 2026-04-26-купить-билеты-в-лиссабон.md
│   └── ...
├── contacts/                 # Контакты
│   ├── 2026-04-26-maria-gonzalez.md
│   └── ...
├── attachments/              # Фото и файлы
│   ├── 2026-04-26-1714150800000.jpg
│   └── ...
├── MOC-dance.md              # Map of Content — танцы
├── MOC-philosophy.md         # Map of Content — философия
├── MOC-travel.md
├── MOC-movement.md
├── MOC-content.md
├── MOC-tech.md
├── MOC-people.md
└── MOC-health.md
```

---

## 🚀 Установка и запуск

### Предварительные требования

- Node.js 20+
- FFmpeg (для конвертации голосовых сообщений OGG → MP3)
- OpenAI API key (для Whisper и GPT) или Anthropic API key

### Локальный запуск

```bash
# 1. Клонировать репозиторий
git clone <repo-url>
cd nomad-brain

# 2. Установить зависимости
npm install

# 3. Создать .env файл
cp .env.example .env
```

Заполнить `.env`:

```env
# Telegram
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
AUTHORIZED_CHAT_ID=123456789

# Vault — путь к Obsidian vault на диске
VAULT_PATH=./vault

# AI Provider: openai | anthropic
AI_PROVIDER=openai

# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini

# Anthropic (альтернативный провайдер)
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20241022

# Транскрипция (OpenAI Whisper)
OPENAI_WHISPER_MODEL=whisper-1
```

```bash
# 4. Запустить в dev-режиме
npm run start:dev

# Или в production
npm run build
npm run start:prod
```

### Docker

```bash
# Собрать и запустить бота + CouchDB
docker compose up -d
```

`docker-compose.yml` включает:

- **nomad-brain** — бот (Node.js + FFmpeg)
- **couchdb** — база для LiveSync (Obsidian Sync)

Vault монтируется как volume `./vault:/vault`.

Для синхронизации с Obsidian на устройствах используйте плагин [Obsidian LiveSync](https://github.com/vrtmrz/obsidian-livesync) + CouchDB на порту `5984`.

---

## 🛠 Технологии

| Компонент | Технология | Назначение |
|---|---|---|
| Framework | [NestJS](https://nestjs.com/) 11 | Модульная архитектура, DI, guards |
| Telegram | [Telegraf](https://telegraf.js.org/) 4 + [nestjs-telegraf](https://github.com/bukhalo/nestjs-telegraf) | Обработка сообщений и inline-кнопок |
| AI Classification | [OpenAI](https://platform.openai.com/) GPT-4o-mini / Claude Haiku | Определение типа, тегов, сферы жизни |
| Transcription | OpenAI Whisper | Голос → текст (русский язык) |
| Audio | FFmpeg | Конвертация OGG (Telegram) → MP3 (Whisper) |
| Templates | [js-yaml](https://github.com/nodeca/js-yaml) | Генерация YAML frontmatter |
| Vault | Obsidian-совместимый Markdown | Local-first хранение заметок |
| Sync | CouchDB 3 + LiveSync plugin | Синхронизация vault между устройствами |
| TypeScript | TypeScript 5.7 | Типобезопасность |

---

## 📄 Лицензия

Private / UNLICENSED
