# Nomad Brain

Personal knowledge management + content generation system: Telegram bot + Obsidian + CouchDB + Qdrant.

## Architecture

```
Telegram Bot (NestJS) ←→ CouchDB ←→ LiveSync plugin ←→ Obsidian (Mac/iPhone)
                      ←→ Qdrant (vector embeddings for semantic search)
                      ←→ OpenAI API (classification, embeddings, polish, content generation)
```

- **CouchDB** is the **single source of truth** for all .md files
- **Qdrant** stores vector embeddings for semantic search (/ask, /generate)
- **Bot** reads and writes exclusively to CouchDB (no filesystem for notes)
- **Obsidian** syncs bidirectionally via Self-hosted LiveSync plugin
- **Attachments** (photos/audio) saved to CouchDB as base64 + filesystem backup
- Changes in Obsidian (edits, deletions, tag changes) are immediately visible to the bot
- No CouchDB backup needed — Obsidian on Mac is the backup

### LiveSync Document Format
- Metadata doc: `_id` = file path, `type: "plain"`, `children: [leafId]`, `ctime`, `mtime`, `size`, `eden: {}`
- Leaf doc: `_id` = `"h:" + SHA256(content).slice(0,40)`, `type: "leaf"`, `data` = content
- Content-addressable: identical content reuses same leaf (deduplication)

### Naming Conventions
- Filenames: no date prefix, slug only (`танец-как-способ-жизни.md`). Date in frontmatter `created:` field
- MOC files: lowercase `moc-dance.md` (not `MOC-dance.md`)

## Project Structure

```
nomad-brain/
├── src/
│   ├── ai/              # AI classification + text polish (OpenAI gpt-4o-mini)
│   ├── content/          # Content generation agent (Threads posts, future: reels)
│   │   └── prompts/      # Threads prompt templates (archetypes, voice samples, banned phrases)
│   ├── couchdb/          # CouchDB client (LiveSync format read/write)
│   ├── vector/           # Qdrant client + OpenAI embedding service
│   ├── config/           # App configuration
│   ├── shared/           # Interfaces, constants
│   ├── telegram/         # Bot updates, actions, services
│   │   ├── updates/      # Command, text, voice, photo, location, action handlers
│   │   ├── services/     # Message processor, voice transcription
│   │   └── guards/       # Auth guard (AUTHORIZED_CHAT_ID)
│   └── vault/            # VaultService, VaultWriterService, VaultReaderService, TemplateService
├── couchdb/local.ini     # CouchDB config (CORS, single node)
├── docker-compose.yml    # Bot + CouchDB + Qdrant containers
└── Dockerfile            # Multi-stage Node 20 Alpine + ffmpeg
```

## Key Decisions

- **CouchDB is the single source of truth** — bot reads AND writes only to CouchDB
- No filesystem for .md files — eliminates dual-write sync issues
- Attachments (audio/photos) stored on filesystem only (binary in CouchDB is expensive)
- No E2E encryption in LiveSync (bot needs to read/write plain text)
- OpenAI: gpt-4o-mini (classification/polish), gpt-4.1-mini (content generation), text-embedding-3-small (embeddings)
- Contact frontmatter (name, context, city_met) included in embeddings and AI context for /ask
- In-context learning for content generation (not fine-tuning)
- Multi-select life areas — note appears in all selected MOC files

## Server

- **VPS**: Hetzner, `89.167.64.252`, 3.7GB RAM, 2 CPU
- **SSH**: `ssh -i ~/.ssh/hetzner root@89.167.64.252`
- **Project path**: `/var/www/brain-notes/`
- **CouchDB URL**: `https://vault.ddinisiuc.com` (nginx reverse proxy → localhost:5984)
- **CouchDB DB**: `obsidianlivesync`
- **SSL**: Let's Encrypt, auto-renew
- **Docker services**: nomad-brain (bot), couchdb, qdrant

## Dev Workflow

- **ALWAYS** run via Docker: `docker compose up --build -d`
- **NEVER** run locally with `npx nest start` (ffmpeg not available on host)
- **NEVER** run bot locally and on server simultaneously (same Telegram token = conflict)
- **GitHub repo**: `git@github.com:flaming-flow/brain-notes.git`

### Deploy Flow

```bash
# 1. Compile check locally
cd nomad-brain && npx tsc --noEmit

# 2. Commit and push
git add -A && git commit -m "short descriptive message" && git push

# 3. Deploy on server
ssh -i ~/.ssh/hetzner root@89.167.64.252 "cd /var/www/brain-notes && git pull && docker compose up --build -d"
```

### Commit Style
- Short, informative messages
- No co-authored-by tags
- Examples: `"add search and geolocation"`, `"fix voice transcription crash"`

## Environment Variables

See `.env.example`. Key vars:
- `TELEGRAM_BOT_TOKEN`, `AUTHORIZED_CHAT_ID` — Telegram auth
- `COUCHDB_URL`, `COUCHDB_USER`, `COUCHDB_PASSWORD`, `COUCHDB_DB_NAME` — CouchDB
- `QDRANT_URL`, `QDRANT_COLLECTION` — Qdrant vector DB
- `AI_PROVIDER`, `OPENAI_API_KEY` — AI (classification, embeddings, polish, content)
- `VAULT_PATH` — filesystem path for attachments only

## Entity Types

Note, Task, Task List, Contact, Event, Link, Music, Project

## Bot Commands & UI

### Commands
- `/start` — welcome + persistent keyboard
- `/contact [Name]` — interactive contact creation wizard
- `/contacts` — list contacts with pagination
- `/search keyword` — text search across notes
- `/ask question` — AI answers from your notes (semantic search via Qdrant)
- `/generate threads [topic]` — generate Threads post (empty = AI picks topic from notes)
- `/reindex` — reindex all notes in Qdrant for AI search
- `/project Description` — create project note
- `/music [Description]` — create music note or recording mode
- `/help` — usage guide

### Persistent Keyboard
```
[ + Contact ] [ Contacts ] [ Music ]
[    Event   ] [   Idea   ]
[       Send Location       ]
```

### Note Flow
1. Send message → AI classifies → shows area + tag keyboard (multi-select areas)
2. **Quick Save** — save with AI-suggested tags instantly
3. **Save** — save with manually selected tags/areas
4. **Cancel** — discard without saving (nothing written to DB)

### Voice Flow
1. Send voice → "Got it, processing..." (non-blocking background transcription)
2. **OK** — proceed to classification
3. **Polish** — AI cleans up filler words, grammar
4. **Edit** — manual text correction
5. Reply to "Saved:" with voice → transcribe → Append/Replace

### Music Flow
1. Press **Music** → send audio (NO Whisper transcription on music)
2. "Give it a title?" → type title or **Skip** (auto-names: track-1, track-2...)
3. "Add a description?" → type or **Skip**
4. Tag selection → Save

### Edit via Reply
- Reply to any "Saved: filename" message with text or voice
- Bot finds the note by filename, offers Append/Replace/Cancel
- No fallback to last note — shows "Note not found" if can't match

### Content Generation Flow
1. `/generate threads` → AI suggests 5 topics as buttons (from all notes)
2. `/generate threads [topic]` → semantic search → 5 relevant notes → generate post
3. Shows source notes used ("Based on: ...")
4. After generation:
   - **Regenerate** — send feedback what to change, or "ok" to regenerate fresh
   - **Save as draft** — saves to `drafts/` in CouchDB
   - **Save as example** — saves post as voice sample for style learning

### Voice Samples (Style Learning)
- Best posts saved via "Save as example" → stored in `voice-samples/` in CouchDB
- Up to 5 latest samples auto-injected into generation prompt as voice reference
- More examples = better style matching over time

### Content Prompt Design (`src/content/prompts/threads.prompt.ts`)
- Russian language only, under 500 characters
- First line = hook (surprising, specific, < 15 words)
- Banned phrases: "в современном мире", "раскрыть потенциал", "трансформировать", corporate/coach tone
- Topic tags (not hashtags): one per post in parentheses, natural language with spaces
- Context: 8 semantically similar notes × 800 chars each

## Future Roadmap

- Meta Graph API integration (Threads/Instagram analytics, engagement feedback)
- Reel script generation from notes
- Music mood analysis → match music to reel content
- Content calendar with posting recommendations
- Style learning from published posts (in-context, then fine-tuning)
- Multi-user support (each user = own CouchDB database)
- Possible monetization: wrapper product or full custom app
